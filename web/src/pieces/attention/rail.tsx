import { LiveAgentFeed } from './live-agent-posts';
import { useDeskWaitingCounts, WaitingRow, waitingPath } from './waiting';
import { useDeskAgentDisplays } from './agent-displays';
import { useDeskAgentDirectory } from './agent-directory';
import { useHomeComms, threadPath } from './home-comms-data';
import { useDeskAgentStatuses } from './agent-status';
import { Doing, WithDoing } from './doing';
import { useDeskRoster } from './roster';
import { useCallback, useContext, useLayoutEffect, useRef, useState } from 'react';
import AgentFace, { faceState } from './agent-face';
import { Row } from '../../kit';
import { agentStateLine, latestStatus, namedAgents, orderedAgents, shownState } from './home-model';
import './rail.css';
import { RailContext } from '../../desk-rail';
import { reducedMotion } from '../../access';

function CompanionSlot({agent}:{agent:string}) {
  const rail=useContext(RailContext),el=useRef<HTMLDivElement>(null),source=useRef({});
  useLayoutEffect(()=>{if(!el.current||!rail?.setScreen)return;rail.setScreen({agent,el:el.current},source.current);return()=>rail.setScreen?.(null,source.current);},[agent,rail?.setScreen]);
  return <div className="desk-rail-screen" ref={el}/>;
}
/** Only policy-filtered feeds. No messages, local cache, direct fetch or answer controls. A card is the agent's
 * face, name and state, what it is doing, and its unread count; what needs you is said once, at the top. */
