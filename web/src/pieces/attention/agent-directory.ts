import { useMemo } from 'react';
import type { Snapshot } from '../../data';
import { useDataQuery, type DataQuerySnapshot } from '../../data/graphql';
import type { AgentPerson } from './home-model';

/** Only shared directory identity, never relationship cards or private details. */
export const deskAgentDirectoryQuery = `query DeskAgentDirectory {
  memoryPeopleAccess { directory }
  memoryPeople { id slug agent name kind }
}`;
export interface DeskAgentDirectoryData {
  memoryPeopleAccess: { directory: boolean } | null;
  memoryPeople: { id:string; slug:string; agent:string|null; name:string; kind:string }[] | null;
}
export function deskAgentDirectory(query: DataQuerySnapshot<DeskAgentDirectoryData>): Snapshot<AgentPerson> {
  if (query.status !== 'live') return {status:query.status,records:[]};
  if (!query.data) return {status:'loading',records:[]};
  if (!query.data.memoryPeopleAccess?.directory) return {status:'denied',records:[]};
  if (!query.data.memoryPeople) return {status:'offline',records:[]};
  return {status:'live',records:query.data.memoryPeople.filter(row=>row.agent===null && row.kind==='agent' && row.id===`commons:${row.slug}` && row.name.trim())
    .map(({id,slug,name})=>({id,slug,name,kind:'agent'}))};
}
export function useDeskAgentDirectory(): Snapshot<AgentPerson> {
  const query=useDataQuery<DeskAgentDirectoryData>(deskAgentDirectoryQuery);
  return useMemo(()=>deskAgentDirectory(query),[query]);
}
