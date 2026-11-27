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
import { Chip, Loading, Unavailable, repositoryKey, words, type Params } from './brick-kit';
import type { Form } from './layout';

type Contribution = { id: string; agent: string; name: string; goal: string | null; summary: string | null };
export const projectQuery = 'query BrickProject($id:String!){project:projectsSingle(where:{id:{eq:$id}}){name goal lifecycle projectMembersByProject{member}}}';
const notesQuery = `query WorkProjectNotes($project:String!){
    workProjectContributions(project:$project){id agent name goal summary}
  }`;
const claimsQuery = 'query WorkClaimStates($project:String!){projectClaimStates(project:$project){agent paused revision at}}';
/** What a board takes as a reference (src/core/boards/bricks.ts, `ref` and `person`): anything else is not offered as a chip. */
const placeable = (id: string) => /^[A-Za-z0-9][A-Za-z0-9:._\/@-]{0,119}$/.test(id);
const memberId = (id: string) => /^[a-z0-9][a-z0-9._-]{0,99}$/.test(id);

function Repositories({ card, project }: { card: string; project: string }) {
  const read = useMemoryRecord(memoryQueries.project(card));
  const repos = [...new Set((read.records[0]?.card.links.repos ?? []).map(repositoryKey))].filter(placeable);
  if (!repos.length) return null;
  return <>{repos.map((repository) => <Chip key={repository} place={{ brick: 'repository', params: { repository, project } }}>{repository}</Chip>)}</>;
}

export function Project({ params, form }: { params: Params; form: Form }) {
  const id = words(params.project), big = form === 'primary';
  const read = useDataQuery<{ project: { name: string; goal: string | null; lifecycle: string; projectMembersByProject?: { member: string }[] } | null }>(projectQuery, { id }, { keep: true });
  const notes = useDataQuery<{ workProjectContributions: Contribution[] }>(notesQuery, { project: id }, { keep: true, pause: form === 'compact' });
  const claims = useDataQuery<{ projectClaimStates: { agent: string }[] }>(claimsQuery, { project: id }, { keep: true, pause: form === 'compact' });
  const p = read.data?.project;
  if (read.status === 'loading') return <Loading />;
  if (read.status !== 'live' || !p) return <Unavailable what="project" />;
  if (form === 'compact') return <p className="board-brief"><span className="board-state">{p.lifecycle}</span> {p.goal || p.name}</p>;
  const cards = notes.status === 'live' ? notes.data?.workProjectContributions ?? [] : [];
  const agents = [...new Set([...(claims.status === 'live' ? claims.data?.projectClaimStates ?? [] : []), ...cards].map((row) => row.agent))].filter(placeable);
  const members = [...new Set((p.projectMembersByProject ?? []).map((edge) => edge.member))];
  return (
    <>
      {big && <p className="board-lead">{p.name}</p>}
      {p.goal ? <Reply words={p.goal} /> : <p className="text-muted-foreground">No goal written.</p>}
      <div className="board-line">
        <span className="board-state">{p.lifecycle}</span>
        <Chip place={{ brick: 'lanes', params: { project: id } }}>Lanes</Chip>
        <Chip place={{ brick: 'trend', params: { project: id, days: 30 } }}>Trend</Chip>
      </div>
      {(members.length > 0 || agents.length > 0) && (
        <div className="board-line" role="group" aria-label="On this project">
          <span className="text-muted-foreground">On it</span>
          {members.map((m) => (memberId(m) ? <Chip key={'m:' + m} place={{ brick: 'person', params: { person: 'member:' + m } }}>{displayName(m)}</Chip> : <span key={'m:' + m}>{displayName(m)}</span>))}
          {agents.map((a) => <Chip key={'a:' + a} place={{ brick: 'agent', params: { agent: a } }}>{displayName(a)}</Chip>)}
        </div>
      )}
      {big && cards.length > 0 && (
        <dl style={{ marginTop: '.8rem' }}>
          {cards.map((c) => (
            <div key={c.id}>
              <dt>{displayName(c.agent)} · {c.name}</dt>
              <dd>
                {c.goal && <p>{c.goal}</p>}
                {c.summary && <p className="text-muted-foreground">{c.summary}</p>}
                <div className="board-line" data-repositories=""><Repositories card={c.id} project={id} /></div>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
}
