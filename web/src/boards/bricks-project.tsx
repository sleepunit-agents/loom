/** The `project` brick: the project's goal and lifecycle, its members (the project's own row), the agents on it
 * (those whose claims there the member may direct, `projectClaimStates`, and those with a card for it) and what
 * each calls it (`workProjectContributions`, the desktop's project notes: pieces/work/project-notes.tsx)
 * and, in the big form, the repositories each agent's project card names (`memoryProject`, memory/queries.ts),
 * each a chip that places the `repository` brick in this project. Loom gives a member no read of the repositories
 * bound to a project itself (`project_repositories` is not in the query layer), so a repository is shown only
 * where an agent's card names it. It has no action.
 *
 * Big, it has the agents' notes on the project, closed until the member opens them: nothing of them is read before.
 * Opened, each card's Memories section is asked once, in one request (`memoryProject`: the previews loom gives a card,
 * each agent's latest twenty and ten most used), and searched on Enter or Search over those previews; a note opened
 * is read once (`memoryProjectMemory`, the desktop's note reader). Loom has no read that searches all of an agent's
 * notes, and none is added here. Neither is a live read, the words searched for go nowhere, and closing the
 * section, leaving the big form or a change of project drops what was read. */
import { useState, type FormEvent } from 'react';
import { useDataOnce, useDataQuery } from '../data/graphql';
import { displayName } from '../kit/words';
import { memoryQueries } from '../memory/queries';
import { useMemoryRecord } from '../memory/query';
import { Reply } from '../pair/reply';
import { Action, Chip, Excerpt, Fact, Facts, Few, Fold, Lead, Loading, More, Note, Opened, Opens, Problem, Row, Rows, Section, State, Time, Unavailable, count, plain, repositoryKey, words, type Params, type Tone } from './brick-kit';
import type { Form } from './layout';

type Contribution = { id: string; agent: string; name: string; goal: string | null; summary: string | null };
export const projectQuery = 'query BrickProject($id:String!){project:projectsSingle(where:{id:{eq:$id}}){name goal lifecycle projectMembersByProject{member}}}';
const notesQuery = `query WorkProjectNotes($project:String!){
    workProjectContributions(project:$project){id agent name goal summary}
  }`;
const claimsQuery = 'query WorkClaimStates($project:String!){projectClaimStates(project:$project){agent paused revision at}}';
/** What a board takes as a reference (src/core/boards/bricks.ts, `ref` and `person`): anything else is not offered as a chip. */
const placeable = (id: string) => /^[A-Za-z0-9][A-Za-z0-9:._\/@-]{0,119}$/.test(id);
const tone = (lifecycle: string): Tone => (lifecycle === 'active' ? 'working' : 'muted');
const memberId = (id: string) => /^[a-z0-9][a-z0-9._-]{0,99}$/.test(id);

function Repositories({ card, project }: { card: string; project: string }) {
  const read = useMemoryRecord(memoryQueries.project(card));
  const repos = [...new Set((read.records[0]?.card.links.repos ?? []).map(repositoryKey))].filter(placeable);
  if (!repos.length) return null;
  return <div className="board-meta" data-repositories="">{repos.map((repository) => <Chip key={repository} place={{ brick: 'repository', params: { repository, project } }}>{repository}</Chip>)}</div>;
}

/** At most this many agents' cards are asked for their notes, in one request. */
export const NOTE_CARDS = 20;
/** One card's Memories section, for each card asked: `c0`, `c1`, … in the order of the cards. */
export const notesSearchQuery = (n: number) => `query BrickProjectNotes(${Array.from({ length: n }, (_, i) => `$c${i}:String!`).join(',')}){${
  Array.from({ length: n }, (_, i) => `c${i}:memoryProject(id:$c${i}){id agent sections{key available error total items{title ref when status}}}`).join(' ')}}`;