export default function AgentRail({ go }: { go(path: string): void }) {
  const roster = useDeskRoster();
  const displays = useDeskAgentDisplays();
  const people = useDeskAgentDirectory();
  const statuses = useDeskAgentStatuses();
  const waiting = useDeskWaitingCounts();
  const {reading, status:threadStatus}=useHomeComms();
  const agents = orderedAgents(namedAgents(roster.status === 'live' ? roster.records : [], people.status === 'live' ? people.records : []));
  const names = new Map(agents.map(agent=>[agent.id,agent.name]));
  const rail = useContext(RailContext);
  const companion = rail?.shown?agents.find(a=>a.id===rail.selected):undefined;
  const box = useRef<HTMLDivElement>(null);
  const [fold, setFold] = useState(false);
  const [room, setRoom] = useState('');
  const jobsChanged = useCallback(() => setFold(false), []);
  const [,setContent]=useState(0);
  const waitingChanged=useCallback(()=>{setFold(false);setContent(value=>value+1);},[]);
  // A changed height, width or authorized content tries the full cards before paint.
  useLayoutEffect(()=>{setFold(false);},[room, roster.records, people.records, statuses.records, waiting, reading, roster.status, people.status, statuses.status, waiting.status, threadStatus, companion?.id]);
  useLayoutEffect(()=>{const el=box.current;if(el&&!fold&&el.scrollHeight>el.clientHeight+1)setFold(true);});
  useLayoutEffect(()=>{
    const el=box.current;if(!el)return;
    const measure=()=>setRoom(`${el.clientWidth}:${el.clientHeight}`);
    const observer=new ResizeObserver(measure);observer.observe(el);measure();
    let on=true;void document.fonts?.ready.then(()=>{if(on)setFold(false);});
    return()=>{on=false;observer.disconnect();};
  },[]);
  const opened = (companion ?? agents.find(a=>statuses.status==='live'&&latestStatus(statuses.records,a.id)?.state==='working')
    ?? agents.find(a=>waiting.status==='live'&&(waiting.agents.get(a.id)??0)>0)
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
      const needs = waiting.status==='live'?(waiting.agents.get(agent.id)??0):undefined, ask=(needs??0)>0;
      const summary=reading?.summaries.find(s=>s.agent===agent.id);
      const unread=summary?.unread??0,thread=summary?.first??summary?.last;
      const path=thread?threadPath(thread.thread):'/p/comms-preview';
      return <WithDoing key={'agent:'+agent.id} agent={agent.id} onChange={jobsChanged}>{doing=>{
        const state=shownState(status?.state,doing.items.length);
        const terminal = doing.items.find(item=>item.kind==='terminal');
        const word=agentStateLine(state,doing.items.length,needs);
        if(fold&&agent.id!==opened)return <section className="desk-rail-compact" data-agent={agent.id} aria-label={`${agent.name} rail card`}>
          <Row aria-label={`Open ${agent.name} conversation`} onClick={()=>go(path)} title={agent.name}
            icon={<AgentFace display={displays.find(d=>d.id===agent.id)} name={agent.name} state={faceState(state,ask)} size={24}/>}
            trailing={<span className="desk-rail-flags"><span role="img" className="desk-rail-dot" data-state={state} title={word} aria-label={word}/>
              {ask&&<span className="desk-rail-badge" aria-label={`${(needs??0)} waiting ${(needs??0)===1?'question':'questions'}`}>NEEDS{(needs??0)>1?` · ${(needs??0)}`:''}</span>}
              <span className="desk-rail-unread" aria-label={threadStatus!=='live'?'Conversations unavailable':`${unread} unread threads`}>{threadStatus!=='live'?'?':unread||''}</span>
            </span>}/>
        </section>;
        return <section className="desk-rail-card" data-companion={agent.id===companion?.id||undefined} data-agent={agent.id} aria-label={`${agent.name} rail card`} data-state={state}>
          {agent.id===companion?.id&&<p className="desk-rail-kicker desk-rail-with">With {agent.name} in Comms</p>}
          {agent.id===companion?.id&&rail?.shown&&rail.setScreen?<CompanionSlot agent={agent.id}/>:<button className="desk-rail-agent" aria-label={`Open ${agent.name} conversation`} onClick={()=>go(path)}>
            <AgentFace display={displays.find(d=>d.id===agent.id)} name={agent.name} state={faceState(state,ask)} size={40} />
            <span><strong>{agent.name}</strong><span className="desk-rail-state">{word}</span></span>
          </button>}
          {terminal && <div className="desk-rail-location">
            <Doing doing={{...doing,items:[terminal],more:doing.items.length===1?doing.more:0}}
              label={`${agent.name} terminal location`} name={agent.name} names={names} go={go} compact/>
          </div>}
          <LiveAgentFeed agent={agent.id} compact go={go} onChange={waitingChanged}/>
          {(!terminal || doing.items.length > 1) && <Doing doing={terminal ? {...doing, items: doing.items.filter(item=>item!==terminal)} : doing} name={agent.name} names={names} go={go} compact />}
          <button className="desk-rail-thread" onClick={()=>go(path)}>{threadStatus!=='live'?'Conversations unavailable':unread?`${unread} unread ${unread===1?'thread':'threads'}`:thread?(summary?.last?.title||'Recent conversation'):'Start a conversation'}<span aria-hidden="true"> ↗</span></button>
        </section>;
      }}</WithDoing>;
  };
  const first = companion ?? (fold ? agents.find(agent => agent.id === opened) : undefined) ?? agents[0];
  // Keep every agent in one keyed list when folding promotes a different card.
  // Moving between separate React child lists would restart its live reads.
  const cards=agents.filter(agent=>agent.id!==first?.id).map(card);
  if(waiting.status!=='live'||waiting.total)cards.unshift(<div key="waiting" className="desk-rail-needs">
      <span className="desk-rail-kicker">Needs you{waiting.status==='live'?` · ${waiting.total}`:''}</span>
      {waiting.status!=='live'?<span>Waiting items unavailable</span>:<WaitingRow go={go} onChange={waitingChanged}/>}
      <button type="button" className="desk-rail-kicker" onClick={()=>go(waitingPath())}>{waiting.status==='live'&&(waiting.total??0)>1?`${waiting.total!-1} more · Inbox ›`:'Inbox ›'}</button>
    </div>);
  if(first)cards.unshift(card(first));
  return <div ref={box} className="desk-agent-rail" data-fold={fold||undefined}>
    {cards}
    {roster.status!=='live'?<p role="status">{roster.status==='loading'?'Opening your agents…':'Your agents are unavailable.'}</p>:!agents.length&&<p>No agents of your own.</p>}
  </div>;
}
