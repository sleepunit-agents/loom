import { useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { RailContext } from '../../desk-rail';
import { reducedMotion } from '../../access';
import AgentFace, { useAgentDisplays } from '../attention/agent-face';
import { messageView, type Message } from './message';
import type { FaceState } from '../../face';
import './portrait.css';

/** Only the reader's retained, authorized messages drive its portrait. */
export function portraitState(messages:readonly Message[],connected:boolean,working:boolean,thinking:boolean):FaceState {
 if(!connected)return 'error';
 const latest=messages.at(-1);
 if(latest&&latest.text!==null&&(latest.kind==='error'||latest.delivery==='failed'))return 'error';
 if(messages.some(m=>{const ask=messageView(m).ask;return ask&&!ask.answered;}))return 'needs-input';
 return working?'working':thinking?'thinking':'idle';
}
export function CommPortrait({agent,messages,connected,working,thinking,on}:{agent:string;messages:readonly Message[];connected:boolean;working:boolean;thinking:boolean;on?:string}) {
 const rail=useContext(RailContext),displays=useAgentDisplays();
 const display=displays.find(d=>d.agent===agent);
 const base=portraitState(messages,connected,working,thinking);
 const reply=messages.filter(m=>m.kind==='reply'&&m.text!==null).at(-1);
 const seen=useRef<number|undefined>(undefined),[run,setRun]=useState<{seq:number;signal:boolean}|null>(null);
 // Mounting or moving the screen never replays old words. A newer retained reply plays once.
 useEffect(()=>{
  if(!connected){setRun(null);return;}
  if(seen.current===undefined){seen.current=reply?.seq??0;return;}
  if(!reply||reply.seq<=seen.current)return;
  seen.current=reply.seq;
  if(reducedMotion())return;
  setRun({seq:reply.seq,signal:true});
 },[connected,reply?.seq]);
 useEffect(()=>{
  if(!run)return;
  const duration=run.signal?250:Math.min(4,Math.max(1,Math.ceil((reply?.text?.length??0)/150)))*1530;
  const timer=setTimeout(()=>setRun(run.signal?{...run,signal:false}:null),duration);
  return()=>clearTimeout(timer);
 },[run,reply?.text?.length]);
 const retained=connected&&!!run&&reply?.seq===run.seq;
 const face=base==='error'||base==='needs-input'?base:retained&&!run?.signal?'talking':base;
 const word=!connected||face==='error'?'NO CARRIER':face==='needs-input'?'WAITING ON YOU':face==='talking'?'TALKING':face==='working'?'WORKING':face==='thinking'?'THINKING':'DONE';
 const into=rail?.shown&&rail.screen?.agent===agent?rail.screen.el:null;
 const screen=<section className="next-comm-screen" data-face={face} data-signal={retained&&run?.signal||undefined} aria-label={`${agent}'s comm screen`}>
  <div className="next-comm-glass"><AgentFace display={display} name={agent} state={face} size={192} dark/><span className="next-comm-scan" aria-hidden="true"/></div>
  <footer>{agent.toUpperCase()} · {word}{on&&` · ON ${on.toUpperCase()}`}<span className="next-comm-meter" aria-label={`signal ${connected?4:0} of 4`}>{[1,2,3,4].map(i=><i key={i} data-on={connected||undefined}/>)}</span></footer>
 </section>;
 return into?createPortal(screen,into):<div className="next-comm-portrait">{screen}</div>;
}
