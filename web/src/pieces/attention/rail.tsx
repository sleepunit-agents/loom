import { useLayoutEffect, useRef, useState } from 'react';
import AgentFace, { faceState, useAgentDisplays } from './agent-face';
import { useRecords, type LiveRecord } from '../../data';
import { inboxPath, latestStatus, namedAgents, openAsks, orderedAgents, type AgentPerson, type AgentStatus, type OwnedAgent } from './home-model';
import type { Ask } from './model';
import './rail.css';

interface Thread extends LiveRecord { id: string; agent: string; title: string | null; archived: number | null; last: number; unread: boolean; working?: boolean }
/** Only policy-filtered feeds. No messages, local cache, direct fetch or answer controls. */
export default function AgentRail({ go }: { go(path: string): void }) {
  const roster = useRecords<OwnedAgent>('attention.ownedAgent');
  const displays = useAgentDisplays();
  const people = useRecords<AgentPerson>('person');
  const statuses = useRecords<AgentStatus>('attention.agent');
  const asks = useRecords<Ask>('attention.ask');
  const threads = useRecords<Thread>('thread');
  const open = asks.status === 'live' ? openAsks(asks.records) : [];
  const agents = orderedAgents(namedAgents(roster.status === 'live' ? roster.records : [], people.status === 'live' ? people.records : []));
  const box = useRef<HTMLDivElement>(null);
  const [fold, setFold] = useState(false);
  const [room, setRoom] = useState('');
  // A changed height, width or authorized content tries the full cards before paint.
  useLayoutEffect(()=>{setFold(false);},[room, roster.records, people.records, statuses.records, asks.records, threads.records, roster.status, people.status, statuses.status, asks.status, threads.status]);
  useLayoutEffect(()=>{const el=box.current;if(el&&!fold&&el.scrollHeight>el.clientHeight+1)setFold(true);});
  useLayoutEffect(()=>{
    const el=box.current;if(!el)return;
    const measure=()=>setRoom(`${el.clientWidth}:${el.clientHeight}`);
    const observer=new ResizeObserver(measure);observer.observe(el);measure();
    let on=true;void document.fonts?.ready.then(()=>{if(on)setFold(false);});
    return()=>{on=false;observer.disconnect();};
  },[]);
  const recentThreads = threads.status==='live'?threads.records.filter(t=>t.archived===null):[];
  // Comms companion selection joins this priority in its own slice; no inferred active pane.
  const opened = (agents.find(a=>recentThreads.some(t=>t.agent===a.id&&t.working))
    ?? agents.find(a=>open.some(ask=>ask.agent===a.id))
    ?? agents.find(a=>recentThreads.some(t=>t.agent===a.id&&t.unread)) ?? agents[0])?.id;
  return <div ref={box} className="desk-agent-rail" data-fold={fold||undefined}>
    <button className="desk-rail-needs" onClick={()=>go(inboxPath(open[0]))}>
      <span className="desk-rail-kicker">Needs you{asks.status==='live'?` · ${open.length}`:''}</span>
      <span>{asks.status==='live'?(open[0]?.ask??'All clear.'):'Asks unavailable'}</span>
      <span className="desk-rail-kicker">Inbox ›</span>
    </button>
    {roster.status !== 'live' ? <p role="status">{roster.status==='loading'?'Opening your agents…':'Your agents are unavailable.'}</p> : !agents.length ? <p>No agents of your own.</p> : agents.map(agent=>{
      const status = statuses.status==='live'?latestStatus(statuses.records,agent.id):undefined;
      const ask = open.find(a=>a.agent===agent.id);
      const recent = threads.status==='live'?threads.records.filter(t=>t.agent===agent.id&&t.archived===null).sort((a,b)=>b.last-a.last||a.id.localeCompare(b.id)):[];
      const unread = recent.filter(t=>t.unread), thread = unread[0]??recent[0];
      const path = thread?`/p/comms-preview/thread/${encodeURIComponent(thread.id.replace(/^th:/,''))}`:'/p/comms-preview';
      const word = status?.state==='offline'?'Unavailable':ask?'Needs you':status?.state==='working'?'Working':status?.state==='waiting'?'Waiting':status?'Quiet':'No status reported';
      if(fold&&agent.id!==opened)return <section key={agent.id} className="desk-rail-row" data-agent={agent.id} aria-label={`${agent.name} rail card`}>
        <button aria-label={`Open ${agent.name} conversation`} onClick={()=>go(path)}>
          <AgentFace display={displays.find(d=>d.id===agent.id)} name={agent.name} state={faceState(status?.state,!!ask)} size={24}/>
          <strong>{agent.name}</strong><span className="desk-rail-dot" data-state={status?.state} title={word} aria-label={word}/>
          {ask&&<span className="desk-rail-badge">ASK</span>}
          <span className="desk-rail-unread" aria-label={threads.status!=='live'?'Conversations unavailable':`${unread.length} unread threads`}>{threads.status!=='live'?'?':unread.length||''}</span>
        </button>
      </section>;
      return <section key={agent.id} className="desk-rail-card" data-agent={agent.id} aria-label={`${agent.name} rail card`} data-state={status?.state}>
        <button className="desk-rail-agent" aria-label={`Open ${agent.name} conversation`} onClick={()=>go(path)}>
          <AgentFace display={displays.find(d=>d.id===agent.id)} name={agent.name} state={faceState(status?.state, !!ask)} size={40} />
          <span><strong>{agent.name}</strong><span className="desk-rail-state">{word}</span></span>
        </button>
        <p className="desk-rail-work">{statuses.status==='live'?(status?.work||'Nothing right now'):'Agent status unavailable'}</p>
        {ask&&<button className="desk-rail-ask" onClick={()=>go(inboxPath(ask))}><span className="desk-rail-kicker">Asks you</span>{ask.ask}<span aria-hidden="true"> ›</span></button>}
        <button className="desk-rail-thread" onClick={()=>go(path)}>{threads.status!=='live'?'Conversations unavailable':unread.length?`${unread.length} unread ${unread.length===1?'thread':'threads'}`:thread?(thread.title||'Recent conversation'):'Start a conversation'}<span aria-hidden="true"> ↗</span></button>
      </section>;
    })}
  </div>;
}
