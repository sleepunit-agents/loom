import {Suspense,useEffect,useRef,useState} from 'react';
import {useRecords} from '../../data';
import {Split,List,Row,Empty,Loading,Error,Button,Markdown,type SplitFolder} from '../../kit';
import Face from '../../face';
import {folded,groupLabel,isPlan,stepOf} from '../../steps';
import {reducedMotion} from '../../access';
import {VENUES,address,filtersOf,passes,safeHref,type Filters,type ActivityWindow,type ActivityEntry,type ActivityOpen} from './model';
interface Failure {[key:string]:unknown;id:string;state:'error'|'unavailable';message:string}
interface Access {[key:string]:unknown;id:string;allowed:boolean;agents:string[];owner:string;timezone:string;today:string;windows:string[]}
// Session state contains only navigation preferences. Records remain in the
// shared live store: each Earlier click adds one three-day subscription.
export const activitySession={windows:1};
function useWindows(dates:string[],count:number){
 const w0=useRecords<ActivityWindow>('activity.window',count>0?(dates[0]??''):'');
 const w1=useRecords<ActivityWindow>('activity.window',count>1?(dates[1]??''):'');
 const w2=useRecords<ActivityWindow>('activity.window',count>2?(dates[2]??''):'');
 const w3=useRecords<ActivityWindow>('activity.window',count>3?(dates[3]??''):'');
 const w4=useRecords<ActivityWindow>('activity.window',count>4?(dates[4]??''):'');
 const w5=useRecords<ActivityWindow>('activity.window',count>5?(dates[5]??''):'');
 const w6=useRecords<ActivityWindow>('activity.window',count>6?(dates[6]??''):'');
 const w7=useRecords<ActivityWindow>('activity.window',count>7?(dates[7]??''):'');
 const w8=useRecords<ActivityWindow>('activity.window',count>8?(dates[8]??''):'');
 const w9=useRecords<ActivityWindow>('activity.window',count>9?(dates[9]??''):'');
 const w10=useRecords<ActivityWindow>('activity.window',count>10?(dates[10]??''):'');
 return [w0,w1,w2,w3,w4,w5,w6,w7,w8,w9,w10].slice(0,count);
}
function Link({label,href,go}:{label:string;href?:string;go?:(p:string)=>void}){const safe=safeHref(href);return safe?<a className="underline" href={safe} onClick={e=>{if(go&&safe.startsWith('/')&&!e.metaKey&&!e.ctrlKey&&!e.shiftKey&&!e.altKey){e.preventDefault();go(safe);}}} {...(safe.startsWith('https:')?{target:'_blank',rel:'noopener noreferrer'}:{})}>{label}</a>:<span>{label}</span>;}
function Steps({steps}:{steps:NonNullable<ActivityOpen['steps']>}){
 const cards=steps.map((s,i)=>({seq:i,text:s.label,card:{tool:s.tool,state:s.state}})),plan=cards.filter(isPlan).at(-1),rows=cards.filter(s=>!isPlan(s));
 const line=(s:typeof cards[number])=><li key={s.seq}>{s.text} · {stepOf(s)==='current'?'running':stepOf(s)==='error'?'failed':'done'}</li>;
 return <section><h2>Steps · {rows.length}</h2>{plan&&<p>{plan.text}</p>}{folded(rows).map(g=>'few' in g?<ol key={g.few[0].seq}>{g.few.map(line)}</ol>:<details key={g.many[0].seq}><summary>{groupLabel(g.many)} · {g.many.at(-1)!.text}</summary><ol>{g.many.map(line)}</ol></details>)}</section>;
}
function Reader({entry:e,go,pick,tz}:{entry:ActivityOpen;go?:(p:string)=>void;pick:(id:string)=>void;tz:string}){
 return <article className="grid gap-5 p-5"><header><p>{e.agent}{e.owner?' · with you':''} · {e.where} · <time dateTime={e.at}>{new Date(e.at).toLocaleString([],{timeZone:tz})}</time></p><h1 className="text-2xl font-semibold">{e.title}</h1></header>
 {e.needs&&<p role="status">Needs you: {e.needs}</p>}
 {!!e.asked.length&&<section><h2>What was asked</h2><ul>{e.asked.map((s,i)=><li key={i}>{s}</li>)}</ul></section>}
 {e.story&&<section><h2>What happened</h2><Suspense fallback={<Loading label="Opening words…"/>}><Markdown text={e.story} onLink={href=>{const safe=safeHref(href);if(!safe)return true;if(go&&safe.startsWith('/')){go(safe);return true;}return false;}}/></Suspense></section>}
 {!!e.decided.length&&<section><h2>{e.id.startsWith('e~')?'Shipped':'What was decided'}</h2><ul>{e.decided.map((s,i)=><li key={i}>{s}</li>)}</ul></section>}
 {!!(e.tasks.length+e.prs.length)&&<section><h2>Tasks and pull requests</h2><ul>{[...e.tasks,...e.prs].map((l,i)=><li key={i}><Link {...l} go={go}/></li>)}</ul></section>}
 {!!e.steps?.length&&<Steps steps={e.steps}/>}
 {!!e.links.length&&<section><h2>Read more</h2><ul>{e.links.map((l,i)=><li key={i}><Link {...l} go={go}/></li>)}</ul></section>}
 {!!e.more.length&&<section><h2>Earlier in this conversation</h2>{e.more.map(m=><Button key={m.id} variant="ghost" onClick={()=>pick(m.id)}>{m.title} · {new Date(m.at).toLocaleString([],{timeZone:tz})}</Button>)}</section>}
 </article>;
}
export default function ActivityApp({path:shellPath,go}:{path?:string;go?:(p:string)=>void}={}){
 const [local,setLocal]=useState(()=>typeof location==='undefined'?'/p/activity-preview':location.pathname+location.search);
 const url=new URL(shellPath??local,'http://loom'),q=url.searchParams,f=filtersOf(q);
 let memoryId:string|undefined;
 if(url.pathname.startsWith('/p/activity-preview/memory/'))try{const raw=decodeURIComponent(url.pathname.slice('/p/activity-preview/memory/'.length)),colon=raw.indexOf(':');memoryId=colon>0?`e~${raw.slice(0,colon)}~${raw.slice(colon+1)}`:'invalid';}catch{memoryId='invalid';}
 const selected=memoryId??q.get('e')??undefined;
 const access=useRecords<Access>('activity.access'),permission=access.status==='live'?access.records[0]:undefined;
 const [count,setCount]=useState(activitySession.windows),windows=useWindows(permission?.windows??[],count),detail=useRecords<ActivityOpen|Failure>('activity.entry',selected??'');
 const records=windows.flatMap(w=>w.status==='live'?w.records:[]),entries=[...new Map(records.flatMap(w=>w.entries).map(e=>[e.id,e])).values()].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)||a.id.localeCompare(b.id));
 const days=[...new Set(records.flatMap(w=>w.days))].sort().reverse(),day=q.get('day')??permission?.today??days[0],tz=permission?.timezone??'America/Chicago';
 const navigate=(nf:Filters=f,id:string|null=selected??null,d=day)=>{const next=address(nf,id??undefined,d);if(go)go(next);else{history.pushState(null,'',next);setLocal(next);}};
 useEffect(()=>{if(go)return;const pop=()=>setLocal(location.pathname+location.search);window.addEventListener('popstate',pop);return()=>window.removeEventListener('popstate',pop);},[go]);
 // An addressed older day subscribes only the windows needed to reach it.
 const requestedDay=q.get('day');
 const needed=permission?.windows?.findIndex((d,i)=>requestedDay&&requestedDay<=d&&(i===10||requestedDay>permission.windows[i+1]))??-1;
 useEffect(()=>{if(needed>=count){setCount(needed+1);activitySession.windows=needed+1;}},[needed,count]);
 const rowsRef=useRef<HTMLDivElement>(null);
 const dayReady=entries.some(e=>e.day===day);
 useEffect(()=>{const row=[...(rowsRef.current?.querySelectorAll<HTMLElement>('[data-split-row]')??[])].find(r=>r.dataset.day===day);row?.scrollIntoView({block:'start',behavior:'instant'});},[day,dayReady]);
 const pick=(id:string)=>navigate(f,id);
 const toggle=(id:string)=>{if(id==='all'){navigate({who:[],where:[],what:[]});return;}const [group,...value]=id.split(':');if(!['who','where','what'].includes(group))return;const k=group as keyof Filters,v=value.join(':');navigate({...f,[k]:f[k].includes(v)?f[k].filter(x=>x!==v):[...f[k],v].sort()});};
 const isOn=(id:string)=>id==='all'?!f.who.length&&!f.where.length&&!f.what.length:(f[id.split(':')[0] as keyof Filters]??[]).includes(id.split(':').slice(1).join(':'));
 const todayEntries=entries.filter(e=>e.day===day),n=(test:(e:ActivityEntry)=>boolean)=>todayEntries.filter(test).length;
 const who=[...(permission?.agents??[]).map(agent=>({id:`who:${agent}`,label:agent,count:n(e=>e.agent===agent)})),{id:'who:owner',label:permission?.owner??'Owner',count:n(e=>!!e.owner)}].sort((a,b)=>a.label.localeCompare(b.label));
 const venues:Record<string,string>=Object.fromEntries(['comms','discord','slack','terminal','wakes'].map(v=>[v,VENUES[v]]));for(const e of entries)venues[e.venue]??=e.venue;
 const where=Object.entries(venues).map(([id,label])=>({id:`where:${id}`,label,count:n(e=>e.venue===id)})).sort((a,b)=>a.label.localeCompare(b.label));
 const what=[['conversation','Conversations'],['system','System'],['work','Work done']].map(([id,label])=>({id:`what:${id}`,label,count:n(e=>e.what===id)}));
 const groups=[{label:'Who',items:who},{label:'Where',items:where},{label:'What',items:what}];
 const folders:SplitFolder[]=[{id:'all',label:'All activity',count:todayEntries.length},...groups.flatMap(g=>[{heading:g.label},...g.items])];
 const shown=entries.filter(e=>passes(e,f)),hours=Array.from({length:24},(_,h)=>shown.filter(e=>e.day===day&&e.hour===h).length),peak=Math.max(1,...hours);
 const unavailable=(status:string)=><Error text={status==='denied'?'You don’t have access to Activity.':'Connection lost. Activity will return when connected.'}/>;
 if(access.status==='loading')return <Loading label="Opening activity…"/>;if(access.status!=='live')return unavailable(access.status);if(!permission?.allowed)return unavailable('denied');
 const loading=windows.some(w=>w.status==='loading'),bad=windows.find(w=>w.status==='offline'||w.status==='denied');
 const menu=<details className="p-3"><summary>Filter activity</summary>{groups.map(g=><div key={g.label} role="group" aria-label={g.label}><h3>{g.label}</h3>{g.items.map(i=><Button key={i.id} variant="ghost" aria-pressed={isOn(i.id)} onClick={()=>toggle(i.id)}>{i.label} · {i.count}</Button>)}</div>)}<Button onClick={()=>toggle('all')}>Show everything</Button></details>;
 const strip=<div className="grid gap-2 p-3"><label>Shown day<select aria-label="Shown day" value={day} onChange={e=>navigate(f,selected,e.target.value)}>{days.map(d=><option key={d}>{d}</option>)}</select></label><div className="flex h-12 items-end gap-px" role="group" aria-label={`Activity per hour, ${day}`}>{hours.map((n,h)=><button type="button" key={h} disabled={!n} aria-label={`${h}:00: ${n} entries`} className="flex h-full min-w-0 flex-1 items-end focus-visible:outline" onClick={()=>{const rows=[...(rowsRef.current?.querySelectorAll<HTMLElement>('[data-split-row]')??[])];const row=rows.find(r=>r.dataset.day===day&&Number(r.dataset.hour)<=h);row?.scrollIntoView({block:'nearest',behavior:reducedMotion()?'instant':'smooth'});row?.focus({preventScroll:true});}}><span className="w-full bg-primary" style={{height:`${Math.max(4,n/peak*100)}%`}}/></button>)}</div><p className="text-sm">{hours.reduce((a,b)=>a+b,0)} entries · midnight / 6am / noon / 6pm</p></div>;
 return <Split className="h-full" label="Activity" folders={folders} folder="" onFolder={toggle} isOn={isOn} narrow={menu} listTop={strip} listTitle="Activity" listMeta={`${shown.length} entries`}
 list={<div ref={rowsRef}>{bad?unavailable(bad.status):<>{records.some(w=>w.conversations!=='available')&&<p role="status" className="p-3">Conversations and digests {records.some(w=>w.conversations==='error')?'couldn’t load':'are not available yet'}.</p>}{records.some(w=>w.episodes!=='available')&&<p role="status" className="p-3">Some episode stores {records.some(w=>w.episodes==='error')?'couldn’t load':'are not available'}.</p>}{records.some(w=>w.truncated)&&<p role="status">Showing the newest 600 entries per window.</p>}
 {days.map(d=>{const rows=shown.filter(e=>e.day===d);return rows.length?<section key={d} aria-label={d}><h2 className="px-4 py-2 font-medium">{d}</h2><List label={`Activity on ${d}`}>{rows.map(e=><Row key={e.id} data-day={e.day} data-hour={e.hour} title={e.title} meta={`${new Date(e.at).toLocaleTimeString([],{timeZone:tz,hour:'numeric',minute:'2-digit'})} · ${e.agent} · ${e.where}${e.line?' · '+e.line:''}`} icon={<Face bg="" size={28} label={e.agent}/>} status={e.what==='work'?'Work done':e.what==='system'?'System':undefined} selected={e.id===selected} onClick={()=>pick(e.id)} style={{contentVisibility:'auto',containIntrinsicSize:'auto 100px'}}/>)}</List></section>:null;})}
 {loading?<Loading label="Opening activity…"/>:!shown.length&&<Empty title={f.who.length+f.where.length+f.what.length?'Nothing matches these filters':'Quiet'} text="Try fewer filters or earlier days."/>}
 {count<11&&<Button disabled={loading} onClick={()=>{activitySession.windows=count+1;setCount(count+1);}}>Earlier</Button>}</>}</div>}
 reader={detail.status==='loading'?<Loading label="Opening entry…"/>:detail.status!=='live'?unavailable(detail.status):detail.records[0]?('state' in detail.records[0]?<Error text={String(detail.records[0].message)}/>:<Reader entry={detail.records[0] as ActivityOpen} tz={tz} go={go} pick={pick}/>):<Empty title="This entry is no longer available" text="It may have expired or you may no longer have access."/>}
 open={!!selected} onBack={()=>navigate(f,null)} backLabel="Activity" blank={<Empty title="Open an entry" text="Read what happened, what was asked and what was decided."/>}/>;
}
