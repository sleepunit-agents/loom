import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { call, optimistic, type Call, type CallState } from '../../data';
import { Button, Error, Loading, Textarea } from '../../kit';
import { readDraft, writeDraft, editDraft, clearDraft, type Draft } from './drafts';
import type { Message } from './message';
import { bindComposerViewport } from './viewport';
interface Ack {thread:string;seq:number}
const idle:CallState={pending:false,status:'done'};const noop=()=>()=>{};
export function useRequest<T>(request?:Call<T>){return useSyncExternalStore(request?.subscribe??noop,request?.getSnapshot??(()=>idle as CallState<T>));}
export function Answer({request}:{request?:Call}){const state=useRequest(request);return state.pending?<Loading label={state.status==='offline'?'Waiting for connection…':'Saving…'}/>:state.result?.ok===false?<Error text={state.result.message}/>:null;}
export function Composer({member,place,agent,onOpened,enabled}:{member:string;place?:string;agent:string;onOpened(id:string):void;enabled:boolean}){
 const key=place??`new:${agent}`;const [draft,setDraft]=useState(()=>readDraft(member,key));const currentDraft=useRef<Draft>(draft);const [request,setRequest]=useState<Call<Ack>>();const state=useRequest(request);
 const [preview,setPreview]=useState<()=>Message[]>();
 const form=useRef<HTMLFormElement>(null),input=useRef<HTMLTextAreaElement>(null);
 useEffect(()=>form.current?bindComposerViewport(form.current):undefined,[]);
 const edit=(value:string)=>{const next=editDraft(currentDraft.current,value);currentDraft.current=next;setDraft(next);writeDraft(member,key,next);};
 async function send(event:FormEvent){event.preventDefault();if(!currentDraft.current.text.trim()||state.pending||!enabled)return;
  const sent=currentDraft.current;const {text,id}=sent;const task=call<Ack>(place?'comms.send':'comms.open',{...(place?{thread:place}:{agent}),id,text});
  setRequest(task);setPreview(()=>optimistic<Message[]>(task,[],rows=>[...rows,{id,thread:place??'',seq:0,at:Date.now(),kind:'message',from:member,text,delivery:'sending'}]));
  const result=await task.result;
  if(result.ok){clearDraft(member,key,sent);if(currentDraft.current===sent){const empty={id:'',text:''};currentDraft.current=empty;setDraft(empty);}if(!place)onOpened(result.value.thread);} // Failed sends retain the same words and id, including after reload.
 }
 return <form ref={form} onSubmit={send} className="grid gap-2 border-t p-4">
  {preview?.().map(m=><p key={m.id} className="whitespace-pre-wrap" aria-label="Sending message">{m.text} · Sending…</p>)}
  <label>Message<Textarea ref={input} value={draft.text} maxLength={40000} rows={3} onChange={e=>edit(e.target.value)} disabled={!enabled}/></label>
  <div><Button type="submit" onPointerDown={e=>{if(e.button===0&&document.activeElement===input.current)e.preventDefault();}} disabled={!enabled||state.pending||!draft.text.trim()}>Send</Button></div><Answer request={request}/>
 </form>;
}
