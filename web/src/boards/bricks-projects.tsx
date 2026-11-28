/** The `projects` brick: the desktop's Work project directory (pieces/work/query.ts, `workHomeQuery`'s `projects`,
 * ordered by name) on a board, each project a row that places its `project` brick. It reads the shared `projects`
 * table, whose rule (src/policy.ts, `rules.project`) answers a household owner every project and any other member the
 * projects they are in, so a member who is not an owner sees theirs; that rule is the only thing that decides what
 * is listed. One live read, bounded to the first 200 by name: a longer list says so.
 *
 * Big, the member can search the list: what is typed is state of this drawn brick, applied on Enter or Search to
 * the rows loom already sent, never a parameter, never told to the board and never sent anywhere. */
import { useState, type FormEvent } from 'react';
import { useDataQuery } from '../data/graphql';
import { Action, Few, Lead, Loading, More, Note, Row, Rows, State, Unavailable, count, plain, type BodyProps, type Tone } from './brick-kit';

/** At most this many are listed; one more is asked for, to know there are more. */
export const PROJECTS_SHOWN = 200;
export const projectsQuery = `query BrickProjects{projects(orderBy:{name:{direction:asc,priority:1},id:{direction:asc,priority:0}},limit:${PROJECTS_SHOWN + 1}){id name goal lifecycle}}`;
type ProjectRow = { id: string; name: string; goal: string | null; lifecycle: string };
/** What a board takes as a reference (src/core/boards/bricks/kit.ts, `ref`): a project with any other id is listed with no chip. */
const placeable = (id: string) => /^[A-Za-z0-9][A-Za-z0-9:._\/@-]{0,119}$/.test(id);
const tone = (lifecycle: string): Tone => (lifecycle === 'active' ? 'working' : 'muted');
/** The words searched for: every one must be in the project's name, id or goal, in any case. */
const terms = (typed: string) => typed.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 20);
const matches = (p: ProjectRow, words: string[]) => {
  const text = `${p.name} ${p.id} ${p.goal ?? ''}`.toLowerCase();
  return words.every((w) => text.includes(w));
};

export function Projects({ form }: BodyProps) {
  const big = form === 'primary';
  const read = useDataQuery<{ projects: ProjectRow[] | null }>(projectsQuery, undefined, { keep: true });
  const [typed, setTyped] = useState(''), [asked, setAsked] = useState('');
  if (read.status === 'loading') return <Loading />;
  const rows = read.status === 'live' ? read.data?.projects : null;
  if (!Array.isArray(rows)) return <Unavailable what="project directory" />;
  const all = rows.slice(0, PROJECTS_SHOWN), beyond = rows.length > PROJECTS_SHOWN;
  const active = all.filter((p) => p.lifecycle === 'active').length;
  const summary = `${beyond ? `${PROJECTS_SHOWN}+ projects` : count(all.length, 'project')} · ${active} active`;
  if (form === 'compact') return <p className="board-brief">{summary}</p>;
  const searched = big && asked ? terms(asked) : [];
  const shown = searched.length ? all.filter((p) => matches(p, searched)) : all;
  const submit = (e: FormEvent) => { e.preventDefault(); setAsked(typed.trim()); };
  return (
    <>
      <Lead>{summary}</Lead>
      {big && (
        <form className="board-search" role="search" aria-label="Search projects" onSubmit={submit}>
          <input className="board-input" type="search" aria-label="Search projects" placeholder="Search projects…" maxLength={400} value={typed}
            onChange={(e) => { setTyped(e.target.value); if (!e.target.value.trim()) setAsked(''); }} />
          <Action submit disabled={!typed.trim()}>Search</Action>
          {asked && <Action kind="quiet" onClick={() => { setTyped(''); setAsked(''); }}>Show every project</Action>}
        </form>
      )}
      {shown.length > 0 && (
        <Few of={shown} first={big ? shown.length : 6} fit={!big}>{(some, hidden) => <><Rows beside label="Projects">{some.map((p) => (
          <Row key={p.id} place={placeable(p.id) ? { brick: 'project', params: { project: p.id } } : undefined} title={p.name}
            meta={big && p.goal ? plain(p.goal) : undefined} end={<State tone={tone(p.lifecycle)}>{p.lifecycle}</State>} />
        ))}</Rows><More n={hidden} /></>}</Few>
      )}
      {!shown.length && <Note>{searched.length ? 'No project matches. Every word must be in its name or goal.' : 'No projects you may read yet.'}</Note>}
      {beyond && <Note>The first {PROJECTS_SHOWN} by name are listed{big ? ', and only they are searched' : ''}.</Note>}
    </>
  );
}
