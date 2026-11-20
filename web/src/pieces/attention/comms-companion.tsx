import { useContext, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { RailContext } from '../../desk-rail';
import { Button } from '../../kit';
import AgentFace, { faceState } from './agent-face';
import { useDeskAgentDisplays } from './agent-displays';
import { useDeskAgentDirectory } from './agent-directory';
import { useDeskAgentStatuses } from './agent-status';
import { useDeskRoster } from './roster';
import { useDeskWaitingCounts } from './waiting';
import { agentPath, agentStateWord, latestStatus, namedAgents } from './home-model';
import './comms-companion.css';

function Portrait({agent,working,go}:{agent:string;working:boolean;go(path:string):void}) {
  const rail=useContext(RailContext),displays=useDeskAgentDisplays(),directory=useDeskAgentDirectory();
  const roster=useDeskRoster(),statuses=useDeskAgentStatuses(),waiting=useDeskWaitingCounts();
  const name=namedAgents([{id:agent,name:agent.slice(0,1).toUpperCase()+agent.slice(1)}],directory.status==='live'?directory.records:[])[0].name;
  const owned=roster.status==='live'&&roster.records.some(row=>row.id===agent);
  const status=statuses.status==='live'?latestStatus(statuses.records,agent):undefined;
  const needs=waiting.status==='live'&&(waiting.agents.get(agent)??0)>0;
  const state=faceState(working?'working':status?.state,needs);
  const word=working||status||needs?({working:'Working',thinking:'Waiting',idle:'Quiet',error:'Needs a look','needs-input':'Waiting on you'} as Record<string,string>)[state]:agentStateWord(undefined);
  const target=rail?.screen?.agent===agent?rail.screen.el:undefined;
  const display=displays.find(row=>row.id===agent);
  // Beside the rail the comm screen is the agent's rail card, large, with its name and how it is. Without the rail it
  // is a small face beside the thread's title: the head says who the thread is with and whether it is working, so
  // the face adds nothing but itself, and opens the agent's own page where this person owns the agent.
  if(!target)return <span className="desk-comms-mini" data-location="inline">
    {owned?<button type="button" className="desk-comms-mini__face" aria-label={`Open ${name}`} title={word} onClick={()=>go(agentPath(agent))}><AgentFace display={display} name={name} state={state} size={30}/></button>
      :<span className="desk-comms-mini__face" title={word}><AgentFace display={display} name={name} state={state} size={30}/></span>}
  </span>;
  return createPortal(<section className="desk-comms-screen" aria-label={`${name}'s comm screen`} data-location="rail">
    <div className="desk-comms-glass"><AgentFace display={display} name={name} state={state} size={192} scale={2}/></div>
    {owned?<Button variant="ghost" className="desk-comms-name" onClick={()=>go(agentPath(agent))}>{name}</Button>:<strong className="desk-comms-name">{name}</strong>}
    <p className="desk-comms-state">{word}</p>
  </section>,target);
}
/** Selection belongs to the visible authorized reader; late cleanup cannot
 * clear another reader's selection. Portrait data uses the desk's same client. */
export default function CommsCompanion({agent,working,visible,go}:{agent:string;working:boolean;visible:boolean;go(path:string):void}) {
  const rail=useContext(RailContext),source=useRef({});
  useEffect(()=>{
    if(!visible||!rail?.onAir)return;
    rail.onAir({agent},source.current);
    return()=>rail.onAir(null,source.current);
  },[agent,visible,rail?.onAir]);
  return visible?<Portrait agent={agent} working={working} go={go}/>:null;
}
