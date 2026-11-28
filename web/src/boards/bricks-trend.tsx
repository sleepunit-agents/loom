/** The `trend` brick's body: the chart of ./trend.tsx, given its parameters and the chip for a ticket; and, big, the
 * desktop's backlog history (web/src/pieces/work/backlog-window.tsx) for the same window the chart shows.
 *
 * The backlog history is the desktop's read, `projectBacklogWindow` (core/data/backlog-window.ts): how many of the
 * project's tickets were open at the start and the end of the window, and which opened, closed, reopened and moved,
 * by group, each group's tickets read when it is picked, fifty at most. It is closed until the member opens it, and
 * each opening reads it once (`useDataOnce`, not live), as each group picked does. Closing it, the brick leaving its
 * big form, or its project or days changing forgets what was read. Who may read it is the server's: a project the
 * member may read, and in it only the tickets the member may open today. */
import { useState } from 'react';
import { useDataOnce } from '../data/graphql';
import { Lead, Loading, Menu, Note, Opened, Opens, Row, Rows, Section, ticketChip, words, type BodyProps } from './brick-kit';
import { Trend as Chart, since } from './trend';

/** The desktop's groups, in its order and words (backlog-window.tsx, `labels`). */
export const backlogGroups = {
  start: 'Open at the start', end: 'Open at the end', originalEverClosed: 'Original tickets that closed',
  originalClosed: 'Original tickets still closed', originalMovedOut: 'Original tickets now elsewhere', addedOpen: 'Added to the open backlog',
  created: 'Tickets created here', arrivalsClosed: 'New tickets that also closed', reopened: 'Reopened here',
  movedIn: 'Moved into this project', movedOut: 'Moved out of this project',
} as const;
type Group = keyof typeof backlogGroups;
export type BacklogWindow = { coverage: string; from: string; until: string; counts: { key: Group; total: number }[]; tickets: { id: string; title: string }[] };
/** The desktop's selection, by the brick's own name: fifty tickets of a group at a time, as the desktop asks. */
export const backlogWindowQuery = `query BrickBacklogWindow($project:String!,$since:String!,$until:String!,$group:String,$offset:Int!){
  projectBacklogWindow(project:$project,since:$since,until:$until,group:$group,offset:$offset,limit:50){
    coverage from until counts{key total} tickets{id title}
  }
}`;
const PAGE = 50;
const day = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function Tickets({ project, from, until, group, total }: { project: string; from: string; until: string; group: Group; total: number }) {
  const read = useDataOnce<{ projectBacklogWindow: BacklogWindow | null }>(backlogWindowQuery, { project, since: from, until, group, offset: 0 });
  if (read.status === 'loading') return <Loading />;
  const tickets = read.status === 'live' ? read.data?.projectBacklogWindow?.tickets : undefined;
  if (!tickets) return <Note>These tickets are unavailable. Pick the group again to try again.</Note>;
  if (!tickets.length) return <Note>No ticket you can open is in this group.</Note>;
  return (
    <>
      <Rows label={backlogGroups[group]}>{tickets.map((t) => <Row key={t.id} title={ticketChip(t.id)} meta={t.title} />)}</Rows>
      {total > PAGE && <Note>The first {PAGE} of {total}, by title. The desktop's backlog history lists the rest.</Note>}
    </>
  );
}

/** What one opening read: the counts, then the tickets of the group picked. */
function History({ project, from, until }: { project: string; from: string; until: string }) {
  const read = useDataOnce<{ projectBacklogWindow: BacklogWindow | null }>(backlogWindowQuery, { project, since: from, until, group: null, offset: 0 });
  const [group, pick] = useState<Group | null>(null);
  if (read.status === 'loading') return <Loading />;
  const report = read.status === 'live' ? read.data?.projectBacklogWindow : null;
  if (!report) return <Note>The backlog history is unavailable. Hide it and show it again to try again.</Note>;
  const counts = new Map(report.counts.map((c) => [c.key, c.total]));
  const n = (key: Group) => counts.get(key) ?? 0;
  return (
    <>
      <Note>{day(report.from)} to {day(report.until)} · tickets you can open today</Note>
      {from < report.coverage && <Note>History starts {day(report.coverage)}.</Note>}
      {!counts.size ? <Note>Nothing was in this project's backlog in this time.</Note> : (
        <>
          <Lead>{n('start')} open at the start · {n('end')} open at the end</Lead>
          <Menu<Group | ''> label="Tickets" value={group ?? ''} onChange={(g) => pick(g || null)}
            options={(Object.keys(backlogGroups) as Group[]).map((key) => ({ value: key, label: `${backlogGroups[key]} · ${n(key)}` }))} />
          {group && <Section title={backlogGroups[group]} count={n(group)}><Tickets key={group} project={project} from={from} until={until} group={group} total={n(group)} /></Section>}
        </>
      )}
    </>
  );
}

/** The section the member opens. Mounted only in the big form and keyed by the project and window, so leaving the big
 * form or changing either forgets it; each opening mounts `History` afresh, which reads once. */
function Backlog({ project, days }: { project: string; days: number }) {
  const [open, setOpen] = useState(false), [span, setSpan] = useState<{ from: string; until: string } | null>(null);
  const toggle = () => {
    if (!open) { const now = Date.now(); setSpan({ from: new Date(since(now, days)).toISOString(), until: new Date(now).toISOString() }); }
    setOpen(!open);
  };
  return (
    <Section title="Backlog history">
      <Opens open={open} onToggle={toggle}>{open ? 'Hide the backlog history' : 'Show the backlog history'}</Opens>
      {open && span && <Opened><History project={project} from={span.from} until={span.until} /></Opened>}
    </Section>
  );
}

export const Trend = ({ params, form }: BodyProps) => {
  const project = words(params.project), days = Number(params.days) || 30;
  return (
    <>
      <Chart project={project} days={days} form={form} chip={ticketChip} />
      {form === 'primary' && <Backlog key={`${project}:${days}`} project={project} days={days} />}
    </>
  );
};
