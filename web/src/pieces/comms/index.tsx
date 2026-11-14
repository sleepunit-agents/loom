import { useContext, useEffect, useRef, useState } from 'react';
import { useRecords, call, type Call } from '../../data';
import { Split, List, Empty, Error, Loading, Button, Input } from '../../kit';
import { Composer, Answer, useRequest } from './composer';
import { replyHtml } from './render';
import { latestHarness, messageView, type Message } from './message';
import { thinkingView, workingView } from './working';
import { EarlierPages, retainedMessage } from './pages';
import { ConversationActivity } from './conversation';
import { useReplyFollow } from './use-follow';
import { bindThreadRead } from './read';
import { folderThreads, watchingJob } from './threads';
import { Work } from './work';
import { SealedQuestion } from './question';
import { ThreadRow } from './thread-row';
import './comms.css';
import { CommPortrait } from './portrait';
import { RailContext } from '../../desk-rail';
interface Thread {id:string;member:string;agent:string;title:string|null;project?:string;pinned:boolean;archived:number|null;last:number;readSeq:number;unread:boolean;working:boolean;workingSince?:number|null;alive?:{at:number;tokens?:number};job?:false|{joined:boolean};[key:string]:unknown}
function ThreadReader({thread,onDeleted}:{thread:Thread;onDeleted():void}){
 const [joining,setJoining]=useState(false);const watching=watchingJob(thread.job,joining);
 const {records,status}=useRecords<Message>('message',thread.id);const [request,setRequest]=useState<Call>();const state=useRequest(request);
 const [pages]=useState(()=>new EarlierPages());const [older,setOlder]=useState<Message[]>([]);const current=useRef<readonly Message[]|undefined>(undefined);current.current=status==='live'?records:undefined;const pageOwner=useRef(current.current);const [title,setTitle]=useState(thread.title??'');const [project,setProject]=useState(thread.project??'');const [deleting,setDeleting]=useState(false);
 const [pagePending,setPagePending]=useState(false),[pageError,setPageError]=useState<string>();
 const latestSeq=records.at(-1)?.seq??0;
 useEffect(()=>{if(status!=='live')return;return bindThreadRead(latestSeq,async seq=>{const r=call('comms.change',{thread:thread.id,action:'read',seq});return (await r.result).ok;});},[latestSeq,status,thread.id]);
 // Fence cached words immediately at render, then clear them and pending reads.
 useEffect(()=>{pageOwner.current=current.current;pages.clear();setOlder([]);setPagePending(false);setPageError(undefined);},[records,status,pages]);
 useEffect(()=>()=>{current.current=undefined;pages.clear();},[pages]);
 const act=(action:string,extra:object={})=>{const r=call('comms.change',{thread:thread.id,action,...extra});setRequest(r);if(action==='delete')void r.result.then(result=>{if(result.ok)onDeleted();});};
 const load=async()=>{if(status!=='live'||pagePending)return;const original=records,generation=pages.begin();setPagePending(true);setPageError(undefined);
  // A successful Call holds plaintext; keep it local to the request.
  const result=await call<Message[]>('comms.messages',{thread:thread.id,before:older[0]?.seq??records[0]?.seq}).result;
  if(current.current!==original||generation!==pages.begin())return;
  setPagePending(false);if(result.ok){if(pages.accept(generation,result.value,Date.now()))setOlder(pages.rows);}else setPageError(result.message);
 };
 const all=status==='live'?[...(pageOwner.current===records?older:[]).filter(m=>!records.some(r=>r.id===m.id)),...records].map(m=>retainedMessage(m,Date.now())):[];
 const [now,setNow]=useState(Date.now);
 useEffect(()=>{if(status!=='live'||!thread.working)return;setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[status,thread.working]);
 // Earlier pages have no Live subscription. Expire them even when no body is running.
 useEffect(()=>{
  if(status!=='live')return;
  if(older.some(m=>typeof m.keepUntil==='number'&&m.keepUntil<=Date.now())){pages.expire(Date.now());setOlder(pages.rows);}
  const deadlines=[...older,...records].map(m=>m.keepUntil).filter((v):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>Date.now());
  if(!deadlines.length)return;
  const timer=setTimeout(()=>{pages.expire(Date.now());setOlder(pages.rows);setNow(Date.now());},Math.min(2147483647,Math.max(1,Math.min(...deadlines)-Date.now())));
  return()=>clearTimeout(timer);
 },[older,records,status,pages,now]);
 const working=workingView(thread,all,now,status==='live'),thinking=thinkingView(thread,all,status==='live'),on=latestHarness(all);
 const scroller=useRef<HTMLDivElement>(null);const follow=useReplyFollow(scroller,records,status==='live');
 return <article className="comms-thread flex min-h-0 flex-1 flex-col">
  <header className="grid gap-2 border-b p-4"><CommPortrait agent={thread.agent} messages={all} connected={status==='live'} working={!!working} thinking={!!thinking} on={on}/><h1>{thread.title??`New thread with ${thread.agent}`}</h1><p>{thread.agent}{on&&<span aria-label="Reply harness"> · ON {on.toUpperCase()}</span>}</p>
   {thinking&&<p role="status" aria-label="Thinking status">{thinking}</p>}
   {working&&<p role="status" aria-label="Working status" data-alive={working.face}>{working.text}</p>}
   {status==='live'&&thread.working&&thread.alive&&<p aria-label="Body activity">Last body activity <time dateTime={new Date(thread.alive.at).toISOString()}>{new Date(thread.alive.at).toLocaleString('en-US',{timeZone:'America/Chicago'})} CT</time>{thread.alive.tokens!==undefined&&` · ${thread.alive.tokens.toLocaleString('en-US')} tokens`}</p>}
   <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={()=>act(thread.pinned?'unpin':'pin')}>{thread.pinned?'Unpin':'Pin'}</Button><Button variant="outline" onClick={()=>act(thread.archived===null?'archive':'unarchive')}>{thread.archived===null?'Archive':'Unarchive'}</Button>{!watching&&thread.archived===null&&thread.working&&<Button variant="outline" disabled={status!=='live'||state.pending} onClick={()=>act('stop')}>Stop</Button>}<Button variant="outline" onClick={()=>setDeleting(true)}>Delete</Button></div>
   <details><summary>Thread settings</summary><form onSubmit={e=>{e.preventDefault();act('title',{title});}}><label>Title<Input value={title} maxLength={60} onChange={e=>setTitle(e.target.value)}/></label><Button type="submit">Save title</Button></form><form onSubmit={e=>{e.preventDefault();act('project',{project:project||null});}}><label>Project<Input value={project} onChange={e=>setProject(e.target.value)}/></label><Button type="submit">File thread</Button></form></details>
   {deleting&&<section aria-label="Delete thread"><p>Delete this thread and all its words?</p><Button disabled={state.pending} onClick={()=>act('delete')}>Delete thread</Button><Button variant="outline" onClick={()=>setDeleting(false)}>Keep thread</Button></section>}
   <Answer request={request}/>
  </header>
  <Work thread={thread.id} agent={thread.agent} member={thread.member}/>
  <div ref={scroller} onScroll={follow.onScroll} className="min-h-0 flex-1 overflow-auto p-4" aria-label="Thread messages">
   {status!=='live'?<Loading label="Waiting for thread connection…"/>:<><Button variant="outline" onClick={load} disabled={pagePending}>Load earlier messages</Button>{pageError&&<Error text={pageError}/>}<ol className="grid gap-4">{all.map(m=>{const view=messageView(m);return <li key={m.id} className="rounded border p-3"><p>{m.from} · {new Date(m.at).toLocaleString('en-US',{timeZone:'America/Chicago'})} CT{view.tool&&` · ${view.tool}`}{view.state&&` · ${view.state}`}</p>{view.text===null?(view.ask?null:<p>Words no longer kept</p>):<div className="prose break-words" dangerouslySetInnerHTML={{__html:replyHtml(view.text!)}}/>}{view.nextRetry&&<p aria-label="Start retry">Next try at <time dateTime={view.nextRetry}>{new Date(view.nextRetry).toLocaleTimeString('en-US',{timeZone:'America/Chicago',hour:'2-digit',minute:'2-digit'})} CT</time>.</p>}{view.retryStart&&thread.archived===null&&<Button variant="outline" disabled={state.pending} onClick={()=>setRequest(call('comms.retryStart',{thread:thread.id,...view.retryStart}))}>Send again</Button>}{view.step!=null&&<details><summary>Work details</summary><pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify(view.step,null,2)}</pre></details>}{m.sealedQuestion===true&&typeof m.ref==='string'?<SealedQuestion key={`${thread.member}/${thread.agent}/${m.ref}`} thread={thread} seq={m.seq} refId={m.ref}/>:view.ask&&<section><p>{view.ask.question}</p>{view.ask.why&&<p>{view.ask.why}</p>}{view.ask.yes&&<p>Yes: {view.ask.yes}</p>}{view.ask.no&&<p>No: {view.ask.no}</p>}{view.ask.answered?<p>{view.ask.answer??'Answered'}</p>:view.ask.canAnswer?<><Button onClick={()=>setRequest(call('comms.answer',{thread:thread.id,ref:m.ref,verdict:'yes'}))}>Allow</Button><Button variant="outline" onClick={()=>setRequest(call('comms.answer',{thread:thread.id,ref:m.ref,verdict:'no'}))}>Deny</Button></>:<p>Answer in Inbox</p>}</section>}{m.kind==='message'&&(m.delivery==='failed'||m.delivery==='held')&&<Button variant="outline" onClick={()=>setRequest(call('comms.resend',{thread:thread.id,seq:m.seq}))}>{m.delivery==='held'?'Try released send':'Send again'}</Button>}</li>;})}</ol></>}
  </div>
  {follow.unread>0&&<div className="comms-new-messages px-4 py-2"><Button variant="outline" onClick={follow.down}>New messages ↓ ({follow.unread})</Button></div>}
  {thread.archived!==null?<p className="p-4">Unarchive this thread to send a message.</p>:watching?<div className="flex items-center justify-between gap-3 border-t p-4" role="status" aria-label="Watching job"><p><strong>Watching</strong> · {thread.working?`${thread.agent} keeps working when you close this.`:'Closing this leaves the job as it is.'}</p><Button disabled={status!=='live'} onClick={()=>setJoining(true)}>Join in</Button></div>:<Composer member={thread.member} place={thread.id} agent={thread.agent} onOpened={()=>{}} enabled={status==='live'}/>}
 </article>;
}
export default function CommsApp({path:shellPath,go,visible=true}:{path?:string;go?:(path:string)=>void;visible?:boolean}={}){
 const [localPath,setLocalPath]=useState(()=>typeof location==='undefined'?'/p/comms-preview':location.pathname);const path=shellPath??localPath;const selected=path.split('/thread/')[1]?`th:${path.split('/thread/')[1]}`:undefined;const base='/p/comms-preview';
 const [rowRequest,setRowRequest]=useState<Call>();const rowState=useRequest(rowRequest);
 const [folder,setFolder]=useState('live');const creating=path===`${base}/new`;const [agent,setAgent]=useState('');
 const {records,status}=useRecords<Thread>('thread','all');
 const [who,setWho]=useState<Call<{member:string;agents:string[]}>>();const identity=useRequest(who);
 useEffect(()=>{if(status==='live')setWho(call('comms.agents',{}));},[status]);
 const mine=identity.result?.ok?identity.result.value:undefined;
 const visit=(next:string)=>{if(go)go(next);else{history.pushState(null,'',next);setLocalPath(next);}};
 const navigate=(id?:string)=>visit(id?`${base}/thread/${id.replace(/^th:/,'')}`:base);
 useEffect(()=>{if(go)return;const pop=()=>setLocalPath(location.pathname);window.addEventListener('popstate',pop);return()=>window.removeEventListener('popstate',pop);},[go]);
 const conversationPath=path.startsWith(`${base}/conversation/`)?path.slice(`${base}/conversation/`.length):undefined;
 let conversation:string|undefined;try{conversation=conversationPath?decodeURIComponent(conversationPath):undefined;}catch{/* Invalid route stays unavailable. */}
 const rail=useContext(RailContext),source=useRef({});
 const current=status==='live'&&!conversation?records.find(t=>t.id===selected):undefined;
 useEffect(()=>{if(!visible||!current||!rail?.onAir)return;rail.onAir({agent:current.agent},source.current);return()=>rail.onAir(null,source.current);},[visible,current?.id,current?.agent,rail?.onAir]);
 if(conversation)return <ConversationActivity key={conversation} conversation={conversation} onBack={()=>navigate()}/>;
 const listed=folderThreads(records,folder);const ownedAgent=agent||mine?.agents[0]||'';
 return <Split className="loom-comms" label="Comms" folder={folder} folders={[{id:'live',label:'Threads'},{id:'background',label:'Background work'},{id:'archived',label:'Archived'}]} onFolder={setFolder} listTitle={folder==='background'?'Background work':folder==='archived'?'Archived':'Threads'} listMeta={listed.length}
  listTop={<div className="p-3"><Button disabled={status!=='live'} onClick={()=>visit(`${base}/new`)}>New thread</Button><Answer request={rowRequest}/></div>}
  list={status==='loading'?<Loading label="Opening Comms…"/>:status!=='live'?<Error text="Waiting for your signed-in connection."/>:<List label="Thread list">{listed.map(t=><ThreadRow key={t.id} thread={t} selected={selected===t.id} disabled={status!=='live'||rowState.pending} onOpen={()=>navigate(t.id)} onAction={action=>setRowRequest(call('comms.change',{thread:t.id,action}))}/>)}</List>}
  reader={creating&&mine?<div className="grid gap-3 p-4"><h1>New thread</h1><label>Agent<select value={ownedAgent} onChange={e=>setAgent(e.target.value)}>{mine.agents.map(id=><option key={id}>{id}</option>)}</select></label>{ownedAgent?<Composer key={ownedAgent} member={mine.member} agent={ownedAgent} onOpened={navigate} enabled={status==='live'}/>:<Empty title="No agents available"/>}</div>:current?<ThreadReader key={current.id} thread={current} onDeleted={()=>navigate()}/>:selected?<Empty title="This thread is no longer in view"/>:null}
  open={!!selected||creating} onBack={()=>navigate()} backLabel="Threads" blank={<Empty title="Open a thread" text="Choose a thread or start one with your agent."/>}/>
}
