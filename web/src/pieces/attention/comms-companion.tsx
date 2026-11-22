import type { CommsMessage } from '../comms-view/model';
import type { FaceState } from '../../face';
import { motionQuery, reducedMotion } from '../../access';
import { useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { RailContext } from '../../desk-rail';
import { Button } from '../../kit';
import AgentFace, { faceState } from './agent-face';
import { useDeskAgentDisplays } from './agent-displays';
import { useDeskAgentDirectory } from './agent-directory';
import { useDeskAgentStatuses } from './agent-status';
import { useDeskRoster } from './roster';
import { agentPath, latestStatus, namedAgents, shownState } from './home-model';
import { useDoing } from './doing';
import './comms-companion.css';

type PortraitProps = {agent:string; working:boolean; needs:boolean; messages:readonly CommsMessage[]; go(path:string):void};
type ReplyBeat = {key:number; count:number; sources:number[]};

function Portrait({agent,working,needs,messages,go}:PortraitProps) {
  const rail=useContext(RailContext),displays=useDeskAgentDisplays(),directory=useDeskAgentDirectory();
  const roster=useDeskRoster(),statuses=useDeskAgentStatuses();
  const name=namedAgents([{id:agent,name:agent.slice(0,1).toUpperCase()+agent.slice(1)}],directory.status==='live'?directory.records:[])[0].name;
  const owned=roster.status==='live'&&roster.records.some(row=>row.id===agent);
  const status=statuses.status==='live'?latestStatus(statuses.records,agent):undefined;
  const doing=useDoing(agent);
  const state=faceState(shownState(working?'working':status?.state,doing.items.length),needs);
  const target=rail?.screen?.agent===agent?rail.screen.el:undefined;
  const display=displays.find(row=>row.id===agent);
  // The first reading is history. Only higher sequence numbers in this mounted thread can start a beat.
  const lastSeen=useRef(Math.max(0,...messages.map(row=>row.seq)));
  const [pending,setPending]=useState<ReplyBeat>();
  const [playing,setPlaying]=useState<ReplyBeat>();
  const [shown,setShown]=useState<FaceState>();
  const [ready,setReady]=useState(false);
  const interrupted=state==='error'||state==='needs-input';
  const clear=()=>{setPending(undefined);setPlaying(undefined);setShown(undefined);};
  useEffect(()=>{
    clear();
    const motion=motionQuery();
    const changed=()=>{if(motion.matches)clear();};
    motion.addEventListener('change',changed);
    return ()=>motion.removeEventListener('change',changed);
  },[target]);
  useEffect(()=>{
    const fresh=messages.filter((row):row is CommsMessage & {words:string} =>
      row.seq>lastSeen.current && row.kind==='reply' && row.words!==null);
    lastSeen.current=Math.max(lastSeen.current,...messages.map(row=>row.seq));
    if(interrupted){clear();return;}
    if(!fresh.length||reducedMotion())return;
    const count=fresh.reduce((sum,row)=>sum+Math.max(1,Math.ceil(row.words.length/150)),0);
    setPending(previous=>({
      key:lastSeen.current,
      count:Math.min(4,count+(previous?.count??0)),
      sources:[...(previous?.sources??[]),...fresh.map(row=>row.seq)]
    }));
  },[messages,interrupted]);
  const retained=(beat:ReplyBeat|undefined)=>beat&&!interrupted&&beat.sources.every(seq=>messages.some(row=>row.seq===seq&&row.kind==='reply'&&row.words!==null))?beat:undefined;
  const signal=retained(pending),active=retained(playing);
  useEffect(()=>{
    if((pending&&!signal)||(playing&&!active)){clear();return;}
    if(!signal)return;
    const timer=setTimeout(()=>{setPlaying(signal);setPending(undefined);},250);
    return ()=>clearTimeout(timer);
  },[pending,signal,playing,active]);
  useEffect(()=>{
    if(!active||ready)return;
    setShown('talking');
    const duration=active.count*1530+(active.count-1)*800;
    const done=setTimeout(()=>setShown('complete'),duration);
    const idle=setTimeout(()=>{setPlaying(undefined);setShown(undefined);},duration+900);
    return ()=>{clearTimeout(done);clearTimeout(idle);};
  },[active,ready]);
  const face=active&&shown?shown:state;
  const word=({working:'Working',thinking:'Waiting',idle:'Quiet',error:'Needs a look','needs-input':'Waiting on you',talking:'Talking',complete:'Done'})[face];
  const props={display,name,state:ready?state:face,onReady:setReady,
    talk:active&&ready?{n:active.count,key:active.key}:undefined,
    onShown:(next:FaceState)=>{if(!active)return;if(next==='talking'||next==='complete')setShown(next);else {setPlaying(undefined);setShown(undefined);}}};
  // Beside the rail the comm screen is the agent's rail card, large, with its name and how it is. Without the rail it
  // is a small face beside the thread's title: the head says who the thread is with and whether it is working, so
  // the face adds nothing but itself, and opens the agent's own page where this person owns the agent.
  if(!target)return <span className="desk-comms-mini" data-location="inline" data-face={face} data-signal={signal&&"on"}>
    {owned?<button type="button" className="desk-comms-mini__face" aria-label={`Open ${name}`} title={word} onClick={()=>go(agentPath(agent))}><AgentFace {...props} size={30}/></button>
      :<span className="desk-comms-mini__face" title={word}><AgentFace {...props} size={30}/></span>}
  </span>;
  return createPortal(<section className="desk-comms-screen" aria-label={`${name}'s comm screen`} data-location="rail" data-face={face} data-signal={signal&&"on"}>
    <div className="desk-comms-glass"><AgentFace {...props} size={192} scale={2}/></div>
    {owned?<Button variant="ghost" className="desk-comms-name" onClick={()=>go(agentPath(agent))}>{name}</Button>:<strong className="desk-comms-name">{name}</strong>}
    <p className="desk-comms-state">{word}</p>
  </section>,target);
}
/** Selection belongs to the visible authorized reader; late cleanup cannot
 * clear another reader's selection. Portrait data uses the desk's same client. */
export default function CommsCompanion({agent,working,needs,visible,messages,go}:PortraitProps & {visible:boolean}) {
  const rail=useContext(RailContext),source=useRef({});
  useEffect(()=>{
    if(!visible||!rail?.onAir)return;
    rail.onAir({agent},source.current);
    return()=>rail.onAir(null,source.current);
  },[agent,visible,rail?.onAir]);
  return visible?<Portrait agent={agent} needs={needs} messages={messages} working={working} go={go}/>:null;
}
