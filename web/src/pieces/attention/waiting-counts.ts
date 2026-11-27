/** How many questions wait on the member, in all and for each agent: the read and its checks. No component, so
 * Home (waiting.tsx) and the boards page's agent bricks count alike. */
import { useMemo } from 'react';
import { useDataQuery, type DataQuerySnapshot } from '../../data/graphql';

export const deskWaitingCountsQuery = `query DeskWaitingCounts($project:String) {
  homeComms { member }
  inboxFolders(project:$project) { needs agents { id needs } }
}`;
export interface WaitingCountsData { homeComms:{member:string}|null; inboxFolders:{needs:number;agents:{id:string;needs:number}[]} }
export interface WaitingCounts {status:DataQuerySnapshot<unknown>['status'];member?:string;total?:number;agents:ReadonlyMap<string,number>}
export function waitingCounts(query:DataQuerySnapshot<WaitingCountsData>):WaitingCounts {
  const empty=(status:WaitingCounts['status']):WaitingCounts=>({status,agents:new Map()});
  if(query.status!=='live')return empty(query.status);
  if(!query.data)return empty('loading');
  if(!query.data.homeComms?.member)return empty('denied');
  const folders=query.data.inboxFolders;
  if(!folders||!Number.isSafeInteger(folders.needs)||folders.needs<0||!Array.isArray(folders.agents))return empty('offline');
  const agents=new Map<string,number>();
  for(const row of folders.agents){
    if(typeof row.id!=='string'||agents.has(row.id)||!Number.isSafeInteger(row.needs)||row.needs<0)return empty('offline');
    agents.set(row.id,row.needs);
  }
  return {status:'live',member:query.data.homeComms.member,total:folders.needs,agents};
}
/** Counts and signals never select message wording. */
export function useDeskWaitingCounts(project?:string):WaitingCounts {
  const query=useDataQuery<WaitingCountsData>(deskWaitingCountsQuery,project ? {project} : undefined);
  return useMemo(()=>waitingCounts(query),[query]);
}
