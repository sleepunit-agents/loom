/** What the bricks that write Work share (docs/specs/boards.md, "The first bricks"): the desktop's own door for a
 * ticket command (data/task-command.ts, the one the Tasks forms send through), its choices of project and owner
 * (pieces/tasks/query.ts), its words for a priority, and the plain controls a brick's form is made of. What a
 * member types goes to tasks.command and nowhere else; the board is told the action's name and, at most, a choice. */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useDataQuery } from '../data/graphql';
import { liveAgents } from '../data/live-agents';
import { taskCommandSender, type TaskCommandResult } from '../data/task-command';
import { displayName } from '../kit/words';
import { taskChoicesQuery } from '../pieces/tasks/query';
import type { TaskCommand } from '../pieces/tasks/model';
import { taskDefaultPriority, taskPriorities } from '../pieces/tasks/words';
import { Field, Menu, Segmented, type Act } from './brick-kit';

/** Every ticket the member may read, in the backlog's order: what the desktop's Parent and Blocked by forms offer. */
export const ticketChoicesQuery = 'query BrickTicketChoices{tasks(orderBy:{priority:{direction:asc,priority:2},position:{direction:asc,priority:1},id:{direction:asc,priority:0}}){id title}}';

/** One ticket command through the desktop's door, then the report to the board that the member used it. A command
 * that is refused shows what loom said and reports nothing. */
export function useTaskCommand(act: Act, own: () => void = () => {}) {
  const send = useMemo(() => taskCommandSender(), []);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const lock = useRef(false);
  async function run(name: string, command: TaskCommand, detail: Record<string, string> = {}): Promise<TaskCommandResult | undefined> {
    if (lock.current) return undefined;
    lock.current = true; setBusy(true); setError('');
    try { own(); const value = await send(command); act(name, detail); return value; }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'That did not save.'); return undefined; }
    finally { lock.current = false; setBusy(false); }
  }
  return { busy, error, run };
}

export const priorityWord = (priority: number) => 'P' + priority;
export const priorityChoices = taskPriorities.map((label, value) => ({ value, label }));

/** One of a few fixed choices (./brick-kit.tsx, Segmented). */
export const Pick = Segmented;
/** One field of words (./brick-kit.tsx, Field). */
export const Words = Field;
type Choices = { projects: { id: string; name: string; projectMembersByProject: { member: string }[] }[]; agents: { id: string; removedAt?: string | null }[]; members: { id: string }[] };
export type Owner = { kind: 'member' | 'agent'; id: string; label: string };
/** The projects a ticket may be put in and the people and agents it may be given to, as the desktop's Tasks screen
 * reads them (data/tasks-app.tsx): the member looking, the members and the projects' members, and the agents in use. */
export function useTaskChoices(pause = false) {
  const read = useDataQuery<Choices>(taskChoicesQuery, {}, { keep: true, pause });
  const me = useDataQuery<{ homeComms: { member: string } | null }>('query WorkViewer { homeComms { member } }', {}, { keep: true, pause });
  const data = read.status === 'live' ? read.data : undefined;
  const member = me.status === 'live' ? me.data?.homeComms?.member : undefined;
  const members = Array.from(new Set([...(member ? [member] : []), ...(data?.members ?? []).map((m) => m.id), ...(data?.projects ?? []).flatMap((p) => (p.projectMembersByProject ?? []).map((edge) => edge.member))]));
  const people: Owner[] = [...members.map((id) => ({ kind: 'member' as const, id, label: displayName(id) })),
    ...liveAgents(data?.agents ?? []).map((agent) => ({ kind: 'agent' as const, id: agent.id, label: displayName(agent.id) }))];
  return { projects: (data?.projects ?? []).map((p) => ({ id: p.id, label: p.name })), people };
}

export type Summary = { title: string; goal: string; why: string; doneWhen: string; description: string; priority: number; project: string | null };
/** A ticket's words, priority and project as a draft: the fields of the desktop's Create and Edit forms
 * (pieces/tasks/shared-form.tsx), sent as that form sends them. Title, goal and why must say something. */
export function useSummary(from?: Partial<Summary>) {
  const [title, setTitle] = useState(from?.title ?? ''), [goal, setGoal] = useState(from?.goal ?? ''), [why, setWhy] = useState(from?.why ?? '');
  const [doneWhen, setDoneWhen] = useState(from?.doneWhen ?? ''), [description, setDescription] = useState(from?.description ?? '');
  const [priority, setPriority] = useState(from?.priority ?? taskDefaultPriority), [project, setProject] = useState(from?.project ?? '');
  const summary = (): Summary => ({ title: title.trim(), goal: goal.trim(), why: why.trim(), doneWhen, description, priority, project: project || null });
  const clear = () => { setTitle(''); setGoal(''); setWhy(''); setDoneWhen(''); setDescription(''); setPriority(taskDefaultPriority); };
  const fields = (show: { more: boolean; projects?: readonly { id: string; label: string }[]; disabled?: boolean }): ReactNode => (
    <>
      <Words label="Title" value={title} onChange={setTitle} disabled={show.disabled} />
      <Words label="Goal" long value={goal} onChange={setGoal} disabled={show.disabled} />
      <Words label="Why" long value={why} onChange={setWhy} disabled={show.disabled} />
      {show.more && <>
        <Words label="Done when" long value={doneWhen} onChange={setDoneWhen} disabled={show.disabled} />
        <Words label="Description" long value={description} onChange={setDescription} disabled={show.disabled} />
        <Pick<number> label="Priority" value={priority} options={priorityChoices} onChange={setPriority} disabled={show.disabled} />
        {show.projects && <Menu<string> label="Project" value={project} options={[{ value: '', label: 'No project' }, ...show.projects.map((p) => ({ value: p.id, label: p.label }))]} onChange={setProject} disabled={show.disabled} />}
      </>}
    </>
  );
  return { summary, clear, fields, valid: !!title.trim() && !!goal.trim() && !!why.trim() };
}
