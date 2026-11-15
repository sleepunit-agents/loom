import { useMemo } from 'react';
import { useDataQuery, type DataQuerySnapshot } from '../../data/graphql';
interface Summary { agent:string; unread:number; last?:{thread:string;title:string|null;at:number}; first?:{thread:string} }
export interface Summaries { member:string; agents:string[]; summaries:Summary[] }
export interface HomeCommsData { homeComms: { member:string; agents:string[]; summaries:{agent:string;unread:number;last:{thread:string;title:string;at:string}|null;first:{thread:string}|null}[] } | null }
export const homeCommsQuery = `query DeskHomeComms {
  homeComms { member agents summaries { agent unread last { thread title at } first { thread } } }
}`;
export const threadPath=(id:string)=>`/p/comms-preview/thread/${encodeURIComponent(id.replace(/^th:/,''))}`;
/** Current authenticated mailbox summary only; no message words or thread-page counts. */
export function homeComms(query: DataQuerySnapshot<HomeCommsData>): {reading?:Summaries;status:DataQuerySnapshot<HomeCommsData>['status']} {
 if(query.status!=='live')return {status:query.status};
 if(!query.data)return {status:'loading'};
 const value=query.data.homeComms;
 if(!value)return {status:'denied'};
 return {status:'live',reading:{member:value.member,agents:value.agents,summaries:value.summaries.map(s=>({
  agent:s.agent,unread:s.unread,first:s.first?{thread:s.first.thread}:undefined,
  last:s.last?{thread:s.last.thread,title:s.last.title,at:Date.parse(s.last.at)}:undefined,
 }))}};
}
export function useHomeComms() {
 const query=useDataQuery<HomeCommsData>(homeCommsQuery);
 return useMemo(()=>homeComms(query),[query]);
}
