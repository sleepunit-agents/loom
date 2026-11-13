import { useState, useSyncExternalStore, type FormEvent } from 'react';
import { call, type Call } from '../../data';
import { Error, Loading, Button, Input, Textarea } from '../../kit';
import { plainFields, fieldLabel, type Task, type TaskAnswer } from './model';
export type Action = 'claim' | 'unclaim' | 'close' | 'reopen' | 'comment' | 'edit' | 'priority' | 'project' | 'create';
export const actionLabel: Record<Action, string> = { claim: 'Claim', unclaim: 'Unclaim', close: 'Close task', reopen: 'Reopen', comment: 'Comment', edit: 'Edit task', priority: 'Set priority', project: 'Set project', create: 'Create task' };
const initial = { pending: false, status: 'done' as const };
const noop = () => () => {};
export function useAnswer(request?: Call<TaskAnswer>) { return useSyncExternalStore(request?.subscribe ?? noop, request?.getSnapshot ?? (() => initial)); }
export function Answer({ request }: { request?: Call<TaskAnswer> }) {
  const state = useAnswer(request);
  if (state.pending) return <Loading label={state.status === 'offline' ? 'Waiting for connection…' : 'Saving…'} />;
  const result = state.result;
  if (!result) return null;
  if (!result.ok) return <Error title="Couldn’t save" text={`${result.code}: ${result.message}`} />;
  if (!result.value.result.ok) return <Error title="Couldn’t save" text={result.value.result.errors?.join(', ') || 'invalid'} />;
  return <p role="status">Saved{result.value.result.warnings?.length ? ` · ${result.value.result.warnings.join(', ')}` : ''}</p>;
}
/** Each action owns its one request and keeps the draft on rejection. */
export function ActionForm({ action, task, enabled, onCancel }: { action: Action; task?: Task; enabled: boolean; onCancel(): void }) {
  const [request, setRequest] = useState<Call<TaskAnswer>>();
  const state = useAnswer(request);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!enabled || state.pending) return;
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    const base = { cli: true, ...(task ? { id: task.id } : {}) };
    const operation = ['edit', 'priority', 'project'].includes(action) ? 'update' : action;
    let input: object = base;
    if (action === 'edit') input = { ...base, set: fields };
    if (action === 'priority') input = { ...base, set: { priority: Number(fields.priority) } };
    if (action === 'project') input = { ...base, set: { project: fields.project } };
    if (action === 'close' || action === 'comment') input = { ...base, ...fields };
    if (action === 'create') { if (!fields.project) delete fields.project; input = { ...base, ...fields, priority: Number(fields.priority) }; }
    setRequest(call<TaskAnswer>(`tasks.${operation}`, input));
  };
  return <form aria-label={actionLabel[action]} onSubmit={submit} className="grid gap-3">
    <h3>{actionLabel[action]}</h3>
    <fieldset disabled={!enabled || state.pending} className="grid gap-3">
      {(action === 'edit' ? plainFields : action === 'create' ? ['title', 'goal', 'why', 'doneWhen', 'description'] as const : []).map(field =>
        <label key={field} className="grid gap-1">{fieldLabel[field]}<Textarea name={field} defaultValue={task?.[field] ?? ''} required={field === 'title' || (action === 'create' && (field === 'goal' || field === 'why'))} rows={field === 'description' ? 5 : 2} /></label>)}
      {(action === 'priority' || action === 'create') && <label>Priority <select name="priority" defaultValue={task?.priority ?? 2}>{[0,1,2,3,4].map(n => <option key={n} value={n}>P{n}</option>)}</select></label>}
      {(action === 'project' || action === 'create') && <label className="grid gap-1">Project<Input name="project" defaultValue={task?.project ?? ''} placeholder="Project slug (empty clears it)" /></label>}
      {action === 'create' && <label>Type <select name="type"><option value="task">Task</option><option value="bug">Bug</option><option value="feature">Feature</option><option value="epic">Epic</option></select></label>}
      {action === 'close' && <label className="grid gap-1">Reason<Textarea name="reason" required rows={3} /></label>}
      {action === 'comment' && <label className="grid gap-1">Comment<Textarea name="text" required rows={4} /></label>}
      <Button variant="outline" size="sm" type="submit">{actionLabel[action]}</Button>
    </fieldset>
    <Answer request={request} />
    <Button variant="outline" size="sm" type="button" onClick={onCancel}>Back to task</Button>
  </form>;
}
export function actionsFor(task: Task): Action[] { return [...(task.status === 'closed' ? ['reopen'] : [task.status === 'in_progress' ? 'unclaim' : 'claim', 'close']), 'comment', 'edit', 'priority', 'project'] as Action[]; }
