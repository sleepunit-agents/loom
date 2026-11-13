import { useEffect, useRef, useState } from 'react';
import { useRecords, call } from '../../data';
import { Button, Empty, Error, Loading } from '../../kit';
import { ConversationPages, retainedStep, type ConversationStep } from './conversation-pages';
interface Activity {id:string;steps:ConversationStep[];[key:string]:unknown}
/** A scoped read-only activity page; the server alone resolves conversation access. */
export function ConversationActivity({conversation,onBack}:{conversation:string;onBack():void}){
 const {records,status}=useRecords<Activity>('conversationSteps',conversation);
 const activity=status==='live'?records.find(row=>row.id===conversation):undefined;
 const [pages]=useState(()=>new ConversationPages());
 const [older,setOlder]=useState<ConversationStep[]>([]),[pending,setPending]=useState(false),[error,setError]=useState<string>();
 const [now,setNow]=useState(Date.now);
 const current=useRef(activity);current.current=activity;const pageOwner=useRef(activity);
 // Every authoritative Live replacement invalidates earlier pages and in-flight reads.
 // No conversation metadata/version or private fields need to be copied into this cache.
 useEffect(()=>{pageOwner.current=activity;pages.clear();setOlder([]);setPending(false);setError(undefined);},[activity,pages]);
 useEffect(()=>()=>{current.current=undefined;pages.clear();},[pages]);
 const all=activity?[...(pageOwner.current===activity?older:[]).filter(row=>!activity.steps.some(live=>live.seq===row.seq)),...activity.steps].sort((a,b)=>a.seq-b.seq).map(row=>retainedStep(row,Date.now())):[];
 useEffect(()=>{
  if(!activity)return;
  const deadlines=[...older,...activity.steps].map(row=>row.keepUntil).filter(at=>Number.isFinite(at)&&at>Date.now());
  if(!deadlines.length)return;
  const timer=setTimeout(()=>{pages.expire(Date.now());setOlder(pages.rows);setNow(Date.now());},Math.min(2147483647,Math.max(1,Math.min(...deadlines)-Date.now())));
  return()=>clearTimeout(timer);
 },[activity,older,pages,now]);
 async function load(){
  if(!activity||pending)return;
  const original=activity,generation=pages.begin();setPending(true);setError(undefined);
  // Keep the Call local: successful plaintext results never live in component state.
  const result=await call<{steps:ConversationStep[]}>('comms.conversationSteps',{conversation,before:all[0]?.seq}).result;
  if(current.current!==original||generation!==pages.begin())return;
  setPending(false);
  if(result.ok){if(pages.accept(generation,result.value.steps,Date.now()))setOlder(pages.rows);}
  else setError(result.message);
 }
 return <article className="flex h-full min-h-0 flex-col">
  <header className="grid gap-2 border-b p-4"><Button variant="outline" onClick={onBack}>Back to threads</Button><h1>Conversation activity</h1><p className="break-all">{conversation}</p></header>
  <div className="min-h-0 flex-1 overflow-auto p-4" aria-label="Conversation activity">
   {status==='loading'?<Loading label="Opening conversation activity…"/>:status!=='live'?<Error text="Waiting for your signed-in connection."/>:!activity?<Empty title="Conversation unavailable"/>:<>
    <Button variant="outline" onClick={load} disabled={pending||!all.length}>{pending?'Loading earlier activity…':'Load earlier activity'}</Button>
    {error&&<Error text={error}/>}
    {!all.length?<Empty title="No retained activity"/>:<ol className="grid gap-3">{all.map(step=><li key={step.seq} className="rounded border p-3">
     <p><time dateTime={new Date(step.at).toISOString()}>{new Date(step.at).toLocaleString('en-US',{timeZone:'America/Chicago'})} CT</time>{step.text!==null&&step.tool&&` · ${step.tool}`}{step.text!==null&&step.state&&` · ${step.state}`}</p>
     <p className="whitespace-pre-wrap break-words">{step.text??'Label no longer kept'}</p>
    </li>)}</ol>}
   </>}
  </div>
 </article>;
}
