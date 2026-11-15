import { useDeskAgentDisplays } from './agent-displays';
import { useDeskAgentDirectory } from './agent-directory';
import { useHomeComms, threadPath } from './home-comms-data';
import { useDeskAgentStatuses } from './agent-status';
import { CurrentJobs } from './current-jobs';
import { useDeskRoster } from './roster';
import { useCallback, useContext, useLayoutEffect, useRef, useState } from 'react';
import AgentFace, { faceState } from './agent-face';
import { Row } from '../../kit';
import { useRecords } from '../../data';
import { inboxPath, latestStatus, namedAgents, openAsks, orderedAgents } from './home-model';
import type { Ask } from './model';
import './rail.css';
import { RailContext } from '../../desk-rail';
import { reducedMotion } from '../../access';

function CompanionSlot({agent}:{agent:string}) {
  const rail=useContext(RailContext),el=useRef<HTMLDivElement>(null),source=useRef({});
  useLayoutEffect(()=>{if(!el.current||!rail?.setScreen)return;rail.setScreen({agent,el:el.current},source.current);return()=>rail.setScreen?.(null,source.current);},[agent,rail?.setScreen]);
  return <div className="desk-rail-screen" ref={el}/>;
}
/** Only policy-filtered feeds. No messages, local cache, direct fetch or answer controls. */
export default function AgentRail({ go }: { go(path: string): void }) {
  const roster = useDeskRoster();
  const displays = useDeskAgentDisplays();
  const people = useDeskAgentDirectory();
  const statuses = useDeskAgentStatuses();
  const asks = useRecords<Ask>('attention.ask');
  const {reading, status:threadStatus}=useHomeComms();
  const open = asks.status === 'live' ? openAsks(asks.records) : [];
  const agents = orderedAgents(namedAgents(roster.status === 'live' ? roster.records : [], people.status === 'live' ? people.records : []));
  const rail = useContext(RailContext);
  const companion = agents.find(a=>a.id===rail?.selected);
  const box = useRef<HTMLDivElement>(null);
  const [fold, setFold] = useState(false);
  const [room, setRoom] = useState('');
  const jobsChanged = useCallback(() => setFold(false), []);
  // A changed height, width or authorized content tries the full cards before paint.
  useLayoutEffect(()=>{setFold(false);},[room, roster.records, people.records, statuses.records, asks.records, reading, roster.status, people.status, statuses.status, asks.status, threadStatus, companion?.id]);
  useLayoutEffect(()=>{const el=box.current;if(el&&!fold&&el.scrollHeight>el.clientHeight+1)setFold(true);});
  useLayoutEffect(()=>{
    const el=box.current;if(!el)return;
    const measure=()=>setRoom(`${el.clientWidth}:${el.clientHeight}`);
    const observer=new ResizeObserver(measure);observer.observe(el);measure();
    let on=true;void document.fonts?.ready.then(()=>{if(on)setFold(false);});
    return()=>{on=false;observer.disconnect();};
  },[]);
  const opened = (companion ?? agents.find(a=>statuses.status==='live'&&latestStatus(statuses.records,a.id)?.state==='working')
    ?? agents.find(a=>open.some(ask=>ask.agent===a.id))
    ?? agents.find(a=>reading?.summaries.some(s=>s.agent===a.id&&s.unread)) ?? agents[0])?.id;
  const positions=useRef(new Map<string,number>()),previous=useRef<string|undefined>(undefined);
  useLayoutEffect(()=>{
    const nodes=[...(box.current?.querySelectorAll?.<HTMLElement>('[data-agent]')??[])];
    const next=new Map(nodes.map(el=>[el.dataset.agent!,el.getBoundingClientRect().top]));
    if(previous.current!==companion?.id)for(const el of nodes){
      const id=el.dataset.agent!,before=positions.current.get(id),after=next.get(id)!;
      if((id===companion?.id||id===previous.current)&&before!==undefined&&before!==after&&el.animate&&!reducedMotion())el.animate([{transform:`translateY(${before-after}px)`},{transform:'translateY(0)'}],{duration:260,easing:'ease-out'});
    }
    positions.current=next;previous.current=companion?.id;
  });
  const card=(agent:(typeof agents)[number])=>{
      const status = statuses.status==='live'?latestStatus(statuses.records,agent.id):undefined;
      const ownAsks = open.filter(a=>a.agent===agent.id), ask = ownAsks[0];
      const summary=reading?.summaries.find(s=>s.agent===agent.id);
      const unread=summary?.unread??0,thread=summary?.first??summary?.last;
      const path=thread?threadPath(thread.thread):'/p/comms-preview';
      const word = status?.state==='offline'?'Unavailable':ask?'Needs you':status?.state==='working'?'Working':status?.state==='waiting'?'Waiting':status?'Quiet':'No status reported';
      if(fold&&agent.id!==opened)return <section key={agent.id} className="desk-rail-compact" data-agent={agent.id} aria-label={`${agent.name} rail card`}>
        <Row aria-label={`Open ${agent.name} conversation`} onClick={()=>go(path)} title={agent.name}
          icon={<AgentFace display={displays.find(d=>d.id===agent.id)} name={agent.name} state={faceState(status?.state,!!ask)} size={24}/>}
          trailing={<span className="desk-rail-flags"><span role="img" className="desk-rail-dot" data-state={status?.state} title={word} aria-label={word}/>
            {ask&&<span className="desk-rail-badge" aria-label={`${ownAsks.length} waiting ${ownAsks.length===1?'question':'questions'}`}>ASK{ownAsks.length>1?` · ${ownAsks.length}`:''}</span>}
            <span className="desk-rail-unread" aria-label={threadStatus!=='live'?'Conversations unavailable':`${unread} unread threads`}>{threadStatus!=='live'?'?':unread||''}</span>
          </span>}/>
      </section>;
      return <section key={agent.id} className="desk-rail-card" data-companion={agent.id===companion?.id||undefined} data-agent={agent.id} aria-label={`${agent.name} rail card`} data-state={status?.state}>
        {agent.id===companion?.id&&<p className="desk-rail-kicker desk-rail-with">With {agent.name} in Comms</p>}
        {agent.id===companion?.id&&rail?.shown&&rail.setScreen?<CompanionSlot agent={agent.id}/>:<button className="desk-rail-agent" aria-label={`Open ${agent.name} conversation`} onClick={()=>go(path)}>
          <AgentFace display={displays.find(d=>d.id===agent.id)} name={agent.name} state={faceState(status?.state, !!ask)} size={40} />
          <span><strong>{agent.name}</strong><span className="desk-rail-state">{word}</span></span>
        </button>}
        <p className="desk-rail-work">{statuses.status==='live'?(status?.work||'Nothing right now'):'Agent status unavailable'}</p>
        <CurrentJobs agent={agent.id} name={agent.name} compact onChange={jobsChanged} />
        {ask&&<button className="desk-rail-ask" onClick={()=>go(inboxPath(ask))}><span className="desk-rail-kicker">Asks you</span>{ask.ask}{ownAsks.length>1&&<span className="desk-rail-kicker">{`${ownAsks.length-1} more`}</span>}<span aria-hidden="true"> ›</span></button>}
        <button className="desk-rail-thread" onClick={()=>go(path)}>{threadStatus!=='live'?'Conversations unavailable':unread?`${unread} unread ${unread===1?'thread':'threads'}`:thread?(summary?.last?.title||'Recent conversation'):'Start a conversation'}<span aria-hidden="true"> ↗</span></button>
      </section>;
  };
  return <div ref={box} className="desk-agent-rail" data-fold={fold||undefined}>
    {companion&&card(companion)}
    <button className="desk-rail-needs" onClick={()=>go(inboxPath(open[0]))}>
      <span className="desk-rail-kicker">Needs you{asks.status==='live'?` · ${open.length}`:''}</span>
      <span>{asks.status==='live'?(open[0]?.ask??'All clear.'):'Asks unavailable'}</span>
      <span className="desk-rail-kicker">{asks.status==='live'&&open.length>1?`${open.length-1} more · Inbox ›`:'Inbox ›'}</span>
    </button>
    {roster.status !== 'live' ? <p role="status">{roster.status==='loading'?'Opening your agents…':'Your agents are unavailable.'}</p> : !agents.length ? <p>No agents of your own.</p> : agents.filter(a=>a.id!==companion?.id).map(card)}
  </div>;
}
