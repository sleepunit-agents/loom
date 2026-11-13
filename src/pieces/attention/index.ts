import { z } from 'zod';
import { migrate, operation, failure, maySee, mayAct, mayCreate, type Db, type Operations, type Live, type Sharing, type RecordScope, type LiveRecord } from '../../core/index.js';
import type { Ask, AgentStatus } from './role.js';
import { schema } from './schema/001.js';
import { conversationSchema } from './schema/002.js';
import { retentionSchema } from './schema/004.js';
import { installRetention } from './retention.js';
import { digestSchema } from './schema/003.js';
import { installDigests } from './digests.js';
import { installConversations } from './conversations.js';
const id = z.string().min(1).max(200);
const scopeFields = { project: id.optional(), agent: id.optional(), member: id.optional() };
const question = z.object({
  id, ...scopeFields, ask: z.string().min(1), why: z.string().optional(),
  if_yes: z.string().optional(), if_no: z.string().optional(), href: z.string().optional(),
  refs: z.array(z.string()).optional(), answers: z.enum(['yes-no', 'words']).optional(),
  waits_on: z.union([z.object({ approval: id }), z.object({ task: id })]).optional(),
  source: z.object({ kind: z.enum(['conversation', 'approval', 'task', 'piece']), id }),
}).strict();
const answer = z.union([
  z.object({ kind: z.enum(['yes', 'no', 'done', 'dismiss']) }).strict(),
  z.object({ kind: z.literal('words'), text: z.string().trim().min(1) }).strict(),
]);
const link = z.object({ id, label: z.string(), href: z.string().optional() });
const status = z.object({ id, ...scopeFields, agent: id, state: z.enum(['working', 'waiting', 'idle', 'offline']), work: z.string(), jobs: z.array(link), watched: z.array(link) }).strict();
const scoped = (type: string, record: RecordScope): RecordScope => ({ type, ...record });
export function installAttention(db: Db, operations: Operations, live: Live, sharing: () => Sharing) {
  migrate(db, 'attention', [...schema, conversationSchema, digestSchema, retentionSchema]);
  installConversations(db, operations, live, sharing);
  installDigests(db, operations, live, sharing);
  installRetention(db, operations, live, sharing);
  const readAsk = (key: string): Ask | undefined => {
    const row = db.prepare('SELECT record FROM attention_asks WHERE id=?').get(key) as { record: string } | undefined;
    return row && JSON.parse(row.record) as Ask;
  };
  const saveAsk = (record: Ask) => db.prepare('INSERT INTO attention_asks VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(record.id, JSON.stringify(record));
  operations.register(operation({ name: 'attention.raise', write: true, input: question, output: z.unknown(),
    may: (viewer, input) => {
      const old = readAsk(input.id);
      return old ? mayAct(viewer, scoped('attention.ask', old), sharing(), 'act', 'attention.raise') : mayCreate(viewer, scoped('attention.ask', input), sharing(), 'attention.raise');
    },
    run(ctx, input) {
      const old = readAsk(input.id);
      // A stable identity is immutable, including its policy scope and wording.
      if (old) return old;
      const record: Ask = { ...input, state: 'open', createdAt: ctx.now, changedAt: ctx.now };
      saveAsk(record); ctx.changed('attention.ask', record.id); return record;
    },
  }));
  operations.register(operation({ name: 'attention.get', input: z.object({ id }), output: z.unknown(),
    may: (viewer, input) => { const r = readAsk(input.id); return !!r && maySee(viewer, scoped('attention.ask', r), sharing()); },
    run: (_ctx, input) => readAsk(input.id),
  }));
  operations.register(operation({ name: 'attention.answer', write: true, input: z.object({ id, answer }), output: z.unknown(),
    may: (viewer, input) => { const r = readAsk(input.id); return !!r && mayAct(viewer, scoped('attention.ask', r), sharing(), 'answer-person', 'attention.answer'); },
    run(ctx, input) {
      const record = readAsk(input.id)!;
      if (record.state !== 'open') return failure('conflict', 'Ask is no longer open');
      if (input.answer.kind === 'words' && record.answers !== 'words') return failure('invalid', 'Ask does not accept words');
      if ((input.answer.kind === 'yes' || input.answer.kind === 'no') && record.answers === 'words') return failure('invalid', 'Ask needs words');
      record.state = 'answered'; record.changedAt = ctx.now;
      record.answer = { ...input.answer, by: ctx.viewer, at: ctx.now };
      saveAsk(record); ctx.changed('attention.ask', record.id); return record;
    },
  }));
  operations.register(operation({ name: 'attention.resolve', write: true, input: z.object({ id, reason: z.string().min(1) }), output: z.unknown(),
    may: (viewer, input) => { const r = readAsk(input.id); return !!r && mayAct(viewer, scoped('attention.ask', r), sharing(), 'act', 'attention.resolve'); },
    run(ctx, input) {
      const record = readAsk(input.id)!;
      if (record.state !== 'open') return record;
      record.state = 'resolved'; record.changedAt = ctx.now; record.resolution = input.reason;
      saveAsk(record); ctx.changed('attention.ask', record.id); return record;
    },
  }));
  operations.register(operation({ name: 'attention.reportStatus', write: true, input: status, output: z.unknown(),
    may: (viewer, input) => {
      const row = db.prepare('SELECT record FROM attention_statuses WHERE id=?').get(input.id) as { record: string } | undefined;
      const old: AgentStatus | undefined = row && JSON.parse(row.record);
      // Status updates cannot move an existing record to another audience.
      return mayCreate(viewer, scoped('attention.agent', input), sharing(), 'attention.reportStatus') && (!old || ['project', 'agent', 'member'].every(k => old[k as keyof AgentStatus] === input[k as keyof typeof input]));
    },
    run(ctx, input) {
      const record: AgentStatus = { ...input, changedAt: ctx.now };
      db.prepare('INSERT INTO attention_statuses VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(record.id, JSON.stringify(record));
      ctx.changed('attention.agent', record.id); return record;
    },
  }));
  for (const [name, table] of [['attention.ask', 'attention_asks'], ['attention.agent', 'attention_statuses']] as const) live.register({
    name,
    ids: () => (db.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as { id: string }[]).map(r => r.id),
    read(key, viewer) {
      const row = db.prepare(`SELECT record FROM ${table} WHERE id=?`).get(key) as { record: string } | undefined;
      if (!row) return;
      const record = JSON.parse(row.record) as Ask | AgentStatus;
      if (!maySee(viewer, scoped(name, record), sharing())) return;
      return record as unknown as LiveRecord;
    },
    inScope: () => true,
  });
}
