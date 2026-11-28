/** The `catchup` brick: the desktop's Work catch-up (web/src/pieces/work/catch-up.tsx) across every project the
 * member may read. It reads what the desktop reads, the same two root fields with the same arguments: the tickets
 * changed since a time, four a project at most, each with its latest comment (`projects { tasksByProject }`, the
 * desktop's WorkCatchUp), and the agents' latest updates on tickets, four a project (`projectActivityHighlights`,
 * the desktop's WorkPostedUpdates). The two are put together as the desktop puts them together: a ticket says the
 * newest of its update, its comment or what happened to it, and a ticket only an update names is listed too.
 *
 * The desktop's time is "since your last visit on this desktop", kept in the browser's storage. A board keeps nothing
 * there (docs/specs/boards.md, rule 3), so the time is the brick's parameter: the start of today, or of the day two
 * or six days before it, in the member's device zone, as the trend brick counts its days. The time is worked out
 * when the brick is drawn, and again when its parameter changes.
 *
 * Who may read what is the tasks and projects rules' alone: `tasksByProject` is read under them, and
 * `projectActivityHighlights` lists updates only on tickets the member may read in projects they may read, from
 * sources they may read (core/conversations/project-posts.ts). Reads: both are live selections, relaxed as every
 * brick's are. */
import { useState } from 'react';
import { catchupSince } from '../../../src/core/boards/bricks/catchup';
import { useDataQuery } from '../data/graphql';
import { Chip, Few, Lead, Loading, More, Note, Row, Rows, Section, Time, actorChip, count, words, type Params } from './brick-kit';
import type { Form } from './layout';

type Since = (typeof catchupSince)[number];
export type CatchupTicket = {
  id: string; title: string; changedAt: string; createdAt: string; startedAt: string | null; closedAt: string | null;
  status: string; closeReason: string | null; ask: string | null; taskCommentsByTask: { at: string; actor: string; text: string }[];
};
export type CatchupProject = { id: string; name: string; lifecycle: string; tasksByProject: CatchupTicket[] };
export type CatchupPost = { project: string; task: string; title: string; id: string; at: string; agent: string; words: string };
/** One line of the catch-up: a ticket, when it last moved, and what moved it. `agent` is the agent whose update it is. */
export type CatchupItem = { id: string; title: string; at: string; agent: string | null; words: string };

/** The desktop's two selections, by the brick's own names. */
export const catchupQuery = `query BrickCatchUp($since:String!) {
  projects(orderBy:{name:{direction:asc,priority:1},id:{direction:asc,priority:0}}) {
    id name lifecycle
    tasksByProject(where:{changedAt:{gte:$since}},orderBy:{changedAt:{direction:desc,priority:1},id:{direction:asc,priority:0}},limit:4) {
      id title changedAt createdAt startedAt closedAt status closeReason ask
      taskCommentsByTask(orderBy:{seq:{direction:desc,priority:0}},limit:1){at actor text}
    }
  }
}`;
export const catchupPostsQuery = `query BrickCatchUpPosts($since:String!){
  projectActivityHighlights(project:null,since:$since){project task title id at agent words}
}`;

const days: Record<Since, number> = { today: 1, '3-days': 3, '7-days': 7 };
const sinceWords: Record<Since, { label: string; lead: string }> = {
  today: { label: 'Today', lead: 'today' }, '3-days': { label: '3 days', lead: 'in 3 days' }, '7-days': { label: '7 days', lead: 'in 7 days' },
};
/** The first moment of the day `days - 1` days before the day `now` is in, in the reader's own time. */
export function catchupFrom(now: number, since: Since): string {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - (days[since] - 1)).toISOString();
}

const excerpt = (text: string) => { const line = text.trim().replace(/\s+/g, ' '); return line.length > 220 ? line.slice(0, 217) + '…' : line; };
/** What a ticket's change was, in the desktop's words (catch-up.tsx, `headline`). */
function headline(t: CatchupTicket, since: string, post?: CatchupPost): { agent: string | null; words: string } {
  const latest = t.taskCommentsByTask[0];
  if (t.status === 'closed' && t.closedAt === t.changedAt) {
    if (!t.closeReason) return { agent: null, words: 'Closed' };
    if (t.closeReason === 'cancelled') return { agent: null, words: 'Cancelled' };
    if (t.closeReason !== 'done') return { agent: null, words: 'Closed · ' + excerpt(t.closeReason) };
    const note = latest && latest.at > since ? latest : undefined;
    if (post && (!note || post.at >= note.at)) return { agent: post.agent, words: 'Completed · ' + excerpt(post.words) };
    return { agent: null, words: note ? `Completed · ${note.actor} · ${excerpt(note.text)}` : 'Completed' };
  }
  if (latest && latest.at > since) return { agent: null, words: `${latest.actor} · ${excerpt(latest.text)}` };
  if (t.ask) return { agent: null, words: t.ask };
  if (t.startedAt === t.changedAt) return { agent: null, words: 'Work started' };
  if (t.createdAt === t.changedAt) return { agent: null, words: 'Ticket opened' };
  return { agent: null, words: 'Ticket updated' };
}
/** Each project with something since `since`, its tickets newest first, as the desktop puts its two reads together.
 * A removed project is left out, as the desktop leaves it out. Pure. */
