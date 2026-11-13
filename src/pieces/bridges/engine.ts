import { createHash } from 'node:crypto';
import type { Foundation } from '../../core/app.js';
import type { OutsideEffects } from '../../core/effects.js';
import type { Clock, Context } from '../../core/index.js';
import type { Address, Message, Route, Venue } from './model.js';
import { keyFor, conversationKind } from './model.js';
import { eventTime } from './time.js';
import { addressed, isStop } from './routing.js';
import { all, venueById, routeFor, personFor, setupRevision } from './store.js';
import type { BridgeRuntime, BridgesRole, VenueAdapter, VenueConnection } from './role.js';
const hash = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
interface Inbox { id: string; venue: string; identity: string; message: string; state: 'pending'|'held'|'dropped'|'delivered'; retry_since: number | null }
interface Outbox { id: string; venue: string; identity: string; address: string; text: string; state: 'pending'|'held'|'sending'|'sent'|'uncertain'|'dismissed' }
const identity = (v: Venue) => JSON.stringify([v.platform,v.workspace,v.agent,v.bot]);
interface ConnectionState { signature: string; connection?: VenueConnection; cancel?: () => void; failures: number; generation: number }
/** Daemon-owned connections and durable IO queues. No body or subprocess runs here. */
export class Bridges implements BridgesRole {
  private closed = false;
  private connections = new Map<string, ConnectionState>();
  private unsubscribeRelease: () => void;
  private cancelRetry?: () => void;
  private draining?: Promise<void>;
  private again = false;
  constructor(private app: Foundation, private clock: Clock, private runtime: BridgeRuntime,
    private adapters: VenueAdapter[], private effects: OutsideEffects) {
    this.unsubscribeRelease = effects.onReleased(id => { if (id.startsWith('bridges:')) void this.flush(); });
    // A fixed runtime/adapter may accept a previously malformed delivery after restart.
    // Administrative and identity holds stay held; ordinary drains never retry a hold.
    app.db.prepare("UPDATE bridges_inbox SET state='pending',reason=NULL,retry_since=NULL WHERE state='held' AND reason='runtime delivery held'").run();
    // A crash can happen after the venue accepted a send but before we recorded its receipt.
    app.db.prepare("UPDATE bridges_outbox SET state='uncertain' WHERE state='sending'").run();
  }
  private changed(type: string, id: string) { this.app.live.changed([{type, id}]); }
  private status(id: string, state: string) {
    this.app.db.prepare('INSERT INTO bridges_status VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,changed=excluded.changed').run(id,state,this.clock.now());
    this.changed('bridges.venue',id);
  }
  /** Called after committed setup changes and once at startup. */
  async sync(): Promise<void> {
    if (this.closed) return;
    const venues = all(this.app.db,'venues').filter(v => v.enabled);
    for (const [id,c] of this.connections) if (!venues.some(v => v.id === id && JSON.stringify(v) === c.signature)) {
      c.cancel?.(); c.connection?.close(); this.connections.delete(id); this.status(id,'disconnected');
    }
    await Promise.all(venues.map(async v => {
      if (this.connections.has(v.id)) return;
      const c = {signature: JSON.stringify(v), failures: 0, generation: 0};
      this.connections.set(v.id,c); await this.connect(v,c);
    }));
    await this.flush();
  }
  private async connect(v: Venue, c: ConnectionState) {
    if (this.closed || this.connections.get(v.id) !== c) return;
    const generation = ++c.generation;
    this.status(v.id,'connecting');
    const dropped = () => {
      if (this.closed || this.connections.get(v.id) !== c || generation !== c.generation) return;
      c.generation++; c.connection?.close(); c.connection = undefined;
      this.status(v.id,'backoff');
      const delay = Math.min(60_000, 1000 * 2 ** Math.min(c.failures++,6));
      c.cancel = this.clock.at(this.clock.now()+delay, () => { c.cancel=undefined; void this.connect(v,c); });
    };
    try {
      const adapter = this.adapters.find(a => a.platform === v.platform);
      if (!adapter) throw new Error('Adapter unavailable');
      const connection = await adapter.connect(v,{
        message: async message => { if (!this.closed && this.connections.get(v.id) === c && c.generation === generation) await this.receive(v.id,message,v); }, dropped,
      });
      if (this.closed || this.connections.get(v.id) !== c || generation !== c.generation) { connection.close(); return; }
      c.connection = connection; c.failures=0; this.status(v.id,'connected');
    } catch { dropped(); } // Never persist/log an upstream exception: it may contain a credential.
  }
  async receive(venueId: string, message: Message, receivedAs?: Venue): Promise<void> {
    if (this.closed) throw new Error('Bridges closed');
    const v = receivedAs ?? venueById(this.app.db,venueId);
    if (!v) throw new Error('Unknown venue');
    message = {...message,...conversationKind(v,message)};
    const id = hash([v.platform,v.workspace,message.channel,message.id,v.agent]);
    this.app.db.prepare("INSERT OR IGNORE INTO bridges_inbox (id,venue,identity,message,state,reason,received,delivered) VALUES (?,?,?,?,'pending',NULL,?,NULL)").run(id,v.id,identity(v),JSON.stringify(message),this.clock.now());
    this.changed('bridges.venue',v.id);
    // Receipt is durable before the gateway ACK. Delivery can fail independently.
    void this.flush();
  }
  reply(input: {id: string; incomingId: string; text: string}, context?: Pick<Context,'changed'>) {
    const db = this.app.db;
    if (db.inTransaction && !context) throw new Error('Transactional replies require the operation context');
    if (!input.id || input.id.length > 200 || !input.text.trim()) throw new Error('Invalid reply');
    const old = db.prepare('SELECT incoming,text FROM bridges_outbox WHERE id=?').get(input.id) as {incoming:string;text:string} | undefined;
    if (old) { if (old.incoming !== input.incomingId || old.text !== input.text) throw new Error('Reply id reused'); return; }
    const incoming = db.prepare("SELECT * FROM bridges_inbox WHERE id=? AND state='delivered'").get(input.incomingId) as Inbox | undefined;
    if (!incoming) throw new Error('No delivered message for reply');
    const raw = JSON.parse(incoming.message) as Message;
    const v = venueById(db,incoming.venue);
    const m = v ? {...raw,...conversationKind(v,raw)} : raw;
    const address: Address = {channel:m.channel, thread:m.thread, dm:m.dm, group:m.group};
    db.prepare("INSERT INTO bridges_outbox VALUES (?,?,?,?,?,?,'pending',NULL,?)").run(input.id,input.incomingId,incoming.venue,incoming.identity,JSON.stringify(address),input.text,this.clock.now());
    if (context) context.changed('bridges.send',input.id); else this.changed('bridges.send',input.id);
    // If invoked within runtime's transaction, defer IO until that transaction has committed.
    this.clock.at(this.clock.now(), () => { if (!this.closed) void this.flush(); });
  }
  async flush(): Promise<void> {
    if (this.closed) return;
    if (this.draining) { this.again=true; return this.draining; }
    this.draining = (async () => { do { this.again=false; await this.drain(); } while (this.again && !this.closed); })().finally(() => { this.draining=undefined; if(this.again && !this.closed) void this.flush(); });
    return this.draining;
  }
  private retry() {
    if (this.cancelRetry || this.closed) return;
    this.cancelRetry = this.clock.at(this.clock.now()+5000, () => { this.cancelRetry=undefined; void this.flush(); });
  }
  private setupUnchanged(v: Venue, message: Message | undefined, route: Route | undefined, revision: string) {
    const current = venueById(this.app.db,v.id);
    return !this.closed && current?.enabled && setupRevision(this.app.db) === revision
      && JSON.stringify(current) === JSON.stringify(v)
      && (!message || JSON.stringify(routeFor(this.app.db,current,message.channel,message.parent)) === JSON.stringify(route));
  }
  /** No admission cache: a reply may run long after the original receipt. */
  private async admit(v: Venue, message: Message, route: Route | undefined, adapter: VenueAdapter, person: string) {
    const inspected = await adapter.inspect(v,message);
    if (inspected === 'drop' || inspected === 'wait') return inspected;
    let people = [person];
    if (v.platform === 'slack' && message.group) {
      if (typeof inspected !== 'object' || inspected?.kind !== 'allow' || !Array.isArray(inspected.members)) return 'drop';
      const members = inspected.members;
      if (members.some(id => typeof id !== 'string' || !id) || new Set(members).size !== members.length
        || !members.includes(v.bot) || !members.includes(message.user)) return 'drop';
      const humans = members.filter(id => id !== v.bot);
      const resolved = humans.map(id => personFor(this.app.db,v,id));
      if (humans.length < 2 || resolved.some(p => !p) || new Set(resolved).size !== resolved.length) return 'drop';
      people = resolved as string[];
    } else if (inspected !== 'allow' && (typeof inspected !== 'object' || inspected?.kind !== 'allow')) return 'drop';
    const key = keyFor(v,message,person);
    for (const member of people) {
      const admitted = await this.runtime.admit({agent:v.agent,person:member,venue:key.venue,
        channel:message.parent ?? message.channel,dm:message.dm,group:message.group,
        readers:route?.readers ?? [],peer:!!message.bot});
      if (admitted !== 'allow') return admitted === 'wait' ? 'wait' : 'drop';
    }
    return 'allow';
  }
  private expireIntake(id: string, since: number | null): boolean {
    // Like the old waiting queue: exactly one hour is still eligible.
    if (since === null || this.clock.now()-since <= 3_600_000) return false;
    const row = this.app.db.prepare(`UPDATE bridges_inbox
      SET state='dropped',reason='transient intake expired',message='{}',retry_since=NULL
      WHERE id=? AND state='pending' RETURNING venue`).get(id) as {venue:string} | undefined;
    if (row) this.changed('bridges.venue',row.venue);
    return true;
  }
  private waitIntake(row: Inbox) {
    // A duplicate receipt, another failed check or a restart never renews the hour.
    const since = row.retry_since ?? this.clock.now();
    const updated = this.app.db.prepare("UPDATE bridges_inbox SET retry_since=COALESCE(retry_since,?) WHERE id=? AND state='pending'").run(since,row.id);
    if (updated.changes && !this.expireIntake(row.id,since)) this.retry();
  }
  private async drain() {
    const db = this.app.db;
    for (const row of db.prepare("SELECT * FROM bridges_inbox WHERE state='pending' ORDER BY received,id").all() as Inbox[]) {
      if (this.closed) return;
      if (this.expireIntake(row.id,row.retry_since)) continue;
      const v = venueById(db,row.venue), raw = JSON.parse(row.message) as Message;
      const message = v ? {...raw,...conversationKind(v,raw)} : raw;
      let state = 'dropped', reason: string | null = null;
      try {
        if (!v || identity(v)!==row.identity) { state='held'; reason='venue identity changed'; }
        else {
          const route = routeFor(db,v,message.channel,message.parent);
          const person = personFor(db,v,message.user);
          if (!person) reason='unknown user';
          else if (addressed(v,message,route,all(db,'venues'))) {
            const at = eventTime(v.platform,message.id,message.at);
            if (!at) { state='held'; reason='invalid event time'; }
            else {
              const adapter = this.adapters.find(a => a.platform === v.platform);
              if (!adapter) throw new Error('Adapter unavailable');
              const revision = setupRevision(db);
              const admitted = await this.admit(v,message,route,adapter,person);
              const key = keyFor(v,message,person);
              if (!this.setupUnchanged(v,message,route,revision)) { this.waitIntake(row); continue; }
              if (admitted === 'wait') { this.waitIntake(row); continue; }
              if (admitted === 'allow') {
                if (!message.bot && isStop(message.text)) {
                  await this.runtime.stop({agent:v.agent,venue:key.venue,person,id:row.id});
                  state='delivered';
                } else {
                  const outcome = await this.runtime.deliver({id:row.id,key,person,text:message.text,at,label:message.label,address:{channel:message.channel,thread:message.thread,dm:message.dm,group:message.group},route});
                  if (outcome === 'retry') { this.waitIntake(row); continue; }
                  if (outcome === 'refused') { state='dropped'; reason='runtime refused'; }
                  else if (outcome !== 'delivered') { state='held'; reason='runtime delivery held'; }
                  else {
                    db.prepare('INSERT OR IGNORE INTO bridges_conversations VALUES (?,?)').run(hash([key.agent,key.who,key.venue]),JSON.stringify(key));
                    state='delivered';
                  }
                }
              } else reason='not admitted';
            }
          } else reason='not addressed';
        }
      } catch { this.waitIntake(row); continue; }
      db.prepare("UPDATE bridges_inbox SET state=?,reason=?,delivered=?,retry_since=NULL WHERE id=? AND state='pending'").run(state,reason,state==='delivered' ? this.clock.now():null,row.id);
      // A denied/unknown sender's words have no further purpose.
      if (state==='dropped') db.prepare("UPDATE bridges_inbox SET message='{}' WHERE id=?").run(row.id);
      this.changed('bridges.venue',row.venue);
    }
    for (const row of db.prepare("SELECT * FROM bridges_outbox WHERE state='pending' ORDER BY created,id").all() as Outbox[]) {
      if (this.closed) return;
      // Earlier posts can await while an owner holds and dismisses a later snapshot row.
      const pending = () => (db.prepare('SELECT state FROM bridges_outbox WHERE id=?').get(row.id) as {state:string} | undefined)?.state === 'pending';
      if (!pending()) continue;
      const v = venueById(db,row.venue);
      if (!v?.enabled || identity(v)!==row.identity) { db.prepare("UPDATE bridges_outbox SET state='held' WHERE id=? AND state='pending'").run(row.id); this.changed('bridges.send',row.id); continue; }
      const adapter = this.adapters.find(a => a.platform === v.platform);
      if (!adapter) { this.retry(); continue; }
      const revision = setupRevision(db);
      const original = db.prepare('SELECT message FROM bridges_inbox WHERE id=(SELECT incoming FROM bridges_outbox WHERE id=?)').get(row.id) as {message:string} | undefined;
      const raw = original ? JSON.parse(original.message) as Message : undefined;
      const message = raw ? {...raw,...conversationKind(v,raw)} : undefined;
      const route = message ? routeFor(db,v,message.channel,message.parent) : undefined;
      if (message) {
        let admitted: 'allow'|'drop'|'wait';
        try { admitted = await this.admit(v,message,route,adapter,personFor(db,v,message.user) ?? ''); } catch { this.retry(); continue; }
        if (!this.setupUnchanged(v,message,route,revision)) { this.retry(); continue; }
        if (admitted === 'wait') { this.retry(); continue; }
        if (admitted !== 'allow') {
          db.prepare("UPDATE bridges_outbox SET state='held' WHERE id=? AND state='pending'").run(row.id);
          this.changed('bridges.send',row.id); continue;
        }
      }
      if (!this.setupUnchanged(v,message,route,revision)) { this.retry(); continue; }
      // The effect id is permanent; releasing a staging item allows exactly one attempt.
      if (!pending()) continue;
      if (!this.effects.beforeOutside({id:`bridges:${row.id}`,kind:'bridge-send',title:`Bridge reply via ${v.id}`})) continue;
      if (!db.prepare("UPDATE bridges_outbox SET state='sending' WHERE id=? AND state='pending'").run(row.id).changes) continue;
      try {
        const address = JSON.parse(row.address) as Address;
        const result = await adapter.send(v,{...address,...conversationKind(v,address)},row.text,row.id,async()=>{
          if (!message || !this.setupUnchanged(v,message,route,revision)) return false;
          const admitted=await this.admit(v,message,route,adapter,personFor(db,v,message.user) ?? '');
          return admitted === 'allow' && !!this.setupUnchanged(v,message,route,revision);
        });
        db.prepare("UPDATE bridges_outbox SET state='sent',remote_id=? WHERE id=?").run(result.id,row.id);
        this.effects.finish(`bridges:${row.id}`);
      } catch {
        // A timeout, bad response or disconnect can mean the post succeeded. Never retry it.
        db.prepare("UPDATE bridges_outbox SET state='uncertain' WHERE id=?").run(row.id);
        this.effects.finish(`bridges:${row.id}`,false);
      }
      this.changed('bridges.send',row.id); this.changed('bridges.venue',row.venue);
    }
  }
  async close() {
    this.closed=true; this.cancelRetry?.(); this.unsubscribeRelease();
    for (const c of this.connections.values()) { c.cancel?.(); c.connection?.close(); }
    this.connections.clear();
    await this.draining;
  }
}
