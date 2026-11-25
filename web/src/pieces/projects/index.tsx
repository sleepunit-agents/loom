import {ToolbarControls} from '../../kit/toolbar';
import { NativeSelect } from '../../kit/native-select';
import {useState,useEffect} from 'react';
import {useMemoryRecord,useMemoryList} from '../../memory/query';
import {memoryQueries} from '../../memory/queries';
import {Reader as PageReader,Section as ReaderSection,Disclosure,Title,Meta,Facts,Fact,Search,Field,Split,List,Empty,Loading,Error} from '../../kit';
import {Avatar,AvatarFallback} from '../../components/ui/avatar';
import AgentFace, { useAgentDisplays, type AgentDisplay } from '../attention/agent-face';
import {projects,whatOf,safeHref,age,type ProjectRecord,type ProjectItem,type ProjectSection} from './model';
export const projectsSession={folder:'active',query:'',agent:''};
function Person({name,agent,display}:{name:string;agent?:boolean;display?:AgentDisplay}){return agent?<AgentFace display={display} name={name} size={24} state="idle"/>:<Avatar size="sm" aria-label={name}><AvatarFallback>{name.trim().split(/\s+/).map(n=>n[0]).slice(0,2).join('')}</AvatarFallback></Avatar>;}
function Link({item,go,now,person}:{item:ProjectItem;now?:number;person?:boolean;go?:(path:string)=>void}){
 const href=safeHref(item.href);
 return <li className="grid gap-1 py-2"><p>{person&&<Person name={item.title}/>} {href?<a className="underline" href={href} onClick={e=>{if(go&&href.startsWith('/')&&!e.metaKey&&!e.ctrlKey&&!e.shiftKey&&!e.altKey){e.preventDefault();go(href);}}}>{item.title}</a>:item.title}{item.status&&<span> · {item.status}</span>}{item.new&&<span> · new</span>}</p><p className="text-sm text-muted-foreground">{[item.when?age(item.when,now):undefined,...(item.who??[]),item.ref].filter(Boolean).join(' · ')}</p>{item.body&&<Disclosure label="Details"><p className="whitespace-pre-wrap">{item.body}</p></Disclosure>}</li>;
}
function Section({s,go,now}:{s:ProjectSection;now?:number;go?:(path:string)=>void}){
 const body=s.error?<Error text={s.error}/>:!s.available?<p>{s.label} service is not available yet.</p>:<>{s.groups?.filter(g=>!g.waiting).map(g=><div key={g.title}><h3 className="font-medium">{g.title}</h3><ul>{g.items.map((item,i)=><Link key={i} item={item} go={go} now={now} person={s.key==='people'}/>)}</ul></div>)}<ul>{s.items?.filter(i=>!i.waiting).map((item,i)=><Link key={i} item={item} go={go} now={now} person={s.key==='people'}/>)}</ul>{!(s.items?.length||s.groups?.some(g=>!g.waiting&&g.items.length))&&<p>Nothing else here.</p>}{s.total!==undefined&&<p>{s.total} in all; {s.items?.length??0} shown.</p>}{s.counts&&<p>{Object.entries(s.counts).map(([key,n])=>`${key}: ${n}`).join(' · ')}</p>}</>;
 return ['notes','memories'].includes(s.key)?<Disclosure label={s.label}>{body}</Disclosure>:<ReaderSection label={s.label}>{body}</ReaderSection>;
}
function Reader({project:p,go}:{project:ProjectRecord;go?:(path:string)=>void}){
 if(p.archived)return <Empty title="This project is archived" text={p.name}/>;
 return <PageReader className="p-5"><header><Meta>{p.agent} · {p.card.status}</Meta><Title as="h1">{p.name}</Title>{p.card.summary&&<p className="whitespace-pre-wrap">{p.card.summary}</p>}</header>
  <ReaderSection label="Goal and where it stands">{p.card.goal&&<p>{p.card.goal}</p>}<Facts>{p.fields.map(f=><Fact key={f.key} label={f.key}>{f.value} · {f.state}{p.card.where[f.key].verified_at&&` · ${p.card.where[f.key].verified_at}`}{p.card.where[f.key].source&&` · ${p.card.where[f.key].source}`}</Fact>)}</Facts></ReaderSection>
  <ReaderSection label="Waiting on you">{p.waiting.length?<ul>{p.waiting.map((i,n)=><Link key={n} item={i} go={go} now={p.now}/>)}</ul>:<p>{p.unknown?'No known waiting items.':'Nothing waiting on you.'}</p>}{p.unknown&&<p role="status">Couldn’t count everything waiting; a section is unavailable.</p>}</ReaderSection>
  {p.sections.map(s=><Section key={s.key} s={s} go={go} now={p.now}/>)}
  {!!p.card.links.repos?.length&&<ReaderSection label="Repositories"><ul>{p.card.links.repos.map(r=><li key={r}>{r.replace(/^github:/,'')}</li>)}</ul></ReaderSection>}
 </PageReader>;
}
function Card({p,selected,onClick,displays}:{p:ProjectRecord;displays:AgentDisplay[];selected:boolean;onClick:()=>void}){
 return <li><button type="button" data-split-row aria-current={selected?'true':undefined} onClick={onClick} className="grid w-full gap-3 border-b p-4 text-left hover:bg-muted focus-visible:outline"><span className="flex justify-between gap-3"><strong>{p.name}</strong><span>{p.card.status}</span></span><span>{p.agent} · {whatOf(p.card.summary)}</span>{p.card.status==='active'&&<><strong>{p.unknown&&<>Couldn’t count everything · </>}{p.waiting.length?`${p.waiting.length} for you · ${p.waiting.slice(0,4).map(i=>i.title).join(' · ')}`:p.unknown?"Couldn't count what's waiting":'Nothing waiting on you'}</strong>{!!p.lately.length&&<span>Lately: {p.lately.map(i=>`${i.title}${i.when?` · ${age(i.when,p.now)}`:''}${i.status?` (${i.status})`:''}`).join(' · ')}</span>}{p.spark.some(Boolean)&&<span aria-label={`${p.spark.reduce((a,b)=>a+b,0)} dated things in this project's sections over the last 7 days`} className="flex h-5 items-end gap-1">{p.spark.map((n,i)=><span key={i} className="w-2 bg-primary" style={{height:`${Math.max(2,n/Math.max(...p.spark)*20)}px`}}/>)}</span>}{p.changes&&<span>{p.changes.open} open · {p.changes.failing} failing · {p.changes.running} checking</span>}</>}<span className="flex items-center gap-2">{p.people.slice(0,4).map(name=><span key={name} className="inline-flex items-center gap-1"><Person name={name} display={displays.find(d=>d.id.toLowerCase()===name.toLowerCase())} agent={p.agents?.some(a=>a.toLowerCase()===name.toLowerCase())}/>{name}</span>)}{p.people.length>4?` +${p.people.length-4}`:''}</span><span>{(p.card.links.repos??[]).slice(0,6).map(r=>r.replace(/^github:/,'')).join(' · ')}{(p.card.links.repos?.length??0)>6?` +${p.card.links.repos!.length-6}`:''}</span><span className="text-sm text-muted-foreground">Activity {age(p.activity,p.now)}</span></button></li>;
}
export default function ProjectsApp({path:shellPath,go,base='/p/projects-preview',cardIds}:{path?:string;go?:(path:string)=>void;base?:string;cardIds?:ReadonlySet<string>}={}){
 const displays=useAgentDisplays();
 const [local,setLocal]=useState(()=>typeof location==='undefined'?base:location.pathname);
 const path=(shellPath??local).split('?')[0];let selected:string|undefined;try{selected=path.startsWith(`${base}/project/`)?decodeURIComponent(path.slice(`${base}/project/`.length).split('/')[0]):undefined;}catch{/* Invalid route remains not found. */}
 const navigate=(id?:string)=>{const next=id?`${base}/project/${encodeURIComponent(id)}`:base;if(go)go(next);else{history.pushState(null,'',next);setLocal(next);}};
 useEffect(()=>{if(go)return;const pop=()=>setLocal(location.pathname);window.addEventListener('popstate',pop);return()=>window.removeEventListener('popstate',pop);},[go]);
 let memoryRef:string|undefined;try{memoryRef=path.includes('/memory/')?decodeURIComponent(path.split('/memory/')[1]):undefined;}catch{/* malformed memory route */}
 const allowed=selected!==undefined && (!cardIds || cardIds.has(selected));
 const memory=useMemoryRecord(memoryRef&&allowed&&selected?memoryQueries.projectMemory(`${selected.split(':')[0]}:${memoryRef}`):undefined);
 const access=useMemoryRecord(memoryQueries.projectsAccess()),feed=useMemoryList(memoryQueries.projects()),detail=useMemoryRecord(allowed&&selected?memoryQueries.project(selected):undefined);
 const permission=access.status==='live'?access.records[0]:undefined;
 const [folder,setFolder]=useState(projectsSession.folder),[query,setQuery]=useState(projectsSession.query),[agent,setAgent]=useState(projectsSession.agent);
 const records=cardIds ? feed.records.filter(card=>cardIds.has(card.id)) : feed.records;
 const active=records.filter(p=>!p.archived&&p.card.status==='active').length,quiet=records.filter(p=>!p.archived&&p.card.status!=='active').length;
 const effectiveFolder=active?folder:'quiet';const shown=projects(records,effectiveFolder,query,agent);
 const unavailable=(status:string)=><Error text={status==='denied'?'You don’t have access to Projects.':'Connection lost. Projects will return when connected.'}/>;
 if(access.status==='loading')return <Loading label="Opening projects…"/>;if(access.status!=='live')return unavailable(access.status);if(!permission?.allowed)return unavailable('denied');
 const openLink=go && ((href:string)=>{
   const note='/p/work/notes/project/'+encodeURIComponent(selected ?? '')+'/memory/';
   go(href.startsWith(note) ? base+href.slice('/p/work/notes'.length) : href);
 });
 const inWork=base.startsWith('/p/work/');
 const filters=<div className="grid gap-2"><Search label="Search agent notes" value={query} onChange={value=>{projectsSession.query=value;setQuery(value);}}/><Field label="Agent"><NativeSelect value={agent} onChange={e=>{projectsSession.agent=e.target.value;setAgent(e.target.value);}}><option value="">All authorized agents</option>{permission.agents.map(a=><option key={a}>{a}</option>)}</NativeSelect></Field></div>;
 return <>{inWork && <ToolbarControls>{filters}</ToolbarControls>}<Split className="h-full" label="Projects" folders={[{id:'active',label:'Active',count:active},{id:'quiet',label:'Paused and done',count:quiet}]} folder={effectiveFolder} onFolder={value=>{projectsSession.folder=value;setFolder(value);}}
  search={inWork ? undefined : filters}
  listTitle="Agent notes" listCount={shown.length} list={feed.status==='loading'?<Loading label="Opening projects…"/>:feed.status!=='live'?unavailable(feed.status):<><List label="Projects"><ul>{shown.map(p=><Card key={p.id} p={p} displays={displays} selected={p.id===selected} onClick={()=>navigate(p.id)}/>)}</ul></List>{!shown.length&&<Empty title={query.trim()?`Nothing matches “${query.trim()}”`:active||quiet?'No contributions here':'No contributions yet'} text="Agent contributions appear here when they are available to you."/>}</>}
  reader={selected && !allowed ? <Empty title="Contribution unavailable"/> : memoryRef?(memory.status==='loading'?<Loading label="Opening memory…"/>:memory.status!=='live'?unavailable(memory.status):memory.records[0]?<PageReader className="p-5"><Title as="h1">{memory.records[0].title}</Title><p>{memory.records[0].agent} · {memory.records[0].category} · {memory.records[0].created}</p><p className="whitespace-pre-wrap">{memory.records[0].content}</p></PageReader>:<Empty title="Memory no longer available"/>):detail.status==='loading'?<Loading label="Opening project…"/>:detail.status!=='live'?unavailable(detail.status):detail.records[0]?<Reader project={detail.records[0]} go={openLink}/>:<Empty title="Project not found" text="It may have been archived or removed."/>}
  open={!!selected} onBack={()=>navigate(memoryRef?selected:undefined)} backLabel={memoryRef ? "Back to contribution" : "Back to agent notes"} blank={<Empty title="Open a contribution" text="Select an agent’s project notes to see its sources and recent activity."/>}/></>;
}
