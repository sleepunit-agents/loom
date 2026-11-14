import { createHash } from 'node:crypto';
import { registerBuiltinService } from '../../core/services.js';
import { operation } from './commands.js';
import { attentionMigrations } from './schema/index.js';
import { z } from 'zod';
import { migrate, failure, OperationError, maySee, mayAct, mayCreate, type Context, type Db, type Operations, type Live, type Sharing, type RecordScope, type LiveRecord } from '../../core/index.js';
import { approvalFiling } from './approval-filing.js';
import { registerAttentionAnnouncements, taskAskId, registerPrivateQuestions, registerPrivateReplies, type Ask, type AgentStatus, type AttentionSources, type TaskAskFiling } from './role.js';
import { installWaitChecks, type AttentionWaits } from './waits.js';
import { installHomeRoster } from './home.js';
import { installRetention } from './retention.js';
import { installDigests } from './digests.js';
import type { DigestReferences } from './project-references.js';
import { installConversations } from './conversations.js';
import { installMemberState } from './member-state.js';
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
// Capabilities are tied to the exact in-process registry, never reconstructed
// from persisted data or a request's source label.
const installedSources = new WeakMap<Operations, AttentionSources>();
export const attentionSources = (operations: Operations): AttentionSources | undefined => installedSources.get(operations);
export function installAttention(db: Db, operations: Operations, live: Live, sharing: () => Sharing, references: DigestReferences = {}, waits: AttentionWaits = {}) {
  registerBuiltinService(operations, 'attention', ['attention.ask', 'attention.agent', 'attention.conversation', 'attention.turn', 'attention.digest', 'attention.day', 'attention.finding', 'task', 'approval'], 'attention', ['tasks.show', 'approvals.check']);
  migrate(db, 'attention', attentionMigrations);
  installHomeRoster(live, sharing);
  installMemberState(db, operations, live, sharing);
  installConversations(db, operations, live, sharing);
  installDigests(db, operations, live, sharing, references);
  installRetention(db, operations, live, sharing);
  installWaitChecks(db, operations, sharing, waits);
  const readAsk = (key: string): Ask | undefined => {
    const row = db.prepare('SELECT record FROM attention_asks WHERE id=?').get(key) as { record: string } | undefined;
    return row && JSON.parse(row.record) as Ask;
  };
  const saveAsk = (record: Ask) => db.prepare('INSERT INTO attention_asks VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(record.id, JSON.stringify(record));
  let tasksRegistered = false, approvalsRegistered = false;
  let approvalCurrent: ((ask: Ask) => boolean) | undefined;
  const sourceCurrent = (record: Ask | AgentStatus) => {
    if (!('sourceManaged' in record) || !record.sourceManaged || record.source.kind !== 'approval') return true;
    try { return approvalCurrent?.(record) === true; } catch { return false; }
  };
  registerPrivateQuestions(operations, (ctx, raw) => {
    if (ctx.db !== db || !db.inTransaction) return failure('unavailable', 'Private question needs its enclosing transaction');
    const parsed = z.object({id:z.string().regex(/^comms:[0-9a-f]{64}$/), conversation:id, agent:id, member:id, thread:id,
      seq:z.number().int().positive(), project:id.optional(), answers:z.enum(['yes-no','words'])}).strict().safeParse(raw);
    if (!parsed.success) return failure('invalid', 'Invalid private question reference');
    const input=parsed.data;
    const record: Ask = {id:input.id, agent:input.agent, member:input.member, ...(input.project?{project:input.project}:{}),
      source:{kind:'conversation',id:input.conversation}, ask:'Reply in your private conversation', answers:input.answers,
      privateQuestion:{thread:input.thread,seq:input.seq}, state:'open',createdAt:ctx.now,changedAt:ctx.now};
    if(ctx.viewer.kind!=='member'||ctx.viewer.id!==input.member || !mayCreate(ctx.viewer,scoped('attention.ask',record),sharing(),'attention.raise'))
      return failure('denied','Ask unavailable');
    const old=readAsk(input.id);
    if(old) {
      const stable=(a:Ask)=>[a.id,a.agent,a.member,a.project,a.source,a.answers,a.privateQuestion];
      return JSON.stringify(stable(old))===JSON.stringify(stable(record)) ? {ok:true,value:{id:old.id}} : failure('conflict','Private question identity changed');
    }
    saveAsk(record);ctx.changed('attention.ask',record.id);return {ok:true,value:{id:record.id}};
  });
  registerAttentionAnnouncements(operations, member => {
    const viewer={kind:'member' as const,id:member},access=sharing();
    return (db.prepare('SELECT record FROM attention_asks ORDER BY id').all() as {record:string}[]).flatMap(row=>{
      const ask=JSON.parse(row.record) as Ask;
      if(ask.state!=='open'||!sourceCurrent(ask)||!maySee(viewer,scoped('attention.ask',ask),access))return [];
      return [{key:`attention:${announcementKey(ask)}`,url:`/p/inbox-preview/ask/${encodeURIComponent(ask.id)}`}];
    });
  });
  registerPrivateReplies(operations, (ctx, raw) => {
    if (ctx.db !== db || !db.inTransaction) return failure('unavailable', 'Private reply needs its enclosing transaction');
    const parsed = z.object({id, conversation: id, agent: id, member: id, thread: id, seq: z.number().int().positive()}).strict().safeParse(raw);
    if (!parsed.success) return failure('invalid', 'Invalid private reply reference');
    const input = parsed.data, record = readAsk(input.id);
    if (!record || record.id !== input.id || record.member !== input.member || record.agent !== input.agent || record.source.kind !== 'conversation'
      || record.source.id !== input.conversation || ctx.viewer.kind !== 'member' || ctx.viewer.id !== input.member
      || !mayAct(ctx.viewer, scoped('attention.ask', record), sharing(), 'answer-person')) return failure('denied', 'Ask unavailable');
    // Waiting and managed sources keep their own decision protocol. A typed
    // reply cannot authorize an approval, complete a task or bypass its owner.
    if (record.sourceManaged || record.waits_on) return failure('conflict', 'Answer this ask through its source');
    if (record.state !== 'open') {
      const answer = record.answer;
      return record.state === 'answered' && answer?.kind === 'replied' && answer.by.kind === 'member' && answer.by.id === input.member
        && answer.reply?.thread === input.thread && answer.reply.seq === input.seq
        ? {ok: true, value: {answered: true}} : failure('conflict', 'Ask is no longer open');
    }
    record.state = 'answered'; record.changedAt = ctx.now;
    record.answer = {kind: 'replied', reply: {thread: input.thread, seq: input.seq}, by: ctx.viewer, at: ctx.now};
    saveAsk(record); ctx.changed('attention.ask', record.id);
    return {ok: true, value: {answered: true}};
  });
  const sources = new Map<string, (ctx: Context, ask: Ask) => void>();
  const managed = (record: Pick<Ask, 'source' | 'sourceManaged'>) => record.sourceManaged === true;
  operations.register(operation({ name: 'attention.raise', write: true, input: question, output: z.unknown(),
    may: (viewer, input) => {
      const old = readAsk(input.id);
      if (input.id.startsWith('comms:') || input.id.startsWith('task:') || input.id.startsWith('approval:') || input.source.kind === 'approval' && approvalsRegistered || (old ? managed(old) : input.source.kind === 'task' && tasksRegistered || input.source.kind === 'piece' && sources.has(input.source.id))) return false;
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
  operations.register(operation({ name: 'attention.pendingWaits', input: z.object({}).strict(), output: z.array(z.string()),
    may: viewer => viewer.kind !== 'service' || mayAct(viewer, { type: 'attention.ask' }, sharing(), 'act', 'attention.pendingWaits'),
    run(ctx) {
      return (db.prepare('SELECT record FROM attention_asks ORDER BY id').all() as { record: string }[])
        .map(row => JSON.parse(row.record) as Ask)
        .filter(ask => ask.state === 'open' && !ask.sourceManaged && !!ask.waits_on && maySee(ctx.viewer, scoped('attention.ask', ask), sharing()))
        .map(ask => ask.id);
    },
  }));
  operations.register(operation({ name: 'attention.get', input: z.object({ id }), output: z.unknown(),
    may: (viewer, input) => { const r = readAsk(input.id); return !!r && sourceCurrent(r) && maySee(viewer, scoped('attention.ask', r), sharing()); },
    run: (_ctx, input) => readAsk(input.id),
  }));
  operations.register(operation({ name: 'attention.answer', write: true, input: z.object({ id, answer, requireOwnership: z.literal(true).optional() }), output: z.unknown(),
    may: (viewer, input) => {
      const r = readAsk(input.id), held = sharing();
      return !!r && !(managed(r) && (r.source.kind === 'task' || r.source.kind === 'approval')) && mayAct(viewer, scoped('attention.ask', r), held, managed(r) ? 'household' : 'answer-person', 'attention.answer')
        && (!input.requireOwnership || mayAct(viewer, { agent: r.agent }, held, 'give-work'));
    },

    run(ctx, input) {
      const record = readAsk(input.id)!;
      if (record.state !== 'open') return failure('conflict', 'Ask is no longer open');
      // Private reply wording belongs in encrypted Comms, never this row or its retry receipt.
      if (input.answer.kind === 'words' && record.member !== undefined) return failure('invalid', 'Reply in the private conversation');
      if (input.answer.kind === 'words' && managed(record) && record.answers !== 'words') return failure('invalid', 'Ask does not accept words');
      if ((input.answer.kind === 'yes' || input.answer.kind === 'no') && record.answers === 'words') return failure('invalid', 'Ask needs words');
      record.state = 'answered'; record.changedAt = ctx.now;
      record.answer = { ...input.answer, by: ctx.viewer, at: ctx.now };
      saveAsk(record); ctx.changed('attention.ask', record.id);
      const hook = managed(record) && record.source.kind === 'piece' ? sources.get(record.source.id) : undefined;
      if (managed(record) && !hook) throw new OperationError('unavailable', 'Ask source is not installed');
      if (hook) {
        const result: unknown = hook(ctx, record);
        if (result instanceof Promise) { void result.catch(() => {}); throw new OperationError('unavailable', 'Source answer must be synchronous'); }
      }
      return record;
    },
  }));
  operations.register(operation({ name: 'attention.resolve', write: true, input: z.object({ id, reason: z.string().min(1) }), output: z.unknown(),
    may: (viewer, input) => { const r = readAsk(input.id); return !!r && !r.privateQuestion && !managed(r) && mayAct(viewer, scoped('attention.ask', r), sharing(), 'act', 'attention.resolve'); },
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
      if (!sourceCurrent(record) || !maySee(viewer, scoped(name, record), sharing())) return;
      return record as unknown as LiveRecord;
    },
    inScope: () => true,
  });
  const role: AttentionSources = { approvals(current) {
    if (approvalsRegistered) throw new Error('Duplicate approval filing');
    approvalsRegistered = true;
    approvalCurrent = current;
    return approvalFiling(db);
  }, tasks() {
    if (tasksRegistered) throw new Error('Duplicate task filing');
    tasksRegistered = true;
    const withdrawn = (old: Ask, audience: Pick<Ask,'project'|'agent'> = old): Ask => ({id:old.id,source:old.source,sourceManaged:true,
      ...(audience.agent !== undefined ? {agent:audience.agent}:{}), ...(audience.project !== undefined ? {project:audience.project}:{}),
      ask:'Task no longer needs you',state:'resolved',resolution:'Continue in Tasks',createdAt:old.createdAt,changedAt:old.changedAt});
    const project = (ctx: Context, inputs: Parameters<TaskAskFiling['sync']>[1], apply: boolean) => {
      let dirty = false;
      if (ctx.db !== db || !db.inTransaction) throw new OperationError('unavailable', 'Task filing needs its enclosing database transaction');
      const seen = new Set<string>();
      for (const input of inputs) {
        const {active:rawActive,...fields} = input;
        const active = z.boolean().parse(rawActive);
        const parsed = question.extend({project:z.string().optional(),agent:z.string().optional(),source:z.object({kind:z.literal('task'),id:z.string()})}).parse({ ...fields, id:taskAskId(input.id), source: { kind: 'task', id: input.id } });
        if (parsed.member !== undefined || parsed.waits_on !== undefined) throw new OperationError('invalid', 'Task filing accepts only task audiences');
        const key = parsed.id;
        if (seen.has(key)) throw new OperationError('invalid', 'Duplicate task filing');
        seen.add(key);
        const old = readAsk(key);
        if (old && (!managed(old) || old.source.kind !== 'task' || old.source.id !== parsed.source.id)) throw new OperationError('conflict', 'Ask belongs to another source');
        if (!active && !old) continue;
        const record: Ask = active
          ? { ...parsed, sourceManaged: true, state: 'open', createdAt: old?.createdAt ?? ctx.now, changedAt: old?.changedAt ?? ctx.now }
          : withdrawn(old!,parsed);
        if (JSON.stringify(record) === JSON.stringify(old)) continue;
        record.changedAt = ctx.now;
        dirty = true;
        if (apply) { saveAsk(record); ctx.changed('attention.ask', key); }
      }
      // Withdrawing a source removes its words rather than preserving stale wording
      // after reassignment/deletion. Read marks remain facts about this source id.
      for (const row of db.prepare('SELECT record FROM attention_asks').all() as {record:string}[]) {
        const old = JSON.parse(row.record) as Ask;
        if (!managed(old) || old.source.kind !== 'task' || seen.has(old.id) || old.state === 'resolved') continue;
        const record = withdrawn(old); record.changedAt = ctx.now;
        dirty = true;
        if (apply) { saveAsk(record); ctx.changed('attention.ask', record.id); }
      }
      return dirty;
    };
    return { sync(ctx, inputs) { project(ctx,inputs,true); }, pending: (ctx,inputs) => project(ctx,inputs,false) };
  }, register(name, answer) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || sources.has(name)) throw new Error('Invalid or duplicate attention source');
    sources.set(name, answer);
    const check = (ctx: Context) => {
      if (ctx.db !== db || !db.inTransaction) throw new OperationError('unavailable', 'Source needs its enclosing database transaction');
    };
    const own = (record: Ask) => managed(record) && record.source.kind === 'piece' && record.source.id === name;
    return {
      raise(ctx, input) {
        check(ctx);
        // Parsing blocks scope injection even from an accidentally miswired caller.
        const parsed = question.parse({ ...input, source: { kind: 'piece', id: name } });
        if (parsed.id.startsWith('comms:')) throw new OperationError('conflict', 'Ask belongs to another source');
        if (parsed.project !== undefined || parsed.agent !== undefined || parsed.member !== undefined || parsed.waits_on !== undefined) throw new OperationError('invalid', 'Source asks must be household asks');
        const old = readAsk(parsed.id);
        if (old) {
          if (!own(old)) throw new OperationError('conflict', 'Ask belongs to another source');
          return;
        }
        const record: Ask = { ...parsed, sourceManaged: true, state: 'open', createdAt: ctx.now, changedAt: ctx.now };
        saveAsk(record); ctx.changed('attention.ask', record.id);
      },
      resolve(ctx, id, reason) {
        check(ctx);
        const record = readAsk(id);
        if (!record) return;
        if (!own(record)) throw new OperationError('conflict', 'Ask belongs to another source');
        if (record.state !== 'open') return;
        record.state = 'resolved'; record.resolution = reason; record.changedAt = ctx.now;
        saveAsk(record); ctx.changed('attention.ask', record.id);
      },
    };
  } };
  installedSources.set(operations, role);
  return role;

}

function announcementKey(ask:Ask):string {
  return createHash('sha256').update(JSON.stringify([ask.id,ask.ask,ask.href??''])).digest('hex');
}
