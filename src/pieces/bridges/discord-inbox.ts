/** Private Gateway commit target. No metadata IO, runtime admission or records. */
import { createHash } from 'node:crypto';
import type { Clock, Db } from '../../core/index.js';
import type { Venue } from './model.js';
import type { DiscordCheckpoint, DiscordDispatch } from './discord-gateway.js';
import { setupRevision, venueById } from './store.js';

export class DiscordBindingChanged extends Error {
  constructor() { super('Discord binding changed'); }
}
export interface DiscordBinding {
  venue: Venue;
  /** Opaque public holder generation, never the credential itself. */
  credentialEpoch: string;
}
export interface DiscordReceipt { id: string; messageId: string; event: Record<string, unknown>; received: number }
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const snowflake = (x: unknown): x is string => typeof x === 'string' && /^[1-9]\d{0,19}$/.test(x) && BigInt(x) <= 18446744073709551615n;
const sequence = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
function checkpoint(value: DiscordCheckpoint) {
  if (!value || typeof value.session !== 'string' || !/^[\w-]{1,256}$/.test(value.session)
    || !sequence(value.seq) || typeof value.url !== 'string'
    || !/^wss:\/\/gateway(?:-[a-z0-9-]+)?\.discord\.gg\/\?v=10&encoding=json$/.test(value.url)) throw Error('Invalid Discord checkpoint');
  return {session:value.session,url:value.url,seq:value.seq};
}
/** Recreate after setup or holder generation changes. currentEpoch is a trusted
 * synchronous role, checked for every read/write, including restored setup. */
export function discordInbox(db: Db, clock: Clock, input: DiscordBinding, currentEpoch: () => string) {
  const binding = structuredClone(input), venue = binding.venue;
  if (venue.platform !== 'discord' || !snowflake(venue.bot) || !snowflake(venue.workspace)
    || typeof binding.credentialEpoch !== 'string' || !binding.credentialEpoch.length || binding.credentialEpoch.length > 1024) throw Error('Invalid Discord binding');
  // Hash the identity so neither setup nor holder generation need be repeated in rows.
  const key = createHash('sha256').update(JSON.stringify([venue.id,venue.platform,venue.workspace,venue.agent,venue.bot,venue.tokenSecret,binding.credentialEpoch])).digest('hex');
  const revision = setupRevision(db);
  function current() {
    if (db.inTransaction) throw Error('Discord receipt requires its own transaction');
    if (currentEpoch() !== binding.credentialEpoch || setupRevision(db) !== revision || !venue.enabled
      || JSON.stringify(venueById(db,venue.id)) !== JSON.stringify(venue)) throw new DiscordBindingChanged();
  }
  function load(): DiscordCheckpoint | undefined {
    current();
    const row = db.prepare('SELECT checkpoint FROM bridges_discord_sessions WHERE binding=?').get(key) as {checkpoint:string} | undefined;
    return row ? checkpoint(JSON.parse(row.checkpoint)) : undefined;
  }
  return {
    load,
    async commit(event: DiscordDispatch, next: DiscordCheckpoint): Promise<void> {
      current();
      const saved = checkpoint(next);
      if (!event || !sequence(event.seq) || event.seq !== saved.seq || typeof event.type !== 'string' || !/^[A-Z_]{1,80}$/.test(event.type)) throw Error('Invalid Discord dispatch');
      const prior = load();
      if (prior && (prior.session !== saved.session || prior.url !== saved.url || saved.seq <= prior.seq)) throw Error('Obsolete Discord checkpoint');
      if (!prior && event.type !== 'READY') throw Error('Discord session requires READY');
      if (event.type === 'READY' && (!object(event.data) || !object(event.data.user) || event.data.user.id !== venue.bot
        || event.data.session_id !== saved.session)) throw Error('Invalid Discord READY');
      // Only message words are needed by intake. READY session data and unrelated
      // event payloads are never copied into raw receipts.
      const raw = event.type === 'MESSAGE_CREATE' && object(event.data) && snowflake(event.data.id) ? event.data : undefined;
      const words = raw ? JSON.stringify(raw) : undefined;
      if (words && Buffer.byteLength(words) > 1024*1024) throw Error('Discord receipt too large');
      db.transaction(() => {
        if (raw) {
          const id = createHash('sha256').update(JSON.stringify([key,raw.id])).digest('hex');
          db.prepare(`INSERT OR IGNORE INTO bridges_discord_receipts
            (id,venue,binding,message_id,event,state,received) VALUES (?,?,?,?,?,'pending',?)`)
            .run(id,venue.id,key,raw.id,words,clock.now());
        }
        db.prepare(`INSERT INTO bridges_discord_sessions(binding,checkpoint) VALUES (?,?)
          ON CONFLICT(binding) DO UPDATE SET checkpoint=excluded.checkpoint`).run(key,JSON.stringify(saved));
      })();
    },
    async reset(): Promise<void> {
      current();
      db.transaction(() => { db.prepare('DELETE FROM bridges_discord_sessions WHERE binding=?').run(key); })();
    },
    pending(limit = 32, after?: Pick<DiscordReceipt,'received'|'id'>): DiscordReceipt[] {
      current();
      if (!Number.isInteger(limit) || limit < 1 || limit > 64) throw Error('Invalid Discord receipt limit');
      if (after && (!Number.isSafeInteger(after.received) || !/^[a-f0-9]{64}$/.test(after.id))) throw Error('Invalid Discord receipt cursor');
      const rows = db.prepare(`SELECT id,message_id,event,received FROM bridges_discord_receipts
        WHERE venue=? AND binding=? AND state='pending'
        ${after ? 'AND (received > ? OR (received = ? AND id > ?))' : ''}
        ORDER BY received,id LIMIT ?`).all(venue.id,key,...(after ? [after.received,after.received,after.id] : []),limit) as {id:string;message_id:string;event:string;received:number}[];
      return rows.map(row => ({id:row.id,messageId:row.message_id,event:JSON.parse(row.event),received:row.received}));
    },
    /** Erase words only after normalized receipt commits or definite discard.
     * Keep message-id tombstones across cursor reset and process restart. */
    consume(id: string): void {
      current();
      if (!db.prepare(`UPDATE bridges_discord_receipts SET event=NULL,state='consumed'
        WHERE id=? AND venue=? AND binding=?`).run(id,venue.id,key).changes) throw Error('Unknown Discord receipt');
    },
  };
}