export function catchupItems(projects: readonly CatchupProject[], posts: readonly CatchupPost[], since: string): { project: CatchupProject; items: CatchupItem[] }[] {
  const byProject = new Map<string, CatchupPost[]>();
  for (const p of posts) byProject.set(p.project, [...(byProject.get(p.project) ?? []), p]);
  return projects.filter((p) => p.lifecycle !== 'removed').map((project) => {
    const updates = new Map((byProject.get(project.id) ?? []).map((p) => [p.task, p]));
    const items = new Map<string, CatchupItem>();
    for (const t of project.tasksByProject) {
      if (!(t.changedAt >= since) && !updates.has(t.id)) continue;
      const post = updates.get(t.id), closing = t.status === 'closed' && t.closedAt === t.changedAt;
      if (post && (post.at > t.changedAt || (!closing && post.at === t.changedAt))) items.set(t.id, { id: t.id, title: t.title, at: post.at, agent: post.agent, words: excerpt(post.words) });
      else items.set(t.id, { id: t.id, title: t.title, at: t.changedAt, ...headline(t, since, post) });
    }
    for (const p of updates.values()) if (!items.has(p.task)) items.set(p.task, { id: p.task, title: p.title, at: p.at, agent: p.agent, words: excerpt(p.words) });
    return { project, items: [...items.values()].sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id)) };
  }).filter((g) => g.items.length);
}

const projectChip = (p: { id: string; name: string }) => <Chip place={{ brick: 'project', params: { project: p.id } }}>{p.name}</Chip>;
const line = (t: CatchupItem, project?: string) => (
  <Row key={t.id} place={{ brick: 'ticket', params: { ticket: t.id } }} title={<>{t.title} <span className="font-mono board-row-ref">{t.id}</span></>}
    meta={<>{project && <>{project} · </>}{t.words}</>} end={<Time at={t.at} />}>{t.agent ? actorChip('agent', t.agent) : undefined}</Row>
);

export function Catchup({ params, form }: { params: Params; form: Form }) {
  const since: Since = (catchupSince as readonly string[]).includes(words(params.since)) ? (words(params.since) as Since) : 'today';
  const [now] = useState(Date.now);
  const from = catchupFrom(now, since);
  const changed = useDataQuery<{ projects: CatchupProject[] | null }>(catchupQuery, { since: from }, { keep: true });
  const posted = useDataQuery<{ projectActivityHighlights: CatchupPost[] | null }>(catchupPostsQuery, { since: from }, { keep: true });
  const big = form === 'primary', head = sinceWords[since];
  const others = big && (
    <div className="board-meta">
      <span>Since {new Date(from).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
      {catchupSince.filter((s) => s !== since).map((s) => <Chip key={s} place={{ brick: 'catchup', params: { since: s } }}>{sinceWords[s].label}</Chip>)}
    </div>
  );
  if (changed.status === 'loading' || posted.status === 'loading') return big ? <>{others}<Loading /></> : <Loading />;
  if (changed.status !== 'live' || !changed.data?.projects) return big ? <>{others}<Note>The catch-up is unavailable.</Note></> : <Note>The catch-up is unavailable.</Note>;
  // The updates are a second read: without them the changed tickets are still shown, as on the desktop.
  const postsLive = posted.status === 'live' && !!posted.data?.projectActivityHighlights;
  const groups = catchupItems(changed.data.projects, postsLive ? posted.data!.projectActivityHighlights! : [], from);
  const all = groups.flatMap((g) => g.items.map((item) => ({ item, project: g.project }))).sort((a, b) => b.item.at.localeCompare(a.item.at) || a.item.id.localeCompare(b.item.id));
  const total = all.length ? `${count(all.length, 'ticket')} moved ${head.lead}` : `Nothing moved ${head.lead}`;
  const noPosts = !postsLive && <Note>Agent updates are unavailable.</Note>;
  if (form === 'compact') return <p className="board-brief">{total}{all.length ? ` in ${count(groups.length, 'project')}` : ''}</p>;
  const none = <Note>No ticket you can read has changed {head.lead}.</Note>;
  if (!big) return (
    <>
      {all.length ? <Few of={all} first={5} fit>{(shown, hidden) => <><Rows>{shown.map((a) => line(a.item, a.project.name))}</Rows><More n={hidden} /></>}</Few> : none}
      {noPosts}
    </>
  );
  return (
    <>
      <Lead>{total}</Lead>
      {others}
      {noPosts}
      {groups.length ? groups.map(({ project, items }) => (
        <Section key={project.id} title={project.name}>
          <Rows label={`${project.name} updates`}>{items.slice(0, 3).map((t) => line(t))}</Rows>
          <div className="board-meta">{projectChip(project)}{items.length > 3 && <span>More moved in {project.name}</span>}</div>
        </Section>
      )) : none}
    </>
  );
}
