import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { useRecords, call, optimistic, type Call, type CallState } from '../../data';
import { Split, List, Row, Empty, Error, Loading, Button, Input, Textarea } from '../../kit';
import { readDraft, writeDraft, editDraft, clearDraft, type Draft } from './drafts';
import { replyHtml } from './render';
import { messageView, type Message } from './message';
interface Thread {id:string;member:string;agent:string;title:string|null;project?:string;pinned:boolean;archived:number|null;last:number;readSeq:number;unread:boolean;working:boolean;[key:string]:unknown}
interface Ack {thread:string;seq:number}
const idle:CallState={pending:false,status:'done'};const noop=()=>()=>{};
function useRequest<T>(request?:Call<T>){return useSyncExternalStore(request?.subscribe??noop,request?.getSnapshot??(()=>idle as CallState<T>));}
function Answer({request}:{request?:Call}){const state=useRequest(request);return state.pending?<Loading label={state.status==='offline'?'Waiting for connection…':'Saving…'}/>:state.result?.ok===false?<Error text={state.result.message}/>:null;}
function Composer({member,place,agent,onOpened,enabled}:{member:string;place?:string;agent:string;onOpened(id:string):void;enabled:boolean}){
 const key=place??`new:${agent}`;const [draft,setDraft]=useState(()=>readDraft(member,key));const currentDraft=useRef<Draft>(draft);const [request,setRequest]=useState<Call<Ack>>();const state=useRequest(request);
 const [preview,setPreview]=useState<()=>Message[]>();
 const edit=(value:string)=>{const next=editDraft(currentDraft.current,value);currentDraft.current=next;setDraft(next);writeDraft(member,key,next);};
 async function send(event:FormEvent){event.preventDefault();if(!currentDraft.current.text.trim()||state.pending||!enabled)return;
  const sent=currentDraft.current;const {text,id}=sent;const task=call<Ack>(place?'comms.send':'comms.open',{...(place?{thread:place}:{agent}),id,text});
  setRequest(task);setPreview(()=>optimistic<Message[]>(task,[],rows=>[...rows,{id,thread:place??'',seq:0,at:Date.now(),kind:'message',from:member,text,delivery:'sending'}]));
  const result=await task.result;
  if(result.ok){clearDraft(member,key,sent);if(currentDraft.current===sent){const empty={id:'',text:''};currentDraft.current=empty;setDraft(empty);}if(!place)onOpened(result.value.thread);} // Failed sends retain the same words and id, including after reload.
 }
 return <form onSubmit={send} className="grid gap-2 border-t p-4">
  {preview?.().map(m=><p key={m.id} className="whitespace-pre-wrap" aria-label="Sending message">{m.text} · Sending…</p>)}
  <label>Message<Textarea value={draft.text} maxLength={40000} rows={3} onChange={e=>edit(e.target.value)} disabled={!enabled}/></label>
  <div><Button type="submit" disabled={!enabled||state.pending||!draft.text.trim()}>Send</Button></div><Answer request={request}/>
 </form>;
}
function ThreadReader({thread,onDeleted}:{thread:Thread;onDeleted():void}){
 const {records,status}=useRecords<Message>('message',thread.id);const [request,setRequest]=useState<Call>();const state=useRequest(request);
 const [older,setOlder]=useState<Message[]>([]);const [title,setTitle]=useState(thread.title??'');const [project,setProject]=useState(thread.project??'');const [deleting,setDeleting]=useState(false);
 const [page,setPage]=useState<Call<Message[]>>();const pageState=useRequest(page);const lastRead=useRef(0);
 useEffect(()=>{if(status!=='live'){setOlder([]);return;}const seq=records.at(-1)?.seq??0;if(seq>lastRead.current&&document.visibilityState==='visible'&&document.hasFocus()){lastRead.current=seq;setRequest(call('comms.change',{thread:thread.id,action:'read',seq}));}},[records,status,thread.id]);
 const act=(action:string,extra:object={})=>{const r=call('comms.change',{thread:thread.id,action,...extra});setRequest(r);if(action==='delete')void r.result.then(result=>{if(result.ok)onDeleted();});};
 const load=async()=>{const task=call<Message[]>('comms.messages',{thread:thread.id,before:older[0]?.seq??records[0]?.seq});setPage(task);const result=await task.result;if(result.ok)setOlder(old=>[...result.value,...old]);};
 const all=status==='live'?[...older.filter(m=>!records.some(r=>r.id===m.id)),...records]:[];
 return <article className="flex h-full min-h-0 flex-col">
  <header className="grid gap-2 border-b p-4"><h1>{thread.title??`New thread with ${thread.agent}`}</h1><p>{thread.agent}{thread.working?' · Working':''}</p>
   <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={()=>act(thread.pinned?'unpin':'pin')}>{thread.pinned?'Unpin':'Pin'}</Button><Button variant="outline" onClick={()=>act(thread.archived===null?'archive':'unarchive')}>{thread.archived===null?'Archive':'Unarchive'}</Button><Button variant="outline" onClick={()=>act('stop')}>Stop</Button><Button variant="outline" onClick={()=>setDeleting(true)}>Delete</Button></div>
   <details><summary>Thread settings</summary><form onSubmit={e=>{e.preventDefault();act('title',{title});}}><label>Title<Input value={title} maxLength={60} onChange={e=>setTitle(e.target.value)}/></label><Button type="submit">Save title</Button></form><form onSubmit={e=>{e.preventDefault();act('project',{project:project||null});}}><label>Project<Input value={project} onChange={e=>setProject(e.target.value)}/></label><Button type="submit">File thread</Button></form></details>
   {deleting&&<section aria-label="Delete thread"><p>Delete this thread and all its words?</p><Button disabled={state.pending} onClick={()=>act('delete')}>Delete thread</Button><Button variant="outline" onClick={()=>setDeleting(false)}>Keep thread</Button></section>}
   <Answer request={request}/>
  </header>
  <div className="min-h-0 flex-1 overflow-auto p-4" aria-label="Thread messages">
   {status!=='live'?<Loading label="Waiting for thread connection…"/>:<><Button variant="outline" onClick={load} disabled={pageState.pending}>Load earlier messages</Button><Answer request={page}/><ol className="grid gap-4">{all.map(m=>{const view=messageView(m);return <li key={m.id} className="rounded border p-3"><p>{m.from} · {new Date(m.at).toLocaleString('en-US',{timeZone:'America/Chicago'})} CT{view.tool&&` · ${view.tool}`}{view.state&&` · ${view.state}`}</p>{view.text===null?(view.ask?null:<p>Words no longer kept</p>):<div className="prose break-words" dangerouslySetInnerHTML={{__html:replyHtml(view.text!)}}/>}{view.step!=null&&<details><summary>Work details</summary><pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify(view.step,null,2)}</pre></details>}{view.ask&&<section><p>{view.ask.question}</p>{view.ask.why&&<p>{view.ask.why}</p>}{view.ask.yes&&<p>Yes: {view.ask.yes}</p>}{view.ask.no&&<p>No: {view.ask.no}</p>}{view.ask.answered?<p>{view.ask.answer??'Answered'}</p>:view.ask.canAnswer?<><Button onClick={()=>setRequest(call('comms.answer',{thread:thread.id,ref:m.ref,verdict:'yes'}))}>Allow</Button><Button variant="outline" onClick={()=>setRequest(call('comms.answer',{thread:thread.id,ref:m.ref,verdict:'no'}))}>Deny</Button></>:<p>Answer in Inbox</p>}</section>}{m.kind==='message'&&(m.delivery==='failed'||m.delivery==='held')&&<Button variant="outline" onClick={()=>setRequest(call('comms.resend',{thread:thread.id,seq:m.seq}))}>{m.delivery==='held'?'Try released send':'Send again'}</Button>}</li>;})}</ol></>}
  </div>
  {thread.archived===null?<Composer member={thread.member} place={thread.id} agent={thread.agent} onOpened={()=>{}} enabled={status==='live'}/>:<p className="p-4">Unarchive this thread to send a message.</p>}
 </article>;
}
export default function CommsApp({path:shellPath,go}:{path?:string;go?:(path:string)=>void}={}){
 const [localPath,setLocalPath]=useState(()=>typeof location==='undefined'?'/p/comms-preview':location.pathname);const path=shellPath??localPath;const selected=path.split('/thread/')[1]?`th:${path.split('/thread/')[1]}`:undefined;const base='/p/comms-preview';
 const [folder,setFolder]=useState('live');const [creating,setCreating]=useState(false);const [agent,setAgent]=useState('');
 const {records,status}=useRecords<Thread>('thread',folder==='archived'?'archived':undefined);
 const [who,setWho]=useState<Call<{member:string;agents:string[]}>>();const identity=useRequest(who);
 useEffect(()=>{if(status==='live')setWho(call('comms.agents',{}));},[status]);
 const mine=identity.result?.ok?identity.result.value:undefined;
 const navigate=(id?:string)=>{const next=id?`${base}/thread/${id.replace(/^th:/,'')}`:base;if(go)go(next);else{history.pushState(null,'',next);setLocalPath(next);}setCreating(false);};
 useEffect(()=>{if(go)return;const pop=()=>setLocalPath(location.pathname);window.addEventListener('popstate',pop);return()=>window.removeEventListener('popstate',pop);},[go]);
 const current=records.find(t=>t.id===selected);const ownedAgent=agent||mine?.agents[0]||'';
 return <Split label="Comms" folder={folder} folders={[{id:'live',label:'Threads'},{id:'archived',label:'Archived'}]} onFolder={setFolder} listTitle="Threads" listMeta={records.length}
  listTop={<div className="p-3"><Button disabled={status!=='live'} onClick={()=>{navigate();setCreating(true);}}>New thread</Button></div>}
  list={status==='loading'?<Loading label="Opening Comms…"/>:status!=='live'?<Error text="Waiting for your signed-in connection."/>:<List label="Thread list">{[...records].sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.last-a.last).map(t=><Row key={t.id} title={t.title??`New thread with ${t.agent}`} meta={t.agent} unread={t.unread} selected={selected===t.id} onClick={()=>navigate(t.id)}/>)}</List>}
  reader={creating&&mine?<div className="grid gap-3 p-4"><h1>New thread</h1><label>Agent<select value={ownedAgent} onChange={e=>setAgent(e.target.value)}>{mine.agents.map(id=><option key={id}>{id}</option>)}</select></label>{ownedAgent?<Composer key={ownedAgent} member={mine.member} agent={ownedAgent} onOpened={navigate} enabled={status==='live'}/>:<Empty title="No agents available"/>}</div>:current?<ThreadReader key={current.id} thread={current} onDeleted={()=>navigate()}/>:selected?<Empty title="This thread is no longer in view"/>:null}
  open={!!selected||creating} onBack={()=>navigate()} backLabel="Threads" blank={<Empty title="Open a thread" text="Choose a thread or start one with your agent."/>}/>
}
