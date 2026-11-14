import { useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { RailContext } from '../../desk-rail';
import { motionQuery, reducedMotion } from '../../access';
import { PixelContext } from '../../look';
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
export const talkBeats=(chars:number)=>Math.min(4,Math.max(1,Math.ceil(chars/150)));
type Run={key:number;n:number;sources:string[];signal:boolean;phase:'talking'|'complete'|null};
export function CommPortrait({agent,messages,connected,working,thinking,on}:{agent:string;messages:readonly Message[];connected:boolean;working:boolean;thinking:boolean;on?:string}) {
 const rail=useContext(RailContext),displays=useAgentDisplays(),pixel=useContext(PixelContext);
 const display=displays.find(d=>d.agent===agent);
 const base=portraitState(messages,connected,working,thinking);
 const seen=useRef<number|undefined>(undefined),[run,setRun]=useState<Run|null>(null);
 const [ready,setReady]=useState<boolean|null>(null),[anim,setAnim]=useState<string>();
 const glass=useRef<HTMLDivElement>(null),[scale,setScale]=useState(2);
 const into=rail?.shown&&rail.screen?.agent===agent?rail.screen.el:null;
 const retained=connected&&base!=='error'&&base!=='needs-input'&&!!run&&run.sources.every(id=>messages.some(m=>m.id===id&&m.kind==='reply'&&m.text!==null));
 const current=useRef<Run|null>(null);current.current=retained?run:null;
 const sprite=!!(pixel&&display?.sprite);
 useEffect(()=>{
  const motion=motionQuery();const stop=()=>{if(motion.matches)setRun(null);};
  motion.addEventListener('change',stop);return()=>motion.removeEventListener('change',stop);
 },[]);
 // A new destination mounts a new player: do not replay the prior player's request there.
 useEffect(()=>{setRun(null);setReady(null);},[into,display?.sprite?.base,display?.sprite?.v,pixel]);
 // Baseline on first live snapshot and reconnect: retained history never replays.
 useEffect(()=>{
  if(!connected){seen.current=undefined;setRun(null);return;}
  const last=Math.max(0,...messages.map(m=>m.seq));
  if(seen.current===undefined){seen.current=last;return;}
  const fresh=messages.filter(m=>m.kind==='reply'&&m.text!==null&&m.seq>seen.current!);
  seen.current=Math.max(seen.current,last);
  if(!fresh.length)return;
  if(reducedMotion()||base==='error'||base==='needs-input')return;
  setRun(previous=>({key:Math.max(...fresh.map(m=>m.seq)),n:Math.min(4,(previous?.signal?previous.n:0)+fresh.reduce((n,m)=>n+talkBeats(m.text!.length),0)),sources:[...(previous&&(previous.signal||previous.phase==='talking')?previous.sources:[]),...fresh.map(m=>m.id)],signal:true,phase:previous?.phase==='talking'?'talking':null}));
 },[connected,messages,base]);
 useEffect(()=>{if(run&&!retained)setRun(null);},[run,retained]);
 // Count the visible static from a painted frame, as on the present desk.
 useEffect(()=>{
  if(!retained||!run?.signal)return;
  let timer:ReturnType<typeof setTimeout>|undefined;
  let frame=requestAnimationFrame(()=>{frame=requestAnimationFrame(()=>{
   timer=setTimeout(()=>setRun(r=>r?.key===run.key?{...r,signal:false,phase:sprite?r.phase:'talking'}:r),250);
  });});
  return()=>{cancelAnimationFrame(frame);clearTimeout(timer);};
 },[retained,run?.key,run?.signal,sprite]);
 // A drawn face (including a missing sheet) has no player callbacks.
 useEffect(()=>{
  if(!retained||!run||run.signal||sprite&&ready!==false)return;
  const phase=run.phase??'talking';
  if(!run.phase){setRun(r=>r?.key===run.key?{...r,phase}:r);return;}
  const timer=setTimeout(()=>setRun(r=>r?.key===run.key?(phase==='talking'?{...r,phase:'complete'}:null):r),phase==='talking'?run.n*1530+(run.n-1)*800:900);
  return()=>clearTimeout(timer);
 },[retained,run,sprite,ready]);
 // Measure the actual glass, also after a portal move. Never CSS-rescale a sprite canvas.
 useEffect(()=>{
  const el=glass.current;if(!el)return;
  const resize=()=>setScale(Math.max(1,Math.min(2,Math.floor(el.clientWidth/96))));
  resize();const observer=new ResizeObserver(resize);observer.observe(el);return()=>observer.disconnect();
 },[into]);
 const phase=retained?run?.phase:null;
 const face=base==='error'||base==='needs-input'?base:phase??base;
 const word=!connected||face==='error'?'NO CARRIER':face==='needs-input'?'WAITING ON YOU':face==='talking'?'TALKING':face==='working'?'WORKING':face==='thinking'?'THINKING':'DONE';
 const key=run?.key;
 const screen=<section className="next-comm-screen" data-face={face} data-anim={retained&&sprite?anim:undefined} data-signal={retained&&run?.signal||undefined} aria-label={`${agent}'s comm screen`}>
  <div ref={glass} className="next-comm-glass"><AgentFace display={display} name={agent} state={face} size={96*scale} scale={scale} dark
   talk={retained&&!run.signal&&sprite&&ready?{n:run.n,key:run.key}:undefined} onReady={setReady}
   onShown={state=>{if(!current.current||current.current.key!==key)return;setRun(r=>r&&r.key===key?(state==='talking'||state==='complete'?{...r,phase:state}:r.signal?{...r,phase:null}:r.phase?null:r):r);}}
   onFrom={from=>{if(current.current&&current.current.key===key)setAnim(from);}}/><span className="next-comm-scan" aria-hidden="true"/></div>
  <footer>{agent.toUpperCase()} · {word}{on&&` · ON ${on.toUpperCase()}`}<span className="next-comm-meter" aria-label={`signal ${connected?4:0} of 4`}>{[1,2,3,4].map(i=><i key={i} data-on={connected||undefined}/>)}</span></footer>
 </section>;
 return into?createPortal(screen,into):<div className="next-comm-portrait">{screen}</div>;
}
