import { useDeskAgentDirectory } from './agent-directory';
import { useHomeComms, threadPath } from './home-comms-data';
import { useDeskRoster } from './roster';
import { useEffect } from 'react';
import { useRecords } from '../../data';
import { namedAgents, openAsks, orderedAgents } from './home-model';
import type { Ask } from './model';
/** Desk signals have no hidden UI or message words; all sources are policy-filtered. */
export default function DeskSignals({go,onAttention}:{go(path:string):void;onAttention:(value:boolean)=>void}) {
  const roster=useDeskRoster();
  const people=useDeskAgentDirectory();
  const asks=useRecords<Ask>('attention.ask');
  const {reading}=useHomeComms();
  const agents=orderedAgents(namedAgents(roster.status==='live'?roster.records:[],people.status==='live'?people.records:[]));
  const open=asks.status==='live'?openAsks(asks.records):[];
  const attention=open.length>0||!!reading?.summaries.some(s=>s.unread&&agents.some(a=>a.id===s.agent));
  useEffect(()=>{onAttention(attention);return()=>onAttention(false);},[attention,onAttention]);
  useEffect(()=>{
    const shortcut=(e:KeyboardEvent)=>{
      if(!e.ctrlKey||!e.shiftKey||e.altKey||e.metaKey||!/^Digit[1-9]$/.test(e.code))return;
      const agent=agents[Number(e.code.slice(-1))-1];if(!agent)return;
      const summary=reading?.summaries.find(s=>s.agent===agent.id),thread=summary?.first??summary?.last;
      e.preventDefault();go(thread?threadPath(thread.thread):'/p/comms-preview');
    };
    addEventListener('keydown',shortcut);return()=>removeEventListener('keydown',shortcut);
  },[agents,reading,go]);
  return null;
}