export const noteQuery = 'query BrickProjectNote($id:String!){note:memoryProjectMemory(id:$id){id agent title content category created}}';
type Preview = { title: string; ref: string | null; when: string | null; status: string | null };
type NotesCard = { id: string; agent: string; sections: { key: string; available: boolean | null; error: string | null; total: number | null; items: Preview[] | null }[] | null } | null;
type Found = { id: string; agent: string; title: string; when: string | null; category: string | null };
/** What memoryProjectMemory takes (src/pieces/mind/projects-query.ts, `validId`): a card is asked only for an id of that shape. */
const cardId = (id: string) => /^[^:\s]{1,100}:[^\s]{1,199}$/.test(id);
const terms = (typed: string) => typed.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 20);

/** One note, read once when the member opens it. */
function NoteWords({ id }: { id: string }) {
  const read = useDataOnce<{ note: { id: string; agent: string; title: string; content: string; category: string; created: string } | null }>(noteQuery, { id });
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live') return <Problem>This note could not be read. Close it and open it again to try again.</Problem>;
  const n = read.data?.note;
  if (!n || n.id !== id) return <Note>This note is no longer there.</Note>;
  return <div className="board-project-said"><Reply words={n.content} /></div>;
}

function FoundNote({ note }: { note: Found }) {
  const [open, setOpen] = useState(false);
  return (
    <Row title={<Opens open={open} onToggle={() => setOpen(!open)}>{note.title}</Opens>} meta={<>{displayName(note.agent)}{note.category ? <> · {note.category}</> : null}</>} end={<Time at={note.when} />}>
      {open ? <Opened><NoteWords id={note.id} /></Opened> : undefined}
    </Row>
  );
}

