import { useEffect, useState } from 'react';
import Tasks, { type TasksAppProps } from '../pieces/tasks';
import { useDataQuery } from './graphql';
import { useTaskCommandSubmitter } from './task-command';

const choicesQuery = `query TaskChoices { projects { id name } agents { id } }`;
type Choices = { projects: { id: string; name: string }[]; agents: { id: string }[] };
/** The registered screen supplies a real command door, never a legacy socket call. */
export default function TasksScreen(props: TasksAppProps = {}) {
  const submit = useTaskCommandSubmitter();
  const choices = useDataQuery<Choices>(choicesQuery);
  const [member, setMember] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/auth/session', { credentials: 'same-origin', signal: controller.signal }).then(async response => {
      const data: unknown = await response.json();
      if (!controller.signal.aborted && data && typeof data === 'object' && 'viewer' in data
        && data.viewer && typeof data.viewer === 'object' && 'kind' in data.viewer && data.viewer.kind === 'member'
        && 'id' in data.viewer && typeof data.viewer.id === 'string') setMember(data.viewer.id);
    }).catch(() => {});
    return () => controller.abort();
  }, []);
  const data = choices.status === 'live' ? choices.data : undefined;
  return <Tasks {...props} questionFor={props.questionFor ?? member}
    submit={props.submit ?? submit}
    people={props.people ?? [...(member ? [{ kind: 'member' as const, id: member, label: member }] : []),
      ...(data?.agents ?? []).map(agent => ({ kind: 'agent' as const, id: agent.id, label: agent.id }))]}
    projects={props.projects ?? (data?.projects ?? []).map(project => ({ id: project.id, label: project.name }))} />;
}
