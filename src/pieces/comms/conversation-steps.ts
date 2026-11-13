import { z } from 'zod';
import { maySee, operation, OperationError, type Clock, type Db, type Operations, type Sharing, type Viewer } from '../../core/index.js';
import type { ConversationWriteBinding, ConversationCard } from './role.js';
import type { WordsKey } from './crypto.js';

/** Supplied by the new conversation store, never from page input or a legacy store.
 * version must change on replacement, including deletion/recreation with the same id. */
export interface StepConversation { agent: string; venue: string; version: string }
interface Row { seq: number; conversation: string; at: number; words: Buffer | null; record: Buffer | null }
interface Options {
 db: Db; operations: Operations; clock: Clock; key: WordsKey; days: number;
 sharing(): Sharing; closed(): boolean; changed(): void;
 conversation?(id: string): StepConversation | undefined;
}
export function installConversationSteps(o: Options) {
 const { db, operations, clock, key } = o;
 const unavailable = (): never => { throw new OperationError('denied', 'Conversation unavailable'); };
 const lookup = (viewer: Viewer, conversation: string) => {
  const c = o.conversation?.(conversation);
  if (o.closed() || !c || !c.agent || !c.venue || !c.version ||
   ['loom', 'comms', 'spawn'].includes(c.venue) || !maySee(viewer, { agent: c.agent }, o.sharing()) ||
   db.prepare('SELECT 1 FROM comms_threads WHERE json_extract(record,\'$.conversation\')=? UNION ALL SELECT 1 FROM comms_deleted WHERE conversation=? LIMIT 1').get(conversation, conversation)) return;
  return { agent: c.agent, venue: c.venue, version: c.version };
 };
 const rows = (conversation: string, before: number, cutoff: number) =>
  (db.prepare('SELECT * FROM comms_conversation_steps WHERE conversation=? AND seq<? AND at>? ORDER BY seq DESC LIMIT 100').all(conversation, before, cutoff) as Row[]).reverse();
 const retained = (row: Row) => row.words !== null && row.record !== null && row.at + o.days * 86400_000 > clock.now();
 const routing = (row: Row) => ({ seq: row.seq, conversation: row.conversation, at: row.at, keepUntil: row.at + o.days * 86400_000, text: null });
 operations.register(operation({ name: 'comms.conversationSteps', doors: ['socket'], windowOnly: true,
  input: z.object({ conversation: z.string().min(1).max(200), before: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() }).strict(),
  output: z.unknown(),
  may: (viewer, input) => viewer.kind === 'member' && !!lookup(viewer, input.conversation),
  async prepare(input, ctx) {
   const conversation = lookup(ctx.viewer, input.conversation); if (!conversation) return unavailable();
   const cutoff = clock.now() - o.days * 86400_000;
   const snapshot = rows(input.conversation, input.before ?? Number.MAX_SAFE_INTEGER, cutoff);
   const records = await Promise.all(snapshot.map(async row => {
    if (!retained(row)) return routing(row);
    const text = await key.open(row.words!);
    const metadata = z.object({ run: z.string(), id: z.string(), tool: z.string(), state: z.enum(['running', 'done', 'failed']) }).parse(JSON.parse(await key.open(row.record!)));
    if (metadata.tool === 'text') return routing(row);
    // Explicit fields only: an imported envelope cannot override routing or add output/body words.
    return { ...routing(row), ...metadata, text };
   }));
   return { conversation, cutoff, snapshot, records };
  },
  run(ctx, input, prepared) {
   const saved = prepared as { conversation: StepConversation; cutoff: number; snapshot: Row[]; records: unknown[] };
   const current = lookup(ctx.viewer, input.conversation);
   if (!current || JSON.stringify(current) !== JSON.stringify(saved.conversation)) return unavailable();
   if (JSON.stringify(rows(input.conversation, input.before ?? Number.MAX_SAFE_INTEGER, saved.cutoff)) !== JSON.stringify(saved.snapshot))
    throw new OperationError('conflict', 'Conversation changed; load this page again');
   return { steps: saved.snapshot.map((row, n) => retained(row) ? saved.records[n] : routing(row)) };
  },
 }));
 return { writer(binding: ConversationWriteBinding) {
  // Snapshot capability facts; mutation of the runtime's binding never widens it.
  const {agent, conversation, run, startedAt, valid} = binding;
  const allowed = binding.houseConversations === undefined ? undefined : [...binding.houseConversations];
  const bound = lookup({kind:'agent',id:agent}, conversation);
  const allRows = () => db.prepare('SELECT * FROM comms_conversation_steps WHERE conversation=? ORDER BY seq').all(conversation) as Row[];
  const available = () => {
   const c = lookup({kind:'agent',id:agent}, conversation);
   if (!valid() || !c || !bound || JSON.stringify(c)!==JSON.stringify(bound) || !run || run.length > 128 || !Number.isSafeInteger(startedAt) || startedAt < 0 ||
    startedAt > clock.now() || startedAt + o.days * 86400_000 <= clock.now() ||
    (allowed !== undefined && !allowed.includes(conversation))) return unavailable();
   return c;
  };
  return { async write(raw: readonly ConversationCard[]) {
   const card = z.object({id:z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/),tool:z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
    summary:z.string().min(1).max(120).refine(s=>!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(s)),state:z.enum(['running','done','failed'])}).strict();
   const cards = z.array(card).min(1).max(50).parse(raw);
   if (new Set(cards.map(c=>c.id)).size !== cards.length) throw new OperationError('invalid','Repeated card identity');
   const original = available(), snapshot = allRows();
   // Identity is encrypted too. Compare it in memory; never add plaintext run/id indexes.
   const identities = await Promise.all(snapshot.map(async row => row.record ?
    z.object({run:z.string(),id:z.string(),tool:z.string(),state:z.enum(['running','done','failed'])}).parse(JSON.parse(await key.open(row.record))) : undefined));
   const encoded = await Promise.all(cards.filter(c=>c.tool!=='text').map(async c => {
    const n = identities.findIndex(v=>v?.run===run && v.id===c.id), prior = n < 0 ? undefined : snapshot[n];
    // Swept/expired words stay gone, and an update never changes the original tool or deadline.
    if (prior && (!prior.words || prior.at + o.days * 86400_000 <= clock.now())) return;
    return {prior, words:await key.seal(c.summary), record:await key.seal(JSON.stringify({run,id:c.id,tool:prior?identities[n]!.tool:c.tool,state:c.state}))};
   }));
   const result = db.transaction(()=>{
    if (JSON.stringify(available()) !== JSON.stringify(original)) return unavailable();
    if (JSON.stringify(allRows()) !== JSON.stringify(snapshot)) throw new OperationError('conflict','Conversation changed; retry activity');
    let added=0, updated=0;
    for (const value of encoded) {
     if (!value) continue;
     if (value.prior) {
      if (value.prior.at + o.days * 86400_000 <= clock.now()) continue;
      db.prepare('UPDATE comms_conversation_steps SET words=?,record=? WHERE seq=?').run(value.words,value.record,value.prior.seq);updated++;
     } else {
      db.prepare('INSERT INTO comms_conversation_steps(conversation,at,words,record) VALUES (?,?,?,?)').run(conversation,clock.now(),value.words,value.record);added++;
     }
    }
    db.prepare('DELETE FROM comms_conversation_steps WHERE conversation=? AND seq NOT IN (SELECT seq FROM comms_conversation_steps WHERE conversation=? ORDER BY seq DESC LIMIT 1000)').run(conversation,conversation);
    return {added,updated};
   })();
   o.changed(); return result;
  }};
 }};

}
