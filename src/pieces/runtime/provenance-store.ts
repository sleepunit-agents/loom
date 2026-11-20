/** Private owning metadata. No registry operation accepts sender identity here.
 * Callers must derive it from the authenticated source and own the transaction.
 */
import { z } from 'zod';
import { OperationError, type Db } from '../../core/index.js';
import { emptyProvenance, noteProvenance, type ProvenanceRow } from './provenance.js';
const name = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const history = z.object({ owners: z.array(name).max(20), people: z.array(name).max(20), owner: z.boolean(), unknown: z.boolean() }).strict();
const sender = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('person'), person: name }).strict(),
  z.object({ kind: z.literal('schedule'), for: z.string().max(100).optional() }).strict(),
  z.object({ kind: z.literal('agent') }).strict(),
  z.object({ kind: z.literal('unknown') }).strict(),
]);
const queued = z.object({ key: z.string().min(1).max(1000), sender, at: z.number().int().safe() }).strict();
export type QueuedProvenance = z.infer<typeof queued>;
const state = z.object({ agent: name, history, queue: z.array(queued), reset: z.object({by:name,at:z.number().int().safe(),approval:z.string().min(1)}).strict().optional() }).strict();
export type ConversationProvenance = z.infer<typeof state>;
export function provenanceStore(db: Db) {
  function read(conversation: string): ConversationProvenance | undefined {
    const row = db.prepare('SELECT record FROM runtime_provenance WHERE conversation=?').get(conversation) as {record:string}|undefined;
    return row ? state.parse(JSON.parse(row.record)) : undefined;
  }
  function put(conversation: string, value: ConversationProvenance) {
    if (!db.inTransaction) throw new Error('Provenance writes require the caller transaction');
    db.prepare('INSERT INTO runtime_provenance(conversation,record) VALUES (?,?) ON CONFLICT(conversation) DO UPDATE SET record=excluded.record').run(conversation, JSON.stringify(state.parse(value)));
  }
  return { read, put,
    note(conversation: string, agent: string, raw: QueuedProvenance, owners: readonly string[]) {
      if (!db.inTransaction) throw new Error('Provenance writes require the caller transaction');
      const row = queued.parse(raw), before = read(conversation);
      if (before && before.agent !== agent) throw new OperationError('conflict', 'Conversation agent changed');
      const value = before ?? { agent, history: emptyProvenance(), queue: [] };
      const held = db.prepare('SELECT record FROM runtime_provenance_sources WHERE conversation=? AND key=?').get(conversation, row.key) as {record:string}|undefined;
      const old = held ? queued.parse(JSON.parse(held.record)) : undefined;
      if (old) {
        if (JSON.stringify(old) !== JSON.stringify(row)) throw new OperationError('conflict', 'Source key already describes another sender');
        return;
      }
      // History retains every sender after delivery; queue holds only sources
      // not yet authoritatively consumed. Both update in the same transaction.
      if (!db.inTransaction) throw new Error('Provenance writes require the caller transaction');
      db.prepare('INSERT INTO runtime_provenance_sources VALUES (?,?,?)').run(conversation, row.key, JSON.stringify(row));
      put(conversation, { ...value, agent, history: noteProvenance(value.history, row.sender, owners), queue: [...value.queue, row] });
    },
    consumed(conversation: string, keys: readonly ProvenanceRow['key'][]) {
      const before = read(conversation); if (!before) return;
      const gone = new Set(keys);
      put(conversation, { ...before, queue: before.queue.filter(row => !gone.has(row.key)) });
    },
  };
}
