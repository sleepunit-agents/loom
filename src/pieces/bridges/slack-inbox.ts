/** Private daemon store: Socket Mode commits here BEFORE metadata IO or ACK.
 * No operation, live projection or credential lookup exposes these event words.
 */
import { createHash } from 'node:crypto';
import type { Clock, Db } from '../../core/index.js';
import type { Venue } from './model.js';
import { setupRevision, venueById } from './store.js';

export interface SlackBinding {
  venue: Venue;
  /** Verified app id from authenticated composition, never from the event itself. */
  app: string;
}
export interface SlackReceipt { id: string; eventId: string; event: Record<string, unknown>; received: number }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const signature = ({ venue: v, app }: SlackBinding) => JSON.stringify([v.id, v.platform, v.workspace, v.agent, v.bot, app]);

/** One bound receiving bot. Recreate after setup changes. This is not admission.
 * Composition still supplies a current authenticated app binding, normalizes
 * pending events, and installs sockets; the store starts no IO by itself.
 */
export function slackInbox(db: Db, clock: Clock, input: SlackBinding) {
  // Snapshot caller-owned objects; a later mutation must not retarget old work.
  const binding: SlackBinding = { venue: structuredClone(input.venue), app: input.app };
  if (binding.venue.platform !== 'slack' || !identifier(binding.app) || !identifier(binding.venue.workspace))
    throw Error('Invalid Slack binding');
  const key = signature(binding), revision = setupRevision(db);
  function current() {
    const venue = venueById(db, binding.venue.id);
    if (setupRevision(db) !== revision || !venue?.enabled || JSON.stringify(venue) !== JSON.stringify(binding.venue)) throw Error('Slack binding changed');
  }
  function outsideTransaction() {
    // Resolving inside somebody else's transaction could ACK a later rollback.
    if (db.inTransaction) throw Error('Slack receipt requires its own transaction');
  }
  return {
    /** Suitable for slackSocket.receive. Throws on invalid/misbound data or a
     * failed commit, so the transport disconnects without acknowledging it.
     * Store only the event: outer verification tokens/authorizations are omitted.
     */
    async receive(payload: Record<string, unknown>): Promise<void> {
      outsideTransaction(); current();
      if (payload.type !== 'event_callback' || payload.team_id !== binding.venue.workspace
        || payload.api_app_id !== binding.app || !identifier(payload.event_id) || !object(payload.event)
        || typeof payload.event.type !== 'string' || !/^[A-Za-z0-9_.-]{1,200}$/.test(payload.event.type)) throw Error('Invalid Slack receipt');
      const event = JSON.stringify(payload.event);
      if (Buffer.byteLength(event) > 1024 * 1024) throw Error('Slack receipt too large');
      const id = createHash('sha256').update(JSON.stringify([key, payload.event_id])).digest('hex');
      db.transaction(() => {
        // Immutable first receipt, including after consumption; envelope_id is
        // an ACK address and never a deduplication identity.
        db.prepare(`INSERT OR IGNORE INTO bridges_slack_receipts
          (id,venue,binding,event_id,event,state,received) VALUES (?,?,?,?,?,'pending',?)`)
          .run(id, binding.venue.id, key, payload.event_id, event, clock.now());
      })();
    },
    /** Bounded page for the daemon normalizer; no unbounded private-data scan.
     * A stale identity cannot read or consume the prior bot's pending receipts.
     */
    pending(limit = 32, after?: Pick<SlackReceipt, 'received' | 'id'>): SlackReceipt[] {
      outsideTransaction(); current();
      if (!Number.isInteger(limit) || limit < 1 || limit > 64) throw Error('Invalid Slack receipt limit');
      if (after && (!Number.isSafeInteger(after.received) || !/^[a-f0-9]{64}$/.test(after.id))) throw Error('Invalid Slack receipt cursor');
      const rows = db.prepare(`SELECT id,event_id,event,received FROM bridges_slack_receipts
        WHERE venue=? AND binding=? AND state='pending'
        ${after ? 'AND (received > ? OR (received = ? AND id > ?))' : ''}
        ORDER BY received,id LIMIT ?`)
        .all(binding.venue.id, key, ...(after ? [after.received, after.received, after.id] : []), limit) as { id: string; event_id: string; event: string; received: number }[];
      return rows.map(row => ({ id: row.id, eventId: row.event_id, event: JSON.parse(row.event) as Record<string, unknown>, received: row.received }));
    },
    /** Call only after normalized engine.receive commits, or a definite discard.
     * Crash between those commits replays the raw event; engine ids dedup it.
     * Erase words but retain the permanent receipt id. Unknown ids fail closed.
     */
    consume(id: string): void {
      outsideTransaction(); current();
      const result = db.prepare(`UPDATE bridges_slack_receipts SET state='consumed',event=NULL
        WHERE id=? AND venue=? AND binding=?`).run(id, binding.venue.id, key);
      if (!result.changes) throw Error('Unknown Slack receipt');
    },
  };
}
