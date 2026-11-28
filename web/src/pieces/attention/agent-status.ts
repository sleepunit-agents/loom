import { useMemo } from 'react';
import type { Snapshot } from '../../data/snapshot';
import { useDataQuery, type DataQuerySnapshot } from '../../data/graphql';
import type { AgentStatus } from './home-model';

export const deskAgentStatusQuery = `query DeskAgentStatus { agentStatus { agent state work changedAt } }`;
export type DeskAgentStatusData = { agentStatus: { agent: string; state: AgentStatus['state']; work: string; changedAt: string }[] };
/** Current schema rows carry one report per agent, never legacy report attachments. */
export function deskAgentStatuses(query: DataQuerySnapshot<DeskAgentStatusData>): Snapshot<AgentStatus> {
  if (query.status !== 'live') return {status:query.status,records:[]};
  if (!query.data) return {status:'loading',records:[]};
  return {status:'live',records:query.data.agentStatus.map(row=>({...row,id:row.agent,changedAt:Date.parse(row.changedAt)}))};
}
export function useDeskAgentStatuses(): Snapshot<AgentStatus> {
  const query=useDataQuery<DeskAgentStatusData>(deskAgentStatusQuery);
  return useMemo(()=>deskAgentStatuses(query),[query]);
}
