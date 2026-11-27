/** The `sharing` brick: the desktop's Sharing app (pieces/sharing) on a board, read-only, for a household owner.
 * It reads that app's one selection (pieces/sharing/model.ts); `householdSharing` answers an owner and nobody
 * else, and anyone else is told it is unavailable. A project's sharing is changed on the desktop by a message to
 * the agent, who files the proposal: here that is said, and the conversation is beside the board. */
import { useDataQuery } from '../data/graphql';
import { householdSharingQuery, sharingCount, type HouseholdSharing } from '../pieces/sharing/model';
import { isMember, isRef } from './admin-data';
import { Chip, Loading, Unavailable, repositoryKey, type BodyProps } from './brick-kit';

export function Sharing({ form }: BodyProps) {
  const primary = form === 'primary';
  const feed = useDataQuery<{ householdSharing: HouseholdSharing | null }>(householdSharingQuery, undefined, { keep: true });
  if (feed.status === 'loading') return <Loading />;
  const sharing = feed.status === 'live' ? feed.data?.householdSharing : null;
  if (!sharing || !Array.isArray(sharing.projects)) return <Unavailable what="project sharing" />;
  const count = `${sharing.projects.length} project${sharing.projects.length === 1 ? '' : 's'} · ${sharing.members.length} member${sharing.members.length === 1 ? '' : 's'} · ${sharing.agents.length} agent${sharing.agents.length === 1 ? '' : 's'}`;
  if (form === 'compact') return <p className="board-brief">{count}</p>;
  const cap = primary ? 60 : 6;
  return (
    <>
      <p className="board-line"><span>{count}</span></p>
      {!sharing.projects.length && <p className="text-muted-foreground">No projects to share</p>}
      {sharing.projects.slice(0, cap).map((project) => (
        <div key={project.id} style={{ marginBottom: '.6rem' }}>
          <div className="board-line">
            {isRef(project.id) ? <Chip place={{ brick: 'project', params: { project: project.id } }}>{project.name}</Chip> : <strong>{project.name}</strong>}
            <span className="text-muted-foreground">{sharingCount(project)}</span>
          </div>
          {primary && project.goal && <p className="text-muted-foreground">{project.goal}</p>}
          <div className="board-line">
            {project.members.map((id) => (isMember(id) ? <Chip key={id} place={{ brick: 'person', params: { person: 'member:' + id } }}>{id}</Chip> : <span key={id}>{id}</span>))}
            {project.agents.map((id) => (isRef(id) ? <Chip key={id} place={{ brick: 'agent', params: { agent: id } }}>{id}</Chip> : <span key={id}>{id}</span>))}
            {!project.members.length && !project.agents.length && <span className="text-muted-foreground">Nobody is on it</span>}
          </div>
          {primary && (
            <div className="board-line">
              <span className="text-muted-foreground">Repositories</span>
              {project.repositories.map((raw) => {
                const key = repositoryKey(raw);
                return isRef(key) && isRef(project.id) ? <Chip key={raw} place={{ brick: 'repository', params: { repository: key, project: project.id } }}>{key}</Chip> : <span key={raw}>{raw}</span>;
              })}
              {!project.repositories.length && <span className="text-muted-foreground">None</span>}
            </div>
          )}
        </div>
      ))}
      {sharing.projects.length > cap && <p className="text-muted-foreground">and {sharing.projects.length - cap} more</p>}
      {primary && <p className="text-muted-foreground">To create a project or change who is on one, ask the agent in the conversation: it proposes the change and you answer it in the Inbox.</p>}
    </>
  );
}
