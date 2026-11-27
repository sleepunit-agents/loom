/** The `sharing` brick: the desktop's Sharing app (pieces/sharing) on a board, read-only, for a household owner.
 * It reads that app's one selection (pieces/sharing/model.ts); `householdSharing` answers an owner and nobody
 * else, and anyone else is told it is unavailable. A project's sharing is changed on the desktop by a message to
 * the agent, who files the proposal: here that is said, and the conversation is beside the board. */
import { useDataQuery } from '../data/graphql';
import { householdSharingQuery, sharingCount, type HouseholdSharing } from '../pieces/sharing/model';
import { isMember, isRef } from './admin-data';
import { Chip, Fact, Facts, Lead, Loading, Note, Row, Rows, Unavailable, count, repositoryKey, type BodyProps } from './brick-kit';

export function Sharing({ form }: BodyProps) {
  const primary = form === 'primary';
  const feed = useDataQuery<{ householdSharing: HouseholdSharing | null }>(householdSharingQuery, undefined, { keep: true });
  if (feed.status === 'loading') return <Loading />;
  const sharing = feed.status === 'live' ? feed.data?.householdSharing : null;
  if (!sharing || !Array.isArray(sharing.projects)) return <Unavailable what="project sharing" />;
  const summary = `${count(sharing.projects.length, 'project')} · ${count(sharing.members.length, 'member')} · ${count(sharing.agents.length, 'agent')}`;
  if (form === 'compact') return <p className="board-brief">{summary}</p>;
  const cap = primary ? 60 : 4;
  return (
    <>
      <Lead>{summary}</Lead>
      {!sharing.projects.length && <Note>No projects to share</Note>}
      <Rows>
        {sharing.projects.slice(0, cap).map((project) => {
          const who = (
            <>
              {project.members.map((id) => (isMember(id) ? <Chip key={id} place={{ brick: 'person', params: { person: 'member:' + id } }}>{id}</Chip> : <span key={id}>{id}</span>))}
              {project.agents.map((id) => (isRef(id) ? <Chip key={id} place={{ brick: 'agent', params: { agent: id } }}>{id}</Chip> : <span key={id}>{id}</span>))}
              {!project.members.length && !project.agents.length && <span>Nobody is on it</span>}
            </>
          );
          return (
            <Row key={project.id} title={project.name} place={isRef(project.id) ? { brick: 'project', params: { project: project.id } } : undefined} end={<span>{sharingCount(project)}</span>}>
              {primary && project.goal && <Note>{project.goal}</Note>}
              {primary && (
                <Facts>
                  <Fact label="On it">{who}</Fact>
                  <Fact label="Repositories">
                    {project.repositories.map((raw) => {
                      const key = repositoryKey(raw);
                      return isRef(key) && isRef(project.id) ? <Chip key={raw} place={{ brick: 'repository', params: { repository: key, project: project.id } }}>{key}</Chip> : <span key={raw}>{raw}</span>;
                    })}
                    {!project.repositories.length && <span className="board-note">None</span>}
                  </Fact>
                </Facts>
              )}
            </Row>
          );
        })}
      </Rows>
      {sharing.projects.length > cap && <Note>and {sharing.projects.length - cap} more</Note>}
      {primary && <Note>To create a project or change who is on one, ask the agent in the conversation: it proposes the change and you answer it in the Inbox.</Note>}
    </>
  );
}