/** The cards' notes, asked once when this is drawn (the section opened), and searched here. */
function NotesFound({ cards }: { cards: string[] }) {
  const read = useDataOnce<Record<string, NotesCard>>(notesSearchQuery(cards.length), Object.fromEntries(cards.map((id, i) => ['c' + i, id])));
  const [typed, setTyped] = useState(''), [asked, setAsked] = useState('');
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live' || !read.data) return <Problem>The agents' notes could not be read. Close them and open them again to try again.</Problem>;
  const notes: Found[] = [];
  let total = 0, missing = 0;
  cards.forEach((asked, i) => {
    const card = read.data![`c${i}`];
    if (!card || card.id !== asked) return;
    const section = (card.sections ?? []).find((s) => s.key === 'memories');
    if (!section || !section.available || section.error) { missing++; return; }
    total += section.total ?? 0;
    for (const item of section.items ?? []) if (item.ref) notes.push({ id: `${card.agent}:${item.ref}`, agent: card.agent, title: item.title, when: item.when, category: item.status });
  });
  const searched = terms(asked);
  const shown = searched.length ? notes.filter((n) => searched.every((w) => `${n.title} ${n.agent} ${n.category ?? ''}`.toLowerCase().includes(w))) : notes;
  const submit = (e: FormEvent) => { e.preventDefault(); setAsked(typed.trim()); };
  return (
    <>
      <form className="board-search" role="search" aria-label="Search the agents' notes" onSubmit={submit}>
        <input className="board-input" type="search" aria-label="Search the agents' notes" placeholder="Search the agents' notes…" maxLength={400} value={typed}
          onChange={(e) => { setTyped(e.target.value); if (!e.target.value.trim()) setAsked(''); }} />
        <Action submit disabled={!typed.trim()}>Search</Action>
        {asked && <Action kind="quiet" onClick={() => { setTyped(''); setAsked(''); }}>Show every note</Action>}
      </form>
      {shown.length > 0 && <Rows label="Agents' notes">{shown.map((n) => <FoundNote key={n.id} note={n} />)}</Rows>}
      {!shown.length && <Note>{searched.length ? 'No note matches. Every word must be in its title or its first words.' : 'No notes on it that you may read.'}</Note>}
      {notes.length > 0 && <Note>Each agent's latest and most-used notes: {notes.length} of {count(total, 'note')}.</Note>}
      {missing > 0 && <Note>{count(missing, "agent's notes", "agents' notes")} could not be read.</Note>}
    </>
  );
}

/** The agents' notes on the project, closed until the member opens them. Closing them forgets what was read. */
function AgentNotes({ cards }: { cards: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Fold title="Agents' notes" open={open} onToggle={() => setOpen(!open)}><NotesFound cards={cards} /></Fold>
  );
}

export function Project({ params, form }: { params: Params; form: Form }) {
  const id = words(params.project), big = form === 'primary';
  const read = useDataQuery<{ project: { name: string; goal: string | null; lifecycle: string; projectMembersByProject?: { member: string }[] } | null }>(projectQuery, { id }, { keep: true });
  const notes = useDataQuery<{ workProjectContributions: Contribution[] }>(notesQuery, { project: id }, { keep: true, pause: form === 'compact' });
  const claims = useDataQuery<{ projectClaimStates: { agent: string }[] }>(claimsQuery, { project: id }, { keep: true, pause: form === 'compact' });
  const p = read.data?.project;
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live' || !p) return <Unavailable what="project" />;
  if (form === 'compact') return <p className="board-brief"><State tone={tone(p.lifecycle)}>{p.lifecycle}</State> <b>{p.name}</b>{p.goal ? <> {plain(p.goal)}</> : null}</p>;
  const cards = notes.status === 'live' ? notes.data?.workProjectContributions ?? [] : [];
  const agents = [...new Set([...(claims.status === 'live' ? claims.data?.projectClaimStates ?? [] : []), ...cards].map((row) => row.agent))].filter(placeable);
  const members = [...new Set((p.projectMembersByProject ?? []).map((edge) => edge.member))];
  const on = [...members.map((id) => ({ kind: 'member', id })), ...agents.map((id) => ({ kind: 'agent', id }))];
  return (
    <>
      <Lead>{p.name}</Lead>
      <div className="board-meta">
        <State tone={tone(p.lifecycle)}>{p.lifecycle}</State>
        <Chip place={{ brick: 'lanes', params: { project: id } }}>Lanes</Chip>
        <Chip place={{ brick: 'trend', params: { project: id, days: 30 } }}>Trend</Chip>
      </div>
      {!p.goal ? <Note>No goal written.</Note> : big ? <div className="board-project-goal"><Reply words={p.goal} /></div> : <Excerpt><div className="board-project-goal"><Reply words={p.goal} /></div></Excerpt>}
      {on.length > 0 && (
        <div role="group" aria-label="On this project">
          <Facts>
            <Fact label="On it">
              <Few of={on} first={big ? on.length : 4} fit={!big}>{(shown, hidden) => <>
                {shown.map(({ kind, id: who }) => (kind === 'agent' ? <Chip key={'a:' + who} place={{ brick: 'agent', params: { agent: who } }}>{displayName(who)}</Chip>
                  : memberId(who) ? <Chip key={'m:' + who} place={{ brick: 'person', params: { person: 'member:' + who } }}>{displayName(who)}</Chip> : <span key={'m:' + who}>{displayName(who)}</span>))}
                <More n={hidden} />
              </>}</Few>
            </Fact>
          </Facts>
        </div>
      )}
      {big && cards.length > 0 && (
        <Section title="What the agents call it">
          <Rows>
            {cards.map((c) => (
              <Row key={c.id} title={<>{displayName(c.agent)} · {c.name}</>} meta={<>{c.goal && <span className="board-project-said">{c.goal}</span>}{c.summary && <span className="board-project-said">{c.summary}</span>}</>}>
                <Repositories card={c.id} project={id} />
              </Row>
            ))}
          </Rows>
        </Section>
      )}
      {big && cards.some((c) => cardId(c.id)) && <AgentNotes key={id} cards={[...new Set(cards.map((c) => c.id).filter(cardId))].slice(0, NOTE_CARDS)} />}
    </>
  );
}
