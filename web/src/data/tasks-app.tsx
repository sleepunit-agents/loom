import { useContext } from 'react';
import { DeskMember } from '../signin/desk-member';
import Tasks, { type TasksAppProps } from '../pieces/tasks';
import { useDataQuery } from './graphql';
import { useTaskCommandSubmitter } from './task-command';
import { useAgentNames } from './names';
import { useHouseholdZone } from './zone';
import { displayName } from '../kit/words';

import { taskChoicesQuery } from '../pieces/tasks/query';
import { liveAgents } from './live-agents';
type Choices = { projects: { id: string; name: string; projectMembersByProject: {member:string}[] }[]; agents: { id: string; removedAt?: string | null }[]; members: { id: string }[] };
/** The registered screen supplies a real command door, never a legacy socket call. */
export default function TasksScreen(props: TasksAppProps = {}) {
  const submit = useTaskCommandSubmitter();
  const choices = useDataQuery<Choices>(taskChoicesQuery);
  const names = useAgentNames(), zone = useHouseholdZone();
  const member = useContext(DeskMember);
  const data = choices.status === 'live' ? choices.data : undefined;
  const agents = liveAgents(data?.agents ?? []);
  return <Tasks {...props} liveAgentIds={new Set(agents.map(agent => agent.id))} questionFor={props.questionFor ?? member}
    submit={props.submit ?? submit}
    people={props.people ?? [...Array.from(new Set([...(member ? [member] : []), ...(data?.members ?? []).map(person=>person.id), ...(data?.projects ?? []).flatMap(project=>project.projectMembersByProject.map(edge=>edge.member))]), id=>({kind:'member' as const,id,label:displayName(id,names)})),
      // Whom a task may be given to: agents in use (data/live-agents.ts).
      ...agents.map(agent => ({ kind: 'agent' as const, id: agent.id, label: displayName(agent.id,names) }))]}
    names={props.names ?? names} zone={props.zone ?? zone}
    projects={props.projects ?? (data?.projects ?? []).map(project => ({ id: project.id, label: project.name }))} />;
}
