/** The `project` brick: the project's goal and lifecycle, its members (the project's own row), the agents on it
 * (those whose claims there the member may direct, `projectClaimStates`, and those with a card for it) and what
 * each calls it (`workProjectContributions`, the desktop's project notes: pieces/work/project-notes.tsx)
 * and, in the big form, the repositories each agent's project card names (`memoryProject`, memory/queries.ts),
 * each a chip that places the `repository` brick in this project. Loom gives a member no read of the repositories
 * bound to a project itself (`project_repositories` is not in the query layer), so a repository is shown only
 * where an agent's card names it. It has no action. */
import { useDataQuery } from '../data/graphql';
import { displayName } from '../kit/words';
import { memoryQueries } from '../memory/queries';
import { useMemoryRecord } from '../memory/query';
import { Reply } from '../pair/reply';
import { Chip, Fact, Facts, Lead, Loading, Note, Row, Rows, Section, State, Unavailable, repositoryKey, words, type Params, type Tone } from './brick-kit';
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

export function Project({ params, form }: { params: Params; form: Form }) {
  const id = words(params.project), big = form === 'primary';
  const read = useDataQuery<{ project: { name: string; goal: string | null; lifecycle: string; projectMembersByProject?: { member: string }[] } | null }>(projectQuery, { id }, { keep: true });
  const notes = useDataQuery<{ workProjectContributions: Contribution[] }>(notesQuery, { project: id }, { keep: true, pause: form === 'compact' });
  const claims = useDataQuery<{ projectClaimStates: { agent: string }[] }>(claimsQuery, { project: id }, { keep: true, pause: form === 'compact' });
  const p = read.data?.project;
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live' || !p) return <Unavailable what="project" />;
  if (form === 'compact') return <p className="board-brief"><State tone={tone(p.lifecycle)}>{p.lifecycle}</State> {p.goal || p.name}</p>;
  const cards = notes.status === 'live' ? notes.data?.workProjectContributions ?? [] : [];
  const agents = [...new Set([...(claims.status === 'live' ? claims.data?.projectClaimStates ?? [] : []), ...cards].map((row) => row.agent))].filter(placeable);
  const members = [...new Set((p.projectMembersByProject ?? []).map((edge) => edge.member))];
  return (
    <>
      <Lead>{p.name}</Lead>
      <div className="board-meta">
        <State tone={tone(p.lifecycle)}>{p.lifecycle}</State>
        <Chip place={{ brick: 'lanes', params: { project: id } }}>Lanes</Chip>
        <Chip place={{ brick: 'trend', params: { project: id, days: 30 } }}>Trend</Chip>
      </div>
      {p.goal ? <div className="board-project-goal"><Reply words={p.goal} /></div> : <Note>No goal written.</Note>}
      {(members.length > 0 || agents.length > 0) && (
        <div role="group" aria-label="On this project">
          <Facts>
            <Fact label="On it">
              {members.map((m) => (memberId(m) ? <Chip key={'m:' + m} place={{ brick: 'person', params: { person: 'member:' + m } }}>{displayName(m)}</Chip> : <span key={'m:' + m}>{displayName(m)}</span>))}
              {agents.map((a) => <Chip key={'a:' + a} place={{ brick: 'agent', params: { agent: a } }}>{displayName(a)}</Chip>)}
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
    </>
  );
}
