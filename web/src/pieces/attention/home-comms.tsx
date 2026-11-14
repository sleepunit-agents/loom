import { useEffect, useState } from 'react';
import { callOnce, useRecords, type LiveRecord } from '../../data';
import { Button } from '../../kit';
import { Composer } from '../comms/composer';
import { stamp } from './time';
interface Summary { agent:string; unread:number; last?:{thread:string;title:string|null;at:number}; first?:{thread:string} }
interface Summaries { member:string; agents:string[]; summaries:Summary[] }
export const threadPath=(id:string)=>`/p/comms-preview/thread/${encodeURIComponent(id.replace(/^th:/,''))}`;
/** Refresh from policy-filtered thread changes; never subscribe to whole message feeds on Home. */
export function useHomeComms() {
 const threads=useRecords<LiveRecord & {agent:string; archived:number|null; working?:boolean; unread:boolean; last:number; title:string|null}>('thread');
 const [reading,setReading]=useState<{source:typeof threads;value:Summaries}>();
 useEffect(()=>{
  if(threads.status!=='live'){setReading(undefined);return;}
  let active=true, generation=0;
  const refresh=()=>{const current=++generation;void callOnce<Summaries>('comms.agents',{}).result.then(result=>{
   if(active&&generation===current)setReading(result.ok?{source:threads,value:{...result.value,summaries:result.value.summaries.map(s=>({...s,first:s.first?{thread:s.first.thread}:undefined}))}}:undefined);
  });};
  refresh();
  const focus=()=>refresh();const visible=()=>{if(!document.hidden)refresh();};
  globalThis.window?.addEventListener('focus',focus);globalThis.document?.addEventListener('visibilitychange',visible);
  return()=>{active=false;globalThis.window?.removeEventListener('focus',focus);globalThis.document?.removeEventListener('visibilitychange',visible);};
 },[threads]);
 return { reading: threads.status==='live'&&reading?.source===threads?reading.value:undefined, threads: threads.status==='live'?threads.records.filter(t=>t.archived===null):[], status:threads.status };
}
export function HomeConversations({agent,name,reading,go}:{agent:string;name:string;reading?:Summaries;go(path:string):void}) {
 const summary=reading?.summaries.find(s=>s.agent===agent);
 return <section aria-label={`${name} conversations`} className="grid min-w-0 gap-2"><h3>Recent conversations</h3>
 {!reading?<p>Conversations unavailable.</p>:<>
 {summary?.last?<Button variant="outline" className="h-auto min-h-9 max-w-full whitespace-normal text-left" onClick={()=>go(threadPath(summary.last!.thread))}>{summary.last.title||'Recent conversation'} · {stamp(summary.last.at)}</Button>:<p>No conversations yet.</p>}
 {summary?.unread&&summary.first?<><Button variant="outline" className="h-auto min-h-9 max-w-full whitespace-normal text-left" onClick={()=>go(threadPath(summary.first!.thread))}>{summary.unread} unread {summary.unread===1?'thread':'threads'}</Button></>:<p>No unread threads.</p>}
 </>}
 </section>;
}
export function HomeComposer({agent,name,reading,go}:{agent:string;name:string;reading?:Summaries;go(path:string):void}) {
 return <section className="desk-home-compose" aria-label={`Message ${name}`}><h3>Message {name}</h3>{reading?.agents.includes(agent)?<Composer key={`${reading.member}:${agent}`} member={reading.member} agent={agent} onOpened={id=>go(threadPath(id))} enabled />:<p>Connect to start a conversation.</p>}</section>;
}
