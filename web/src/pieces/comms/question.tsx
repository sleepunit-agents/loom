import {useEffect,useRef,useState} from 'react';
import {callOnce,useRecords,type LiveRecord} from '../../data';
import {Button,Textarea,Error,Loading} from '../../kit';
export interface Question extends LiveRecord {
 thread:string;member:string;agent:string;seq:number;state:string;keepUntil:number;
 question:{ask:string;why?:string;if_yes?:string;if_no?:string;answers:'words'|'yes-no'}|null;
}
interface Owner {id:string;member:string;agent:string;archived:number|null}
/** No stored draft or retained Call: each editor belongs to one live exact source. */
export function SealedQuestion({thread,seq,refId}:{thread:Owner;seq:number;refId:string}){
 const feed=useRecords<Question>('comms.question',refId);
 const found=feed.records.find(q=>q.id===refId&&q.thread===thread.id&&q.seq===seq&&q.member===thread.member&&q.agent===thread.agent);
 const [now,setNow]=useState(Date.now),[draftState,setDraftState]=useState({identity:'',text:''}),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const current=feed.status==='live'&&found&&found.keepUntil>Date.now()?found:undefined;
 const identity=JSON.stringify(current);
 const draft=draftState.identity===identity?draftState.text:'';
 const setDraft=(text:string)=>setDraftState({identity,text});
 const boundary=JSON.stringify([identity,feed.status,thread.archived]);
 const generation=useRef({boundary,value:0});if(generation.current.boundary!==boundary)generation.current={boundary,value:generation.current.value+1};
 const live=useRef({current,identity,archived:thread.archived,generation:generation.current.value});live.current={current,identity,archived:thread.archived,generation:generation.current.value};
 const mounted=useRef(true),sending=useRef(false);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;live.current={current:undefined,identity:'',archived:null,generation:-1};};},[]);
 useEffect(()=>{setDraft('');setError('');},[identity,feed.status,thread.archived]);
 useEffect(()=>{if(!current)return;const timer=setTimeout(()=>setNow(Date.now()),Math.min(2147483647,Math.max(1,current.keepUntil-Date.now())));return()=>clearTimeout(timer);},[current,now]);
 const send=async(verdict?:'yes'|'no')=>{
  const source=live.current,words=draft.trim();
  if(source.identity!==identity||sending.current||!source.current?.question||source.current.state!=='open'||source.archived!==null||source.current.keepUntil<=Date.now()||(!verdict&&(!words||draft.length>4000)))return;
  sending.current=true;setBusy(true);setError('');
  try{
   const checked=await callOnce<Question>('comms.question',{ref:refId}).result;
   if(!mounted.current||live.current.generation!==source.generation||live.current.identity!==source.identity||live.current.archived!==null)return;
   if(!checked.ok||JSON.stringify(checked.value)!==source.identity||checked.value.keepUntil<=Date.now()) {setError('Question changed. Check the current question before answering.');return;}
   const result=await callOnce(verdict?'comms.answer':'comms.replyToAsk',verdict?{thread:thread.id,ref:refId,verdict}:{ref:refId,text:words}).result;
   if(!mounted.current||live.current.generation!==source.generation||live.current.identity!==source.identity)return;
   if(result.ok)setDraft('');else setError(result.message);
  }finally{sending.current=false;if(mounted.current)setBusy(false);}
 };
 if(!current?.question)return <Loading label="Question unavailable or no longer kept"/>;
 const q=current.question;
 return <section aria-label="Private question" className="grid gap-2">
  <p>{q.ask}</p>{q.why&&<p>{q.why}</p>}{q.if_yes&&<p>Yes: {q.if_yes}</p>}{q.if_no&&<p>No: {q.if_no}</p>}
  {current.state!=='open'?<p>Answered</p>:thread.archived!==null?<p>Unarchive this thread to answer.</p>:<fieldset disabled={busy} className="grid gap-2">
   {q.answers!=='words'&&<div className="flex flex-wrap gap-2"><Button disabled={!!draft.trim()} onClick={()=>void send('yes')}>Allow</Button><Button variant="outline" disabled={!!draft.trim()} onClick={()=>void send('no')}>Deny</Button></div>}
   <label className="grid gap-1">Your private reply<Textarea value={draft} maxLength={4000} rows={3} onChange={e=>setDraft(e.target.value)}/></label>
   <Button disabled={!draft.trim()||draft.length>4000} onClick={()=>void send()}>Send private reply</Button>
   <p>This draft stays in this window only.</p>
  </fieldset>}{error&&<Error text={error}/>}
 </section>;
}
