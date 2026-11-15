import { useMemo } from 'react';
import type { Snapshot, LiveRecord } from '../../data';
import { useDataQuery, type DataQuerySnapshot } from '../../data/graphql';

export interface AgentProfile extends LiveRecord { agent:string; description?:string; requestedAt?:string }
export const deskAgentProfilesQuery = `query DeskAgentProfiles { agents { id about aboutAskedAt } }`;
export interface DeskAgentProfilesData { agents:{id:string;about:string;aboutAskedAt:string|null}[] }
/** Read visibility supplies descriptions, never permission to edit them. */
export function deskAgentProfiles(query: DataQuerySnapshot<DeskAgentProfilesData>): Snapshot<AgentProfile> {
  if(query.status!=='live')return {status:query.status,records:[]};
  if(!query.data)return {status:'loading',records:[]};
  return {status:'live',records:query.data.agents.map(row=>({id:row.id,agent:row.id,...(row.about?{description:row.about}:{}),...(row.aboutAskedAt?{requestedAt:row.aboutAskedAt}:{})}))};
}
export function useDeskAgentProfiles(): Snapshot<AgentProfile> {
  const query=useDataQuery<DeskAgentProfilesData>(deskAgentProfilesQuery);
  return useMemo(()=>deskAgentProfiles(query),[query]);
}
