import { useEffect } from 'react';
import { useRecords, type LiveRecord } from '../../data';
import { namedAgents, openAsks, orderedAgents, type OwnedAgent, type AgentPerson } from './home-model';
import type { Ask } from './model';
interface Thread extends LiveRecord {id:string;agent:string;archived:number|null;last:number;unread:boolean}
/** Desk signals have no hidden UI or message words; all sources are policy-filtered. */
export default function DeskSignals({go,onAttention}:{go(path:string):void;onAttention:(value:boolean)=>void}) {
  const roster=useRecords<OwnedAgent>('attention.ownedAgent');
  const people=useRecords<AgentPerson>('person');
  const asks=useRecords<Ask>('attention.ask');
  const threads=useRecords<Thread>('thread');
  const agents=orderedAgents(namedAgents(roster.status==='live'?roster.records:[],people.status==='live'?people.records:[]));
  const open=asks.status==='live'?openAsks(asks.records):[];
  const attention=open.length>0||(threads.status==='live'&&threads.records.some(t=>t.archived===null&&t.unread&&agents.some(a=>a.id===t.agent)));
  useEffect(()=>{onAttention(attention);return()=>onAttention(false);},[attention,onAttention]);
  useEffect(()=>{
    const shortcut=(e:KeyboardEvent)=>{
      if(!e.ctrlKey||!e.shiftKey||e.altKey||e.metaKey||!/^Digit[1-9]$/.test(e.code))return;
      const agent=agents[Number(e.code.slice(-1))-1];if(!agent)return;
      const recent=threads.status==='live'?threads.records.filter(t=>t.agent===agent.id&&t.archived===null).sort((a,b)=>b.last-a.last||a.id.localeCompare(b.id)):[];
      const thread=recent.find(t=>t.unread)??recent[0];
      e.preventDefault();go(thread?`/p/comms-preview/thread/${encodeURIComponent(thread.id.replace(/^th:/,''))}`:'/p/comms-preview');
    };
    addEventListener('keydown',shortcut);return()=>removeEventListener('keydown',shortcut);
  },[agents,threads.records,threads.status,go]);
  return null;
}
