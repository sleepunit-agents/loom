/** Trusted next-mode composition. Runtime handoff remains an injected role. */
import { randomUUID } from 'node:crypto';
import type { Foundation } from '../../core/app.js';
import type { OutsideEffects } from '../../core/effects.js';
import type { SecretUse } from '../secrets/role.js';
import type { DiscordDrainOptions } from './discord-drain.js';
import { discordDrain } from './discord-drain.js';
import { discordInbox } from './discord-inbox.js';
import { discordApi } from './discord-api.js';
import { discordGateway, type DiscordGatewayOptions } from './discord-gateway.js';
import { all, setupRevision } from './store.js';
import type { Venue } from './model.js';
export interface DiscordDaemonOptions {
  secrets: SecretUse;
  /** Public holder generation, changed whenever a credential is replaced. */
  credentialEpoch(): string;
  receive: DiscordDrainOptions['receive'];
  request?: typeof fetch;
  socket?: DiscordGatewayOptions['socket'];
}
interface Session { stop(): void; close(): Promise<void>; flush(): Promise<void> }
/** All callbacks are trusted in-process roles, never operation input. No grants
 * are created here. Start is asynchronous and unavailable credentials retry. */
export function installDiscordDaemon(app: Foundation, effects: OutsideEffects, options: DiscordDaemonOptions) {
  const clock = app.operations.clock;
  let closed = false, generation = 0, running: Promise<void> | undefined, again = false;
  let cancel: (() => void) | undefined;
  let signature: string | undefined;
  const sessions = new Map<string, Session>();
  const attempts = new Map<string, {id:string;kind:'bridge-send';title:string}>();
  // Live notifications invalidate synchronously, before any outstanding await resumes.
  function invalidate() {
    generation++; signature = undefined;
    for (const session of sessions.values()) session.stop();
    void sync();
  }
  function key() { return JSON.stringify([setupRevision(app.db), options.credentialEpoch()]); }
  function schedule() {
    if (closed || cancel) return;
    cancel = clock.at(clock.now() + 5000, () => {
      cancel = undefined;
      try {
        // Detection must run even while serialized metadata/handoff IO is pending.
        if (signature !== undefined && key() !== signature) invalidate();
        else void sync();
      } catch { invalidate(); }
      schedule();
    });
  }
  async function retire() {
    const old = [...sessions.values()]; sessions.clear();
    old.forEach(s => s.stop()); await Promise.all(old.map(s => s.close()));
  }
  async function pass() {
    if (closed) return;
    if (app.db.inTransaction) { schedule(); return; }
    const next = key();
    if (signature !== next) {
      generation++; await retire();
      for (const attempt of attempts.values()) effects.finish(attempt.id);
      attempts.clear();
      if (closed) return;
      signature = key();
    }
    const epoch = generation, saved = signature;
    const current = () => !closed && generation === epoch && key() === saved;
    for (const venue of all(app.db, 'venues').filter(v => v.enabled && v.platform === 'discord')) {
      if (!current()) { invalidate(); return; }
      if (sessions.has(venue.id)) { await sessions.get(venue.id)!.flush(); continue; }
      let effect = attempts.get(venue.id);
      if (!effect) { effect={id:`bridges:discord:${randomUUID()}`,kind:'bridge-send',title:'Connect Discord bridge'}; attempts.set(venue.id,effect); }
      const lease=effect;
      // A released connection permits its own reads and reconnects for this lifetime.
      // On restart a new lifetime is held again; no released lease is inherited.
      const permitted = () => current() && (effects.status(lease.id) === 'started' || effects.beforeOutside(lease));
      const secrets: SecretUse = {
        withValue(name,use) {
          if (!permitted()) return Promise.reject(Error('Discord lifetime ended'));
          return options.secrets.withValue(name,token=> {
            // Holder acquisition is asynchronous: authorization can end meanwhile.
            if (!permitted()) throw Error('Discord lifetime ended');
            return use(token);
          });
        },
      };
      const api = discordApi(secrets, permitted, options.request);
      const auth = await api.authenticate(venue);
      if (!current()) { effects.finish(effect.id); return; }
      if (auth === 'wait') continue; // Transient failure does not end this released lifetime.
      let stopped = false;
      const valid = () => !stopped && current();
      const binding = {venue,credentialEpoch:options.credentialEpoch()};
      const inbox = discordInbox(app.db, clock, binding, options.credentialEpoch);
      const drain = discordDrain({db:app.db,clock,binding,channel:api.channel,
        currentEpoch:options.credentialEpoch,receive:options.receive,current:valid,beforeRead:()=>valid() && permitted()});
      const socket = discordGateway({bot:venue.bot,tokenSecret:venue.tokenSecret,secrets,clock,
        beforeConnect:()=>valid() && permitted(),socket:options.socket,
        load() { if (!valid()) throw Error('Discord binding ended'); return inbox.load(); },
        async reset() { if (!valid()) throw Error('Discord binding ended'); await inbox.reset(); },
        async commit(event,checkpoint) {
          if (!valid()) throw Error('Discord binding ended');
          await inbox.commit(event,checkpoint);
          // Gateway progress follows the raw commit, never metadata or handoff IO.
          void drain.flush();
        }});
      let closing: Promise<void> | undefined;
      const session: Session = {
        stop() { if (!stopped) { stopped=true; socket.close(); } },
        close() { session.stop(); return closing ??= Promise.all([socket.close(),drain.close()]).then(()=>{}).finally(()=>effects.finish(effect.id)); },
        flush:()=>drain.flush(),
      };
      sessions.set(venue.id,session);
      await drain.flush(); // Recover durable receipts even if Discord sends nothing new.
    }
    schedule(); // Also observes holder generation changes without a live notification.
  }
  function sync(): Promise<void> {
    if (closed) return Promise.resolve();
    if (running) { again=true; return running; }
    running=(async()=>{ do { again=false; try { await pass(); } catch { schedule(); } } while(again && !closed); })()
      .finally(()=>{running=undefined;});
    return running;
  }
  const unobserve=app.live.observe(changes=>{
    if (closed) return;
    if (changes.some(c=>['secret.name','secret.grant','secret.policy','core.access'].includes(c.type))
      || (changes.some(c=>c.type.startsWith('bridges.')) && key() !== signature)) invalidate();
  });
  const unrelease=effects.onReleased(id=>{if(id.startsWith('bridges:discord:')) void sync();});
  schedule(); void sync();
  let closing: Promise<void> | undefined;
  return { sync, close(): Promise<void> {
    if (closing) return closing;
    closed=true;generation++;cancel?.();unobserve();unrelease();
    for(const session of sessions.values()) session.stop();
    return closing=(async()=>{await running;await retire();})();
  }};
}
