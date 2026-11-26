import { useState } from 'react';
import { useDataQuery } from '../data/graphql';
import { Facts } from './entity-facts';
import type { EntityTarget } from './entities';

/** Subject-dependent records have their own sharing rules. Only open a reader when requested. */
const related = {
  incoming: {
    label: 'Message',
    query:
      'query Related($id:String!){message:bridgeIncomingSingle(where:{id:{eq:$id}}){id channel thread text receivedAt state}}',
  },
  bridgeSend: {
    label: 'Delivery',
    query:
      'query Related($id:String!){delivery:bridgeSendsSingle(where:{id:{eq:$id}}){id channel thread text createdAt state}}',
  },
  household: {
    label: 'Program permissions and subscription providers',
    query:
      '{programSetup{owner catalogue{records operations}} subscriptionSetup{member providers machines{id name}}}',
  },

  ticket: {
    label: 'Reviews and linked work',
    query:
      'query Related($id:String!){taskReviewHistory(task:$id){change job headCommit tier round requestedAt completedAt verdict findings} taskGithubReviews(task:$id){id change login submittedAt state headCommit body} task:tasksSingle(where:{id:{eq:$id}}){description ask ifYes ifNo closeReason taskLinksByTask{dependsOn type} changeTasksByTask {change}}}',
  },
  project: {
    label: 'Project work',
    query:
      'query Related($id:String!){projectClaimStates(project:$id){agent paused at} project:projectsSingle(where:{id:{eq:$id}}){projectMembersByProject{member}}}',
  },
  change: {
    label: 'Review rounds',
    query:
      'query Related($id:String!){changeReviewHistory(change:$id){change job headCommit tier round requestedAt completedAt verdict findings} pull:changesSingle(where:{id:{eq:$id}}){changeChecksByChange{name state} changePeopleByChange{login role} changeTasksByChange{task}}}',
  },
  trigger: {
    label: 'Program, journal and runs',
    query: 'query Related($id:String!){tempoProgram(id:$id) tempoJournal(id:$id) tempoRecentRuns(id:$id)}',
  },
  episode: {
    label: 'Conversation activity',
    query:
      'query Related($id:String!){latestBridgeReceipt(conversation:$id){agent receivedAt acceptedAt replied} conversation:conversationsSingle(where:{id:{eq:$id}}){turnsByConversation(orderBy:{seq:{direction:desc,priority:0}},limit:30){seq at kind fromId outcome}}}',
  },
  post: {
    label: 'Activity posts',
    query:
      'query Related($id:String!,$agent:String!){agentActivityHistory(agent:$agent,thread:$id,after:"0",limit:30,newestFirst:true){id at words source sourceTask work{id title state}}}',
  },
  agent: {
    label: 'Current work',
    query:
      'query Related($id:String!){jobHistory(agent:$id,first:10){id title state queuedAt} recentConversations(agent:$id,limit:10){id label venue lastAt} agentActivityFeed(agent:$id,limit:6){thread title latest{id at words}}}',
  },
} as const;
export function Related({ target }: { target: EntityTarget }) {
  const entry = related[target.kind as keyof typeof related];
  const [open, setOpen] = useState(target.part?.[0] === 'related');
  const result = useDataQuery<Record<string, unknown>>(
    entry?.query ?? '{__typename}',
    { id: target.id, ...(target.kind === 'post' ? { agent: target.scope } : {}) },
    { pause: !entry || !open },
  );
  if (!entry) return null;
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{entry.label}</summary>
      {open &&
        (result.status === 'live' && result.data ? (
          <Facts row={result.data} section="related" />
        ) : (
          <p>{result.status === 'loading' ? 'Loading…' : 'Related records unavailable.'}</p>
        ))}
    </details>
  );
}
