/** Desk metadata only. Delivered words are rejected before retry storage or SQL. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { operation, failure, maySee, mayAct, mayCreate, type Db, type Operations, type Live, type Sharing, type Scope, type LiveRecord } from '../../core/index.js';
const agentId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const slug = z.string().max(80).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
const printable = (max: number) => z.string().min(1).max(max).regex(/^[^\x00-\x1f\x7f]+$/);
const run = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/);
const at = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/).refine(s => !Number.isNaN(Date.parse(s))).transform(s => new Date(s).toISOString());
const from = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('person'), slug }).strict(), z.object({ kind: z.literal('agent'), id: agentId }).strict(),
  z.object({ kind: z.literal('schedule') }).strict(), z.object({ kind: z.literal('unknown') }).strict(),
]);
const own = new Set(['reply', 'action', 'note']);
export const turnInput = z.object({
  venue: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), place: z.string().min(1).max(200), at, from,
  kind: z.enum(['message', 'reply', 'action', 'wake', 'note', 'refused']), label: printable(80).optional(),
  run: run.optional(), model: printable(120).optional(), harness: printable(120).optional(),
  outcome: z.enum(['answered', 'progressed', 'deferred', 'failed', 'none']).optional(),
}).strict().superRefine((t, ctx) => {
  if (own.has(t.kind) ? (!t.run || !t.outcome || t.from.kind !== 'agent') : [t.run, t.model, t.harness, t.outcome].some(v => v !== undefined)) ctx.addIssue({ code: 'custom', message: 'Only own turns carry run, model, harness and outcome; own turns require run and outcome' });
});
export const recordTurnInput = z.object({ agent: agentId, project: slug.optional(), member: slug.optional(), turn: turnInput }).strict().superRefine((input, ctx) => {
  if (own.has(input.turn.kind) && (input.turn.from.kind !== 'agent' || input.turn.from.id !== input.agent)) ctx.addIssue({ code: 'custom', message: 'Own turn must come from its conversation agent' });
});
export interface Conversation extends Scope {
  id: string; agent: string; venue: string; place: string; label: string | null;
  people: string[]; agents: string[]; projects: string[]; started: string; last: string; turns: number;
}
export type Turn = Omit<z.output<typeof turnInput>, 'label'> & Scope & { id: string; conversation: string; seq: number; writer: { kind: string; id: string }; latency_ms?: number };
const sha12 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
export const conversationId = (agent: string, venue: string, place: string) => `cv-${sha12(`${agent}\0${venue}\0${place}`)}`;
const key = z.string().regex(/^cv-[a-f0-9]{12}$/);
export function installConversations(db: Db, operations: Operations, live: Live, sharing: () => Sharing) {
  const read = <T>(table: string, id: string): T | undefined => {
    const row = db.prepare(`SELECT record FROM ${table} WHERE id=?`).get(id) as { record: string } | undefined;
    return row && JSON.parse(row.record) as T;
  };
  const conversation = (id: string) => read<Conversation>('attention_conversations', id);
  operations.register(operation({ name: 'attention.recordTurn', write: true, input: recordTurnInput, output: z.unknown(),
    may(viewer, input) {
      const old = conversation(conversationId(input.agent, input.turn.venue, input.turn.place));
      const scope = { type: 'attention.conversation', agent: input.agent, project: input.project, member: input.member };
      return old ? old.project === input.project && old.member === input.member && mayAct(viewer, { type: scope.type, ...old }, sharing(), 'act', 'attention.recordTurn') : mayCreate(viewer, scope, sharing(), 'attention.recordTurn');
    },
    run(ctx, input) {
      const t = input.turn, id = conversationId(input.agent, t.venue, t.place);
      if (db.prepare('SELECT 1 FROM attention_days WHERE conversation=? AND day=?').get(id, t.at.slice(0, 10))) return failure('conflict', 'A folded UTC day takes no more turns');
      const c: Conversation = conversation(id) ?? { id, agent: input.agent, ...(input.project ? { project: input.project } : {}), ...(input.member ? { member: input.member } : {}), venue: t.venue, place: t.place, label: null, people: [], agents: [], projects: [], started: t.at, last: t.at, turns: 0 };
      if (t.from.kind === 'person' && !c.people.includes(t.from.slug) && c.people.length < 32) c.people.push(t.from.slug);
      if (t.from.kind === 'agent' && t.from.id !== c.agent && !c.agents.includes(t.from.id) && c.agents.length < 16) c.agents.push(t.from.id);
      const seq = c.turns + 1;
      const { label, ...metadata } = t;
      const record: Turn = { ...metadata, agent: c.agent, ...(c.project ? { project: c.project } : {}), ...(c.member ? { member: c.member } : {}), id: `${id}:${seq}`, conversation: id, seq, writer: ctx.viewer };
      if (t.kind === 'reply') {
        const lastReply = (db.prepare("SELECT max(seq) AS seq FROM attention_turns WHERE conversation=? AND json_extract(record,'$.kind')='reply'").get(id) as { seq: number | null }).seq ?? 0;
        // Arrival order is the old contract (ORDER BY seq), including delayed deliveries.
        const waiting = db.prepare("SELECT record FROM attention_turns WHERE conversation=? AND seq>? AND json_extract(record,'$.kind')='message' ORDER BY seq LIMIT 1").get(id, lastReply) as { record: string } | undefined;
        if (waiting) record.latency_ms = Math.max(0, Date.parse(t.at) - Date.parse((JSON.parse(waiting.record) as Turn).at));
      }
      c.label = label ?? c.label; c.turns = seq;
      c.started = t.at < c.started ? t.at : c.started; c.last = t.at > c.last ? t.at : c.last;
      db.prepare('INSERT INTO attention_conversations VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(id, JSON.stringify(c));
      db.prepare('INSERT INTO attention_turns VALUES (?,?,?,?)').run(record.id, id, seq, JSON.stringify(record));
      ctx.changed('attention.conversation', id); ctx.changed('attention.turn', record.id);
      return { conversation: id, seq, ...(record.latency_ms !== undefined ? { latency_ms: record.latency_ms } : {}) };
    },
  }));
  operations.register(operation({ name: 'attention.conversation', input: z.object({ id: key }).strict(), output: z.unknown(),
    may: (v, input) => { const c = conversation(input.id); return !!c && maySee(v, { type: 'attention.conversation', ...c }, sharing()); },
    run: (_ctx, input) => conversation(input.id),
  }));
  operations.register(operation({ name: 'attention.conversations', input: z.object({ agent: agentId.optional(), people: slug.optional(), venue: z.string().optional(), since: at.optional(), limit: z.number().int().min(1).max(100).default(100) }).strict(), output: z.unknown(),
    may: v => v.kind !== 'service' || mayAct(v, { type: 'attention.conversation' }, sharing(), 'act', 'attention.conversations'),
    run(ctx, f) {
      return (db.prepare('SELECT record FROM attention_conversations').all() as { record: string }[]).map(r => JSON.parse(r.record) as Conversation)
        .filter(c => maySee(ctx.viewer, { type: 'attention.conversation', ...c }, sharing()) && (!f.agent || c.agent === f.agent) && (!f.people || c.people.includes(f.people)) && (!f.venue || c.venue === f.venue) && (!f.since || c.last > f.since))
        .sort((a, b) => b.last.localeCompare(a.last) || a.id.localeCompare(b.id)).slice(0, f.limit);
    },
  }));
  operations.register(operation({ name: 'attention.turns', input: z.object({ conversation: key, after: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(500).default(100) }).strict(), output: z.unknown(),
    may: (v, input) => { const c = conversation(input.conversation); return !!c && maySee(v, { type: 'attention.turn', ...c }, sharing()); },
    run: (_ctx, input) => (db.prepare('SELECT record FROM attention_turns WHERE conversation=? AND seq>? ORDER BY seq LIMIT ?').all(input.conversation, input.after, input.limit) as { record: string }[]).map(r => JSON.parse(r.record)),
  }));
  for (const [name, table] of [['attention.conversation', 'attention_conversations'], ['attention.turn', 'attention_turns']] as const) live.register({
    name, ids: () => (db.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as { id: string }[]).map(r => r.id),
    read(id, viewer) { const r = read<Conversation | Turn>(table, id); return r && maySee(viewer, { type: name, ...r }, sharing()) ? r as unknown as LiveRecord : undefined; },
    inScope: (r, parent) => parent === undefined || r.conversation === parent,
  });
}
