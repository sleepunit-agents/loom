import { useState, useEffect, useSyncExternalStore } from 'react';
import { useRecords, call, type Call } from '../../data';
import { Split, List, Row, Empty, Error, Loading, Button, Input } from '../../kit';
import type { ChangeRecord } from './model';
const idle={pending:false,status:'done' as const};const noop=()=>()=>{};
function useAnswer<T>(request?:Call<T>){return useSyncExternalStore(request?.subscribe??noop,request?.getSnapshot??(()=>idle));}
function Reader({change:c,enabled}:{change:ChangeRecord;enabled:boolean}){
 const [confirm,setConfirm]=useState<{record:ChangeRecord;request:Call<{open:boolean;person?:string}>}>();
 const checked=useAnswer(confirm?.request);
 const [answer,setAnswer]=useState<Call<unknown>>();const state=useAnswer(answer);
 const allowed=enabled&&confirm?.record===c&&checked.result?.ok&&checked.result.value.open&&!state.pending;
 const send=async(action:string)=>{
  // The visible confirmation is never authority for a send: the daemon checks again in its write transaction.
  if(!allowed||!checked.result?.ok) return;
  setAnswer(call('changes.answer',{id:c.id,head:c.head.id,action,...(checked.result.value.person?{person:checked.result.value.person}:{})}));setConfirm(undefined);
 };
 return <article className="grid gap-5 p-5">
  <header><p>{c.id} · {c.project??'Household'}</p><h1 className="text-2xl font-semibold">{c.title}</h1><p>{c.words}</p></header>
  {c.syncError&&<Error title="Repository read failed" text="Showing its last successful read. Refresh to try again."/>}
  <p>{c.author.name??c.author.login} · {c.head.ref} into {c.base.ref}</p>
  <section><h3>Checks</h3><p>{c.checks.state} · {c.checks.total} checks</p>{c.checks.failing.length>0&&<p>Failing: {c.checks.failing.join(', ')}</p>}{c.checks.running.length>0&&<p>Running: {c.checks.running.join(', ')}</p>}</section>
  <section><h3>Review</h3><p>{c.review.state.replaceAll('_',' ')}{c.review.by.length?` · ${c.review.by.join(', ')}`:''}</p>{c.people.filter(p=>p.role==='requested').map(p=><p key={p.login}>Requested from {p.name??p.login}</p>)}</section>
  <section><h3>Merge answer</h3><p>{c.rule?`${c.rule.tier}${c.rule.approval?` · ${c.rule.approval.state}`:''}`:'Approvals has not confirmed a rule.'}</p>
   {c.group==='you'&&<Button variant="outline" disabled={!enabled||checked.pending||state.pending} onClick={()=>setConfirm({record:c,request:call('changes.confirm',{id:c.id,head:c.head.id})})}>Check merge answer</Button>}
   {allowed&&<div className="flex flex-wrap gap-2"><Button onClick={()=>void send('yes')}>Yes, merge it</Button><Button variant="outline" onClick={()=>void send('not-yet')}>Not yet</Button>{!c.rule?.for&&c.project&&<Button variant="outline" onClick={()=>void send('always')}>Always for {c.project}</Button>}</div>}
   {checked.result&&!checked.result.ok&&<Error title="Couldn’t check" text={checked.result.message}/>}
   {checked.result?.ok&&!checked.result.value.open&&<p>This change is not waiting for your answer.</p>}
   {state.pending&&<Loading label="Saving answer…"/>}{state.result&&(state.result.ok?<p role="status">Answer saved. The agent will do the merge.</p>:<Error title="Couldn’t save" text={state.result.message}/>)}
  </section>
  <section><h3>Tasks</h3>{c.tasks.length?<List label="Tasks citing this change">{c.tasks.map(t=><Row key={t.id} title={t.title} meta={t.id} onClick={()=>location.assign(`/p/tasks-preview/task/${t.id}`)}/>)}</List>:<p>No tasks linked</p>}</section>
  {c.conversation&&<p>Made in conversation {c.conversation}</p>}
  <section><h3>Summary</h3><p className="whitespace-pre-wrap break-words">{c.body||'No description'}</p></section>
  {c.url&&<a href={c.url} target="_blank" rel="noreferrer">Open on GitHub</a>}
 </article>;
}
export default function ChangesApp({path:shellPath,go}:{path?:string;go?:(path:string)=>void}={}){
 const [localPath,setLocalPath]=useState(()=>typeof location==='undefined'?'/p/changes-preview':location.pathname);
 const path=shellPath??localPath,selected=path.includes('/change/')?decodeURIComponent(path.split('/change/')[1]):undefined;
 const navigate=(id?:string)=>{const next='/p/changes-preview'+(id?`/change/${encodeURIComponent(id)}`:'');if(go) go(next);else {history.pushState(null,'',next);setLocalPath(next);}};
 useEffect(()=>{if(go) return;const pop=()=>setLocalPath(location.pathname);window.addEventListener('popstate',pop);return()=>window.removeEventListener('popstate',pop);},[go]);
 const {records,status}=useRecords<ChangeRecord>('change'),sync=useRecords('change-sync');
 const [folder,setFolder]=useState('all'),[query,setQuery]=useState(''),[refresh,setRefresh]=useState<Call<unknown>>();const state=useAnswer(refresh);
 const projects=[...new Set(records.map(c=>c.project).filter(Boolean))] as string[];
 const rows=records.filter(c=>(folder==='all'||folder==='you'&&c.group==='you'||folder==='done'&&c.state!=='open'||folder.startsWith('project:')&&c.project===folder.slice(8))&&[c.id,c.title,c.author.login,c.project,c.words].join(' ').toLowerCase().includes(query.toLowerCase())).sort((a,b)=>['you','agent','ci','reviewer','author','done'].indexOf(a.group)-['you','agent','ci','reviewer','author','done'].indexOf(b.group)||Date.parse(b.updated??'')-Date.parse(a.updated??''));
 const opened=records.find(c=>c.id===selected);
 return <Split label="Changes" className="h-full" folders={[{id:'all',label:'All changes'},{id:'you',label:'Waiting on you'},{id:'done',label:'Lately'},...projects.map(p=>({id:`project:${p}`,label:p}))]} folder={folder} onFolder={setFolder} listTitle="Changes" listMeta={String(rows.length)} open={!!selected} backLabel="Changes" onBack={()=>navigate()} search={<Input aria-label="Search changes" placeholder="Search changes" value={query} onChange={e=>setQuery(e.target.value)}/>}
  listTop={<><Button variant="outline" disabled={status!=='live'||state.pending} onClick={()=>setRefresh(call('changes.refresh',{}))}>Refresh</Button>{state.result&&!state.result.ok&&<Error title="Couldn’t refresh" text={state.result.message}/>} {sync.records[0]?.at&&<span>Last read {new Date(Number(sync.records[0].at)).toLocaleString('en-US',{timeZone:'America/Chicago'})} CT</span>}</>}
  list={status==='loading'?<Loading label="Reading changes…"/>:status!=='live'?<Error title={status==='denied'?'Changes unavailable':'Disconnected'} text="Reconnect to see current changes and answer merges."/>:rows.length?<List label="Pull requests">{rows.map(c=><Row key={c.id} title={c.title} meta={`${c.id} · ${c.project??'Household'}`} status={c.words} selected={c.id===selected} onClick={()=>navigate(c.id)}/>)}</List>:<Empty title={query?'Nothing matches your search':'No changes yet'} text="Changes appear when the daemon reads the repositories your household projects name."/>}
  reader={opened?<Reader key={opened.id} change={opened} enabled={status==='live'}/>:<Empty title={selected?'Change unavailable':'Choose a change'} text="Select a pull request to read its checks, reviews and tasks."/>}/>;
}
