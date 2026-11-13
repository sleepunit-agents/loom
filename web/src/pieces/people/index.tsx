import { useEffect, useState, useSyncExternalStore } from 'react';
import { call, useRecords, type Call } from '../../data';
import { Split, List, Row, Empty, Loading, Error, Button, Input, Textarea } from '../../kit';
import { contacts, contactLink, type Person } from './model';
const idle={pending:false,status:'done' as const};
const noop=()=>()=>{};
const blank={name:'',summary:'',channel:'',handle:''};
interface Access {[key:string]:unknown;id:string;allowed:boolean;directory:boolean;agents:string[];canAdd:boolean}
function Reader({person,relationships,conversations,conversationStatus,go}:{person:Person;relationships:Person[];conversations:{available:boolean;rows:{id:string;title:string;href:string}[]}|undefined;conversationStatus:string;go?:(path:string)=>void}) {
  const fields=(p:Person)=><dl className="grid gap-3">{p.fields.map(f=><div key={f.key}><dt>{f.key}</dt><dd>{contactLink(f.key,p.card.where[f.key]?.value) ? <a className="underline" href={contactLink(f.key,p.card.where[f.key]?.value)}>{f.value}</a>:f.value} · {f.state}{f.verifiedAt && ` · verified ${f.verifiedAt.slice(0,10)}`}{f.source && <p>Source: {f.source}</p>}</dd></div>)}</dl>;
  const facts=(p:Person)=><dl className="grid gap-2">{Object.entries(p.card.how??{}).map(([key,value])=><div key={key}><dt>{key}</dt><dd>{Array.isArray(value)?value.join(', '):String(value)}</dd></div>)}</dl>;
  return <article className="grid gap-5 p-5"><header><p>{person.kind==='agent'?'Agent':'Person'}</p><h1 className="text-2xl font-semibold">{person.name}</h1>{person.card.summary && <p>{person.card.summary}</p>}{person.mergedFrom && <p>{person.mergedFrom} was merged into {person.slug}.</p>}</header>
    {person.ownership && <section><h2>Owns</h2><p>{person.ownership.owner?'The household and every agent':person.ownership.agents.join(', ')}</p><a className="underline" href="/p/sharing-preview">Open Sharing</a></section>}
    <section><h2>How to reach them</h2>{person.fields.length?fields(person):<p>No contact details recorded.</p>}</section>
    <section><h2>Facts</h2>{facts(person)}</section>
    <section><h2>Relationships</h2>{relationships.length?relationships.map(p=><section key={p.id} className="grid gap-3 border-t py-3"><h3>{p.agent}</h3>{p.card.summary && <p>{p.card.summary}</p>}<p>Updated {p.updated.slice(0,10)} · {p.newer} memories newer than this card</p>{facts(p)}{p.fields.length>0&&fields(p)}
      {p.card.may.length>0&&<div><h4>Recorded permissions</h4>{p.card.may.map((m,i)=><p key={i}>{m.text} · {m.source}</p>)}<p>These records do not grant access.</p></div>}
      <h4>Evidence</h4>{p.evidence.length?p.evidence.map((e,i)=><details key={i}><summary>{e.title} · {e.created.slice(0,10)}</summary><p className="whitespace-pre-wrap">{e.content}</p><p>{e.category}</p></details>):<p>No active evidence recorded.</p>}
    </section>):<p>No relationship cards available to you.</p>}</section>
    <section><h2>Projects</h2>{person.projects.length?person.projects.map(p=><p key={`${p.agent}:${p.slug}`}><a className="underline" href={`/p/projects-preview/project/${encodeURIComponent(`${p.agent}:${p.slug}`)}`}>{p.name}</a> · {p.status} · {p.agent}</p>):<p>No linked projects.</p>}</section>
    <section><h2>Conversations</h2>{conversationStatus==='offline'||conversationStatus==='denied'?<Error text={conversationStatus==='denied'?'You don’t have access to these conversations.':'Connection lost. Conversations will return when connected.'}/>:!conversations?<Loading label="Opening conversations…"/>:!conversations.available?<p>Conversation service is not available yet.</p>:conversations.rows.length?conversations.rows.map(c=><p key={c.id}><a className="underline" href={c.href} onClick={e=>{if(go && !e.metaKey&&!e.ctrlKey&&!e.shiftKey&&!e.altKey){e.preventDefault();go(c.href);}}}>{c.title}</a></p>):<p>No conversations of yours with this contact.</p>}</section>
    <section><h2>Access</h2><p>Contact details and relationship notes do not grant access.</p><a className="underline" href="/p/sharing-preview">Open Sharing</a></section>
  </article>;
}
export default function PeopleApp({path:shellPath,go}:{path?:string;go?:(path:string)=>void}={}) {
  const base='/p/people-preview';
  const [local,setLocal]=useState(()=>typeof location==='undefined'?base:location.pathname);
  const path=(shellPath??local).split('?')[0];let selected:string|undefined;
  try {selected=path.startsWith(`${base}/person/`)?decodeURIComponent(path.slice(`${base}/person/`.length)):undefined;}catch{/* malformed link */}
  const navigate=(slug?:string)=>{const next=slug?`${base}/person/${encodeURIComponent(slug)}`:base;if(go)go(next);else{history.pushState(null,'',next);setLocal(next);}};
  useEffect(()=>{if(go)return;const pop=()=>setLocal(location.pathname);window.addEventListener('popstate',pop);return()=>window.removeEventListener('popstate',pop);},[go]);
  const access=useRecords<Access>('people.access'), feed=useRecords<Person>('person');
  const permission=access.status==='live'?access.records[0]:undefined;
  const [folder,setFolder]=useState('all'),[query,setQuery]=useState(''),[agent,setAgent]=useState('');
  const [adding,setAdding]=useState(false),[draft,setDraft]=useState(blank),[request,setRequest]=useState<Call>();
  const answer=useSyncExternalStore(request?.subscribe??noop,request?.getSnapshot??(()=>idle));
  const all=contacts(feed.records,'all','',''), shown=contacts(feed.records,folder,query,agent);
  const detail=useRecords<Person>('person',selected?`commons:${selected}`:'');
  const direct=detail.status==='live'?detail.records[0]:undefined;
  const group=all.find(g=>g.person.slug===(direct?.slug??selected)), person=direct??group?.person;
  const conversations=useRecords<{id:string;available:boolean;rows:{id:string;title:string;href:string}[]}>('people.conversations',person?.id??'');
  const unavailable=(status:string)=><Error text={status==='denied'?'You don’t have access to People.':'Connection lost. People will return when connected.'}/>;
  if(access.status==='loading')return <Loading label="Opening people…"/>;
  if(access.status!=='live')return unavailable(access.status);
  if(!permission?.allowed)return unavailable('denied');
  const form=<form aria-label="Add a person" className="grid gap-4 p-5" onSubmit={e=>{e.preventDefault();if(!permission.canAdd||answer.pending||answer.result?.ok||(answer.result?.ok===false&&answer.result.code==='unavailable'))return;setRequest(call('mind.personAdd',draft));}}><h1>Add a person</h1><p>Contact details are shared. Their summary belongs to the default agent’s relationship.</p><fieldset className="grid gap-3" disabled={!permission.canAdd||answer.pending||answer.result?.ok===true||(answer.result?.ok===false&&answer.result.code==='unavailable')}>
    <label>Name<Input required maxLength={80} value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
    <label>Who they are<Textarea maxLength={1200} value={draft.summary} onChange={e=>setDraft({...draft,summary:e.target.value})}/></label>
    <label>Reach them on<select value={draft.channel} onChange={e=>setDraft({...draft,channel:e.target.value})}><option value="">Not yet</option>{['slack','discord','email','phone','github'].map(c=><option key={c}>{c}</option>)}</select></label>
    <label>Their handle or address<Input maxLength={200} value={draft.handle} onChange={e=>setDraft({...draft,handle:e.target.value})}/></label><Button type="submit">Add</Button></fieldset>
    {answer.pending?<Loading label={answer.status==='offline'?'Waiting for connection…':'Saving person…'}/>:answer.result&&(!answer.result.ok?<div><Error text={`${answer.result.code}: ${answer.result.message}`}/>{answer.result.code==='unavailable'&&<Button type="button" onClick={()=>request?.retry?.()}>Retry this save</Button>}</div>:<div role="status">Added to People<Button type="button" onClick={()=>{if(answer.result?.ok){setAdding(false);navigate((answer.result.value as {slug:string}).slug);}}}>Open person</Button><Button type="button" onClick={()=>{setDraft(blank);setRequest(undefined);}}>Add another</Button></div>)}
  </form>;
  return <Split className="h-full" label="People" folders={[{id:'all',label:'Everyone',count:all.length},{id:'person',label:'People',count:all.filter(g=>g.person.kind==='person').length},{id:'agent',label:'Agents',count:all.filter(g=>g.person.kind==='agent').length}]} folder={folder} onFolder={setFolder}
    search={<div className="grid gap-2"><label>Search people<Input type="search" value={query} onChange={e=>setQuery(e.target.value)}/></label><label>Known to agent<select value={agent} onChange={e=>setAgent(e.target.value)}><option value="">All authorized agents</option>{permission.agents.map(a=><option key={a}>{a}</option>)}</select></label></div>}
    listTop={<div className="p-3"><Button disabled={!permission.canAdd} onClick={()=>setAdding(true)}>Add a person</Button></div>} listTitle="Contacts" listMeta={`${shown.length} contacts`}
    list={feed.status==='loading'?<Loading label="Opening contacts…"/>:feed.status!=='live'?unavailable(feed.status):<><List label="Contacts">{shown.map(g=><Row key={g.person.id} title={g.person.name} meta={g.relationships.length?`Known to ${g.relationships.map(p=>p.agent).join(', ')}`:'No relationship cards available'} status={g.person.fields.some(f=>f.state==='stale')?'Stale contact details':g.person.kind} selected={selected===g.person.slug} onClick={()=>{setAdding(false);navigate(g.person.slug);}}/>)}</List>{!shown.length&&<Empty title={query.trim()?`Nothing matches “${query.trim()}”`:all.length?'No contacts here':'No people yet'} text="People your agents meet appear here."/>}</>}
    reader={adding?form:feed.status==='loading'||(!!selected&&!person&&permission.directory&&detail.status==='loading')?<Loading label="Opening contact…"/>:feed.status!=='live'?unavailable(feed.status):person?<Reader person={person} relationships={group?.relationships??[]} conversations={conversations.status==='live'?conversations.records[0]:undefined} conversationStatus={conversations.status} go={go}/>:selected?<Empty title="This contact is no longer available" text="It may have been archived or merged."/>:null}
    open={!!selected||adding} onBack={()=>{setAdding(false);navigate();}} backLabel="Contacts" blank={<Empty title="Open a contact" text="Choose someone to see their contact details and your agents’ relationships."/>}/>;
}
