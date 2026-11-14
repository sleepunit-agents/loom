import { registerBuiltinService } from '../../core/services.js';
import { z } from 'zod';
import { migrate, operation, maySee, mayAct, mayCreate, mayMove, type Db, type Operations, type Live, type Sharing, type Viewer, type RecordScope, type LiveRecord } from '../../core/index.js';
import { apply, type Command, type StoreState, type Result, type Task } from './domain.js';
import { load, persist, type ScopedTask } from './store.js';
import { schema } from './schema/001.js';
import { taskCommands } from './commands.js';
import type { TaskAskFiling } from '../attention/role.js';
import { cliBefore, cliAfter } from './binding.js';
export const verbs = taskCommands.map(c => c.name);
const reads = new Set(taskCommands.filter(c => !c.write).map(c => c.name));
const week = 7 * 86400_000;
const verbOf = (registered: string, input: Record<string, unknown>): string => registered === 'command' ? (typeof input.op === 'string' ? input.op : '') : registered;
const scope = (task: ScopedTask): RecordScope => ({ type: 'task', ...(task.project !== undefined ? { project: task.project } : {}), ...(task.agent !== undefined ? { agent: task.agent } : {}) });
const get = (state: StoreState, id: unknown) => state.tasks.find(t => t.id === id) as ScopedTask | undefined;
const scopeFields = (raw: object) => { const value = raw as Record<string, unknown>; return Object.fromEntries(['project', 'agent'].filter(k => value[k] !== undefined).map(k => [k, value[k]])); };
/** Resolve create scope identically before policy and persistence. */
function createScope(state: StoreState, viewer: Viewer, input: Record<string, unknown>) {
  const parent = get(state, input.parent);
  const fields: Record<string, unknown> = { ...(parent?.project !== undefined ? { project: parent.project } : {}), ...scopeFields(input) };
  if (viewer.kind === 'agent' && fields.project === undefined && fields.agent === undefined) fields.agent = viewer.id;
  return fields;
}
/** Preserve domain errors for malformed references; hidden references are denied. */
function permitted(db: Db, viewer: Viewer, verb: string, input: Record<string, unknown>, sharing: Sharing): boolean {
  const state = load(db), name = `tasks.${verb}`;
  if (viewer.kind === 'service' && !mayAct(viewer, { type: 'task' }, sharing, 'act', name)) return false;
  const access = (id: unknown, write: boolean) => { const t = get(state, id); return !t || (write ? mayAct(viewer, scope(t), sharing, 'act', name) : maySee(viewer, scope(t), sharing)); };
  if (verb === 'create') {
    const target = { type: 'task', ...createScope(state, viewer, input) };
    if (!access(input.parent, true) || !mayCreate(viewer, target, sharing, name)) return false;
    // A linkage idempotency hit must not reveal a hidden existing id.
    const hit = state.tasks.find(t => input.specItemRef !== undefined && t.specItemRef === input.specItemRef && t.criterionId === input.criterionId);
    return !hit || access(hit.id, true);
  }
  if (verb === 'import') {
    // Validate every proposed record and every existing link endpoint centrally.
    return (!Array.isArray(input.tasks) || input.tasks.every(t => !t || typeof t !== 'object' || mayCreate(viewer, { type: 'task', ...scopeFields(t) }, sharing, name)))
      && (!Array.isArray(input.links) || input.links.every(l => !l || typeof l !== 'object' || (access(l.id, true) && access(l.dependsOn, true))));
  }
  if (!reads.has(verb)) {
    if (!access(input.id, true)) return false;
    if ((verb === 'link' || verb === 'unlink') && !access(input.dependsOn, true)) return false;
    const before = get(state, input.id);
    if (verb === 'update' && before && input.set && typeof input.set === 'object' && !Array.isArray(input.set)) {
      const after = { ...scope(before), ...scopeFields(input.set as Record<string, unknown>) };
      for (const k of ['project', 'agent'] as const) if (after[k] === '') delete after[k];
      return mayMove(viewer, scope(before), after, sharing, name);
    }
    // Deleting a task also removes relations; every affected record must be writable.
    if (verb === 'delete') return state.links.filter(l => l.id === input.id || l.dependsOn === input.id).every(l => access(l.id, true) && access(l.dependsOn, true));
    return true;
  }
  if (verb === 'show') return access(input.id, false);
  // Collection reads filter by maySee; services also need an operation grant.
  return true;
}
const attentionConnections = new WeakMap<Operations, (source: () => TaskAskFiling) => void>();
/** Trusted composition, including registries whose Tasks installer ran before Attention. */
export function connectTaskAttention(operations: Operations, source: () => TaskAskFiling): void {
  const connect = attentionConnections.get(operations);
  if (!connect) throw new Error('Tasks is not installed');
  connect(source);
}
export function installTasks(db: Db, operations: Operations, live: Live, sharing: () => Sharing) {
  let filing: TaskAskFiling | undefined;
  registerBuiltinService(operations, 'tasks', ['task']);
  migrate(db, 'tasks', schema);
  const file = (ctx: import('../../core/index.js').Context, state: StoreState) => filing?.sync(ctx, (state.tasks as ScopedTask[])
    .filter(t => t.status !== 'closed' && !!t.assignee && Object.hasOwn(sharing().members,t.assignee) && sharing().members[t.assignee].owner)
    .map(t => ({id:t.id, ask:t.ask || t.title, ...(t.why ? {why:t.why}:{}), ...(t.ifYes ? {if_yes:t.ifYes}:{}), ...(t.ifNo ? {if_no:t.ifNo}:{}),
      ...(t.answers ? {answers:t.answers}:{}), ...(t.agent !== undefined ? {agent:t.agent}:{}), ...(t.project !== undefined ? {project:t.project}:{}),
      refs:[t.id], href:`/p/tasks-preview/task/${encodeURIComponent(t.id)}`})));
  attentionConnections.set(operations, source => {
    if (filing) return;
    filing = source();
    operations.register(operation({name:'tasks.reconcileAttention',write:true,doors:['direct'],input:z.object({}).strict(),output:z.null(),
    may:v=>v.kind==='service' && v.id==='tasks' && mayAct(v,{type:'task'},sharing(),'act','tasks.reconcileAttention'),
    run(ctx) { file(ctx,load(db)); return null; }}));
  });
  const visible = (state: StoreState, viewer: Viewer): StoreState => {
    const tasks = state.tasks.filter(t => maySee(viewer, scope(t), sharing()));
    const ids = new Set(tasks.map(t => t.id));
    return { ...state, tasks, links: state.links.filter(l => ids.has(l.id) && ids.has(l.dependsOn)) };
  };
  for (const operationVerb of [...verbs, 'command']) operations.register(operation({
    name: `tasks.${operationVerb}`, cli: taskCommands.find(c => c.name === operationVerb), write: !reads.has(operationVerb), input: z.record(z.string(), z.unknown()), output: z.object({ result: z.record(z.string(), z.unknown()), stderr: z.array(z.string()).optional() }),
    may: (viewer, input) => { const verb = verbOf(operationVerb, input); return permitted(db, viewer, verb, input, sharing()); },
    run(ctx, input) {
      const verb = verbOf(operationVerb, input);
      const before = load(db);
      const command: Command = { ...structuredClone(input), op: verb };
      if (input.cli && !reads.has(verb)) { if (!('actor' in input)) command.actor = ctx.viewer.id; if (!('at' in input)) command.at = new Date(ctx.now).toISOString(); }
      const held = reads.has(verb) ? visible(before, ctx.viewer) : before;
      if (verb === 'update' && input.cli && typeof command.sourceHint === 'string' && command.set && typeof command.set === 'object' && !Array.isArray(command.set)) {
        const t = get(before, command.id);
        if (t && t.source === undefined && Object.keys(command.set).length) (command.set as Record<string, unknown>).source ??= command.sourceHint;
      }
      const plain = input.cli ? cliBefore(before, command) : undefined;
      if (plain?.rejected) return { result: plain.rejected, stderr: [`taskstore: refused: ${plain.refuse}`] };
      const set = command.set;
      const scopeSet = verb === 'update' && set && typeof set === 'object' && !Array.isArray(set) ? scopeFields(set as Record<string, unknown>) : {};
      if (Object.keys(scopeSet).length) {
        command.set = Object.fromEntries(Object.entries(set as object).filter(([k]) => k !== 'project' && k !== 'agent'));
        // A scope-only move still receives all ordinary domain validation.
        if (!Object.keys(command.set as object).length) command.set = { title: get(before, command.id)?.title };
      }
      if (verb === 'import' && Array.isArray(input.tasks) && input.tasks.some(t => t && typeof t === 'object' && Object.values(scopeFields(t)).some(v => typeof v !== 'string'))) return { result: { ok: false, errors: ['E_BAD_FIELD'] } };
      if ([...Object.values(scopeFields(input)), ...Object.values(scopeSet)].some(v => typeof v !== 'string')) return { result: { ok: false, errors: ['E_BAD_FIELD'] } };
      const { result, state } = apply(held, command);
      if (result.ok === true && !reads.has(verb)) {
        if (verb === 'create' && result.created) Object.assign(get(state, result.id)!, createScope(before, ctx.viewer, input));
        if (verb === 'update') {
          const task = get(state, command.id)!;
          for (const [key, value] of Object.entries(scopeSet)) { if (value === '') delete task[key as 'project' | 'agent']; else task[key as 'project' | 'agent'] = value as string; }
        }
        if (verb === 'import' && Array.isArray(input.tasks)) for (const raw of input.tasks) if (raw && typeof raw === 'object') { const t = get(state, raw.id); if (t) Object.assign(t, scopeFields(raw)); }
        for (const id of persist(db, state, ctx.now)) ctx.changed('task', id);
        file(ctx,state);
      }
      // Ready must respect blockers even when a blocker is outside the caller's projects.
      if (verb === 'ready') {
        const full = apply(before, command).result;
        if (Array.isArray(full.entries)) full.entries = full.entries.filter(e => get(held, e.id));
        return { result: full };
      }
      return { result: input.cli ? cliAfter(command, result, plain?.warnings ?? []) : result };
    },
  }));
  live.register({ name: 'task',
    ids: () => (db.prepare('SELECT id FROM tasks_tasks ORDER BY ord').all() as { id: string }[]).map(r => r.id),
    read(id, viewer) {
      const row = db.prepare('SELECT record, changed_at FROM tasks_tasks WHERE id=?').get(id) as { record: string; changed_at: number } | undefined;
      if (!row) return;
      const task = JSON.parse(row.record) as ScopedTask;
      if (!maySee(viewer, scope(task), sharing())) return;
      const links = db.prepare("SELECT record FROM tasks_links WHERE json_extract(record, '$.id')=? ORDER BY ord").all(id) as { record: string }[];
      const visibleLinks = links.map(r => JSON.parse(r.record) as { dependsOn: string; type: string }).filter(l => {
        const target = db.prepare('SELECT record FROM tasks_tasks WHERE id=?').get(l.dependsOn) as { record: string } | undefined;
        return target && maySee(viewer, scope(JSON.parse(target.record) as ScopedTask), sharing());
      });
      const parent = visibleLinks.find(l => l.type === 'parent-child')?.dependsOn;
      // Readiness is derived before visibility filtering: a hidden blocker still blocks.
      const blocked = links.map(r => JSON.parse(r.record) as { dependsOn: string; type: string }).some(link => {
        if (link.type !== 'blocks') return false;
        const target = db.prepare('SELECT record FROM tasks_tasks WHERE id=?').get(link.dependsOn) as { record: string } | undefined;
        return target && JSON.parse(target.record).status !== 'closed';
      });
      return { ...task, blocked, ready: task.status === 'open' && task.type !== 'epic' && !blocked, dependsOn: visibleLinks.filter(l => l.type === 'blocks').map(l => l.dependsOn), ...(parent !== undefined ? { parent } : {}), changedAt: row.changed_at } as unknown as LiveRecord;
    },
    inScope: (r, parent, now) => (parent === undefined || r.parent === parent) && (r.status !== 'closed' || Number(r.changedAt) + week > now),
    expires: r => r.status === 'closed' ? Number(r.changedAt) + week : undefined,
  });
}
