import { taskPath } from '../../task-route.js';
/** Activity reads existing episode stores in place; conversation content comes only from its new role. */
import {existsSync} from 'node:fs';
import BetterSqlite3,{type Database} from 'better-sqlite3';
import {AgentFiles} from './sources.js';
import {z} from 'zod';
import {maySee,type Viewer,type Sharing} from '../../core/index.js';
import {episodeConversationId,plainEpisode,fallbackParts,whereOfConversation} from './activity-episode.js';
import {MAX_BACK,MAX_ENTRIES,VENUES,whereLabel,isoDay,hourOf,dayBefore,oneLine,refsIn,venueKey,whatOf,splitTitle,startOf,validDay,windowDays,type ActivityEntry,type ActivityOpen,type ActivityWindow} from './activity-model.js';
import type {Clock} from '../../core/clock.js';
import {DAY_MS} from '../../core/day.js';
import type {ActivityConversations,ActivityConversation,ActivityRun} from './activity-role.js';
const link=z.object({label:z.string(),href:z.string().optional()}).strict();
const conversationSchema=z.object({id:z.string(),agent:z.string(),venue:z.string(),place:z.string(),label:z.string(),people:z.array(z.string()),expires:z.number().finite().optional(),member:z.string().optional(),project:z.string().optional()}).strict();
const runSchema=z.object({kind:z.enum(['digest','conversation']),key:z.string().min(1).max(300),at:z.string().datetime({offset:true}),conversation:conversationSchema,summary:z.string().optional(),turns:z.number().int().nonnegative().optional(),replies:z.number().int().nonnegative().optional(),asked:z.array(z.string()),decided:z.array(z.string()),tasks:z.array(z.string()),references:z.array(z.string()).optional(),linkedWork:z.object({tasks:z.array(link.required()),prs:z.array(link.required())}).optional(),links:z.array(link),steps:z.array(z.object({label:z.string(),state:z.string(),tool:z.string()}).strict()).optional(),needs:z.string().optional(),needsHref:z.string().optional(),needsForMember:z.string().optional(),expires:z.number().finite().optional(),more:z.array(z.object({id:z.string(),at:z.string(),title:z.string()}).strict())}).strict();
export interface ActivityFailure {[key:string]:unknown;id:string;state:'error'|'unavailable';message:string}
interface Episode {ref:string;title:string;content:string;created:string;project:string|null;metadata:string|null;expires_at:string|null}
const active="category='episode' AND archived=0 AND (expires_at IS NULL OR julianday(expires_at)>julianday(?))";
const has=(db:Database)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memories'").get();
const parse=(s:string|null):Record<string,unknown>=>{try{const v=JSON.parse(s??'{}');return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}catch{return {};}};
export interface ActivityOptions {agents:Array<{agent:string;memories:string}>;sharing():Sharing;conversations?:ActivityConversations;
 /** The household's zone: days and hours are shown in it. */
 timezone:string|(()=>string);owner?:string;ownerLabel?:string;
 /** The household's GitHub owner, for short references. A function is asked each time. */
 github?:string|(()=>string|undefined)}
/** Read-only sources and the shared Conversations port; no legacy registry or transport. */
export function createActivityReader(clock:Pick<Clock,'now'>,options:ActivityOptions){
 const readTimezone=()=>typeof options.timezone==='function'?options.timezone():options.timezone;
 const readGithub=()=>typeof options.github==='function'?options.github():options.github;
 isoDay(clock.now(),readTimezone());
 const sourceErrors=new Set<string>();
 const sources=new AgentFiles<{agent:string;memories:string},Database>(()=>options.agents,a=>{
  try{if(existsSync(a.memories))return new BetterSqlite3(a.memories,{readonly:true,fileMustExist:true,timeout:0});}catch{sourceErrors.add(a.agent);}
  return undefined;
 }).follow();
 // One window asks who may see what for every agent and every conversation row. The sharing facts are a read
 // of whole tables and nothing in a read writes, so one synchronous call of this reader reads them once.
 // Nothing is kept past the call: the next one asks afresh.
 let held:{sharing:Sharing;timezone?:string;github?:string|null}|undefined;
 const sharing=()=>held?.sharing??options.sharing();
 const tz=()=>held?(held.timezone??=readTimezone()):readTimezone();
 const github=()=>{
  if(!held)return readGithub();
  if(held.github===undefined)held.github=readGithub()??null;
  return held.github??undefined;
 };
 const once=<T>(work:()=>T):T=>{if(held)return work();held={sharing:options.sharing()};try{return work();}finally{held=undefined;}};
 const allowed=(v:Viewer,agent:string,type='memory')=>maySee(v,{type,agent},sharing());
 const conversationAllowed=(v:Viewer,agent:string)=>allowed(v,agent,'conversation')||!!options.conversations?.agents?.(v).includes(agent);
 const agents=(v:Viewer)=>options.agents.filter(a=>allowed(v,a.agent)||conversationAllowed(v,a.agent));
 // Conversation records carry the shared model's scope. Episode files remain
 // private to their agent, checked separately before opening the file.
 const seesConversation=(v:Viewer,c:ActivityConversation,agent:string)=>(c.expires===undefined||c.expires>clock.now())&&c.agent===agent&&maySee(v,{type:'conversation',agent,...(c.project!==undefined?{project:c.project}:{}),...(c.member!==undefined?{member:c.member}:{})},sharing());
 const conversation=(v:Viewer,agent:string,id:string)=>{const raw=options.conversations?.conversation(v,agent,id);if(!raw)return;const c=conversationSchema.parse(raw);return c.id===id&&seesConversation(v,c,agent)?c:undefined;};
 const ownerPerson=(v:Viewer)=>v.kind==='member'?v.id:options.owner;
 const ownerLabel=(v:Viewer)=>{const person=ownerPerson(v);return (person===options.owner&&options.ownerLabel?options.ownerLabel:person??'Owner').split(/[\s-]+/)[0].replace(/^./,x=>x.toUpperCase());};
 const stamp=(at:string)=>({day:isoDay(Date.parse(at),tz()),hour:hourOf(Date.parse(at),tz())});
 function fromRun(r:ActivityRun,v:Viewer):ActivityEntry{
  const c=r.conversation,title=c.label.trim().replace(/^(?:schedule|alert) [\w.-]+:\s+(?=\S)/,'').replace(/^\p{Ll}/u,x=>x.toUpperCase())||`A ${VENUES[venueKey(c.venue)]??c.venue} conversation`;
  const venue=venueKey(c.venue),where=venue==='wakes'?(/^lane:|^schedule /.test(c.place)||/^schedule /.test(c.label)?'Lane':/^alert:/.test(c.place)?'Alert':'Wake'):whereLabel(whereOfConversation(c))||VENUES[venue]||c.venue;
  return {id:`${r.kind==='digest'?'d':'c'}~${c.agent}~${r.key}`,agent:c.agent,at:r.at,...stamp(r.at),title,line:r.summary?oneLine(r.summary):`${r.turns??0} turn${r.turns===1?'':'s'}${r.replies?`, ${r.replies} repl${r.replies===1?'y':'ies'}`:''}, no summary yet`,venue,where,what:whatOf({place:c.place,title,line:r.summary}),...(r.expires!==undefined||c.expires!==undefined?{expires:Math.min(r.expires??Infinity,c.expires??Infinity)}:{}),...(venue==='comms'||(ownerPerson(v)&&c.people.includes(ownerPerson(v)!))?{owner:true as const}:{})};
 }
 function runOpen(r:ActivityRun,v:Viewer):ActivityOpen{
  const entry=fromRun(r,v),refs=refsIn([r.summary??'',...r.asked,...r.decided,...r.tasks,...(r.references??[])].join('\n'),github()),theirs=v.kind==='member'&&r.needsForMember===v.id;
  const tasks=refs.tasks.map(id=>({label:id,href:taskPath(id)}));
  const distinct=(links:{label:string;href?:string}[])=>[...new Map(links.map(link=>[link.href,link])).values()];
  return {...entry,asked:r.asked,decided:r.decided,...(r.summary?{story:r.summary}:{}),tasks:distinct([...tasks,...(r.linkedWork?.tasks??[])]),prs:distinct([...refs.prs,...(r.linkedWork?.prs??[])]),
   links:[...r.links,...(theirs&&r.needsHref?[{label:'What it needs you for',href:r.needsHref}]:[])],...(theirs&&r.needs?{needs:r.needs}:{}),
   ...(entry.venue==='comms'&&r.steps?{steps:r.steps.filter(s=>s.tool!=='text')}:{}) ,more:r.more.slice(0,8)};
 }
 // Keep at most one candidate page in memory. A private or duplicate
 // episode can push the visible lookahead into another batch.
 function* visibleEpisodes(rows:Iterable<unknown>,v:Viewer,agent:string,size:number){
  const role=options.conversations;
  if(!role?.conversations){
   for(const raw of rows){const row=raw as Episode,entry=episode(v,agent,row);if(entry)yield {entry,ref:row.ref,row};}
   return;
  }
  const batchRead=role.conversations.bind(role);
  function* project(batch:Episode[]){
   const ids=new Set<string>();
   for(const row of batch){
    const id=episodeConversationId(row.title??'',row.content??'',parse(row.metadata));
    if(id)ids.add(id);
   }
   let lookup=(id:string)=>conversation(v,agent,id);
   if(ids.size){
    try{
     const facts=new Map(batchRead(v,agent,[...ids]).map(c=>[c.id,c]));
     lookup=id=>{
      const raw=facts.get(id);
      if(!raw)return;
      const c=conversationSchema.parse(raw);
      return c.id===id&&seesConversation(v,c,agent)?c:undefined;
     };
    }catch{
     // A later candidate can fail while an earlier one fills the page.
     // Read each needed fact through the original scoped role in that case.
    }
   }
   for(const row of batch){const entry=episode(v,agent,row,lookup);if(entry)yield {entry,ref:row.ref,row};}
  }
  let batch:Episode[]=[];
  for(const raw of rows){
   batch.push(raw as Episode);
   if(batch.length===size){yield* project(batch);batch=[];}
  }
  if(batch.length)yield* project(batch);
 }
 function episode(v:Viewer,agent:string,e:Episode,lookup=(id:string)=>conversation(v,agent,id)):(ActivityOpen & {conversationId?:string})|undefined{
  const meta=parse(e.metadata),where=typeof meta.where==='string'?meta.where:e.project??'?';
  const p=plainEpisode({title:e.title,content:e.content,where,meta},agent,lookup);
  const venue=venueKey(p.where.split(/[:/]/)[0]),related=p.conversation?lookup(p.conversation):undefined;
  if(venue==='comms'){
   const c=related;
   if(!c||venueKey(c.venue)!=='comms')return;
  }
  // A conversation id on any episode can refer to a private Comms thread even
  // when its writer used "terminal" as the surface. Fail closed on named ids
  // the NEW owner cannot authorize; do not guess via legacy stores.
  if(p.conversation&&!related)return;
  const parts=fallbackParts(e.content),refs=refsIn(`${p.title}\n${e.content}`,github());
  return {id:`e~${agent}~${e.ref}`,...(p.conversation?{conversationId:p.conversation}:{}),agent,at:e.created,...stamp(e.created),...splitTitle(p.title),venue,where:whereLabel(p.where)||VENUES[venue]||venue,what:whatOf({place:p.where,title:p.title}),
   ...(ownerPerson(v)&&p.where.includes(ownerPerson(v)!)?{owner:true as const}:{}),...(e.expires_at||related?.expires!==undefined?{expires:Math.min(e.expires_at?Date.parse(e.expires_at):Infinity,related?.expires??Infinity)}:{}),
   asked:parts?.asked?[parts.asked]:[],decided:parts?.shipped??[],story:parts?parts.said:e.content,tasks:refs.tasks.map(id=>({label:id,href:taskPath(id)})),prs:refs.prs,links:[{label:'The memory',href:`/p/activity-preview/memory/${encodeURIComponent(`${agent}:${e.ref}`)}`}],more:[]};
 }
 function window(scope:string,v:Viewer):ActivityWindow|undefined{
  if(!agents(v).length)return;
  const now=clock.now(),today=isoDay(now,tz()),to=scope==='recent'?today:scope;
  if(!validDay(to)||to>today||to<dayBefore(today,MAX_BACK))return;
  const days=windowDays(to,today),from=startOf(days.at(-1)!,tz()),until=Math.min(now+60000,startOf(dayBefore(to,-1),tz()));
  const entries:ActivityEntry[]=[],runs:Array<{agent:string;venue:string;at:number}>=[],covered=new Set<string>();
  let conversations:ActivityWindow['conversations']=options.conversations?'available':'unavailable',episodes:ActivityWindow['episodes']='available',truncated=false;
  const deadlines=[startOf(dayBefore(today,-1),tz())];
  for(const {agent} of agents(v)){
   if(options.conversations&&conversationAllowed(v,agent))try{
    const answer=z.object({available:z.boolean(),rows:z.array(runSchema).max(MAX_ENTRIES+1),expires:z.number().finite().optional()}).strict().parse(options.conversations.list(v,{agent,from,until,limit:MAX_ENTRIES+1}));
    if(!answer.available){if(conversations!=='error')conversations='unavailable';}else{
     const rows=answer.rows.filter(r=>seesConversation(v,r.conversation,agent)&&(r.expires===undefined||r.expires>now)&&Date.parse(r.at)>=from&&Date.parse(r.at)<until);
     const digested=new Set(rows.filter(r=>r.kind==='digest').map(r=>r.conversation.id));
     for(const r of rows){if(r.kind==='conversation'&&digested.has(r.conversation.id))continue;const e=fromRun(r,v);entries.push(e);if(e.expires)deadlines.push(e.expires);covered.add(`${agent}:${r.conversation.id}`);if(r.kind==='digest')runs.push({agent,venue:e.venue,at:Date.parse(e.at)});}
     if(answer.expires&&answer.expires>now)deadlines.push(answer.expires);
    }
   }catch{conversations='error';}
   if(!allowed(v,agent))continue;
   const db=sources.get(agent);
   if(sourceErrors.has(agent)){episodes='error';continue;}
   if(!db){if(episodes!=='error')episodes='unavailable';continue;}
   try{
    if(!has(db)){if(episodes!=='error')episodes='unavailable';continue;}
    // Bound only after visibility and deduplication: private Comms rows may not
    // crowd visible episodes out of the feed.
    const selection=`WHERE ${active} AND julianday(created)>=julianday(?) AND julianday(created)<julianday(?) ORDER BY julianday(created) DESC,ref`;
    const args=[new Date(now).toISOString(),new Date(from).toISOString(),new Date(until).toISOString()];
    const query=db.prepare(`SELECT ref,title,content,created,project,metadata,expires_at FROM memories ${selection}`);
    let n=0;
    for(const {entry:e} of visibleEpisodes(query.iterate(...args),v,agent,MAX_ENTRIES+1)){
     const cv=e.conversationId;
     if(cv&&covered.has(`${agent}:${cv}`))continue;
     // Use time and venue only for older notes that omit the conversation ID.
     if(!cv&&runs.some(r=>r.agent===agent&&r.venue===e.venue&&Math.abs(r.at-Date.parse(e.at))<20*60000))continue;
     if(e.expires&&e.expires>now)deadlines.push(e.expires);
     const {asked:_a,decided:_d,story:_s,tasks:_t,prs:_p,links:_l,more:_m,conversationId:_cv,...entry}=e;entries.push(entry);
     if(++n>MAX_ENTRIES){truncated=true;break;}
    }
   }catch{episodes='error';}
  }
  const sorted=[...new Map(entries.map(e=>[e.id,e])).values()].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)||a.id.localeCompare(b.id));
  return {id:scope,to,days,...(days.at(-1)!>dayBefore(today,MAX_BACK)?{earlier:dayBefore(days.at(-1)!)}:{}),entries:sorted.slice(0,MAX_ENTRIES),conversations,episodes,truncated:truncated||sorted.length>MAX_ENTRIES,expires:Math.min(...deadlines)};
 }
 function ownEpisodeSessions(v:Viewer){
  if(v.kind!=='agent'||!allowed(v,v.id))return;
  const db=sources.get(v.id);
  if(!db||!has(db))throw Error('Episode store unavailable');
  const now=new Date(clock.now()).toISOString();
  const rows=db.prepare(`SELECT ref,title,content,created,project,metadata,expires_at FROM memories
   WHERE ${active} AND julianday(created)<=julianday(?)`);
  const ids=new Set<string>();
  let expires:number|undefined;
  for(const {entry,row} of visibleEpisodes(rows.iterate(now,now),v,v.id,25)){
   if(entry.expires!==undefined)expires=Math.min(expires??Infinity,entry.expires);
   const meta=parse(row.metadata);
   const markers=new Set<string>();
   const add=(value:unknown)=>{
    if(typeof value==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i.test(value))markers.add(value.toLowerCase());
   };
   add(meta.session_id);
   if(typeof meta.transcript_path==='string')add(/(?:^|[/\\])([^/\\]+)\.jsonl$/.exec(meta.transcript_path)?.[1]);
   const words=`${row.title}\n${row.content}`;
   for(const match of words.matchAll(/\bsession ([0-9a-f-]+)\b/gi))add(match[1]);
   for(const match of words.matchAll(/\btranscript [^\s]*[/\\]([0-9a-f-]+)\.jsonl\b/gi))add(match[1]);
   // Fallback episodes carry both forms. Prefer the precise identifier for that episode.
   for(const marker of markers)if(marker.length>8)markers.delete(marker.slice(0,8));
   for(const marker of markers)ids.add(marker);
  }
  return {ids:[...ids].sort(),expires};
 }
 function episodePage(agent:string,v:Viewer,first:number,before?:string|null){
  if(!allowed(v,agent)||!options.agents.some(source=>source.agent===agent))return;
  if(!Number.isInteger(first)||first<1||first>25||before!=null&&(!before.length||before.length>300))throw Error('Invalid episode page');
  const db=sources.get(agent);
  if(!db||!has(db))throw Error('Episode store unavailable');
  const now=clock.now(),entries:ActivityOpen[]=[];
  let last:string|undefined,expires:number|undefined;
  const selection=`WHERE ${active} AND julianday(created)<=julianday(?) ${before==null?'':'AND ref < ?'} ORDER BY ref DESC`;
  const rows=db.prepare(`SELECT ref,title,content,created,project,metadata,expires_at FROM memories ${selection}`);
  const args=[new Date(now).toISOString(),new Date(now+60000).toISOString()];
  if(before!=null)args.push(before);
  for(const {entry:visible,ref} of visibleEpisodes(rows.iterate(...args),v,agent,first+1)){
   if(visible.expires!==undefined)expires=Math.min(expires??Infinity,visible.expires);
   if(entries.length===first)return {entries,nextBefore:last,expires};
   entries.push(visible);last=ref;
  }
  return {entries,nextBefore:null,expires};
 }
 function read(id:string,v:Viewer):ActivityOpen|ActivityFailure|undefined{
  // kind~agent~key. The agent is any household agent id; one this viewer cannot see ends here either way.
  const m=/^([dce])~([^~]+)~(.{1,300})$/.exec(id);if(!m)return;
  const [,kind,agent,key]=m;if(!agents(v).some(a=>a.agent===agent))return;
  const now=clock.now(),oldest=startOf(dayBefore(isoDay(now,tz()),MAX_BACK),tz());
  if(kind!=='e'&&!conversationAllowed(v,agent))return;
  if(kind==='e'&&!allowed(v,agent))return;
  const failure=(state:'error'|'unavailable',message:string):ActivityFailure=>({id,state,message});
  if(kind!=='e')try{
   if(!options.conversations)return failure('unavailable','Conversations and digests are not available yet.');
   const raw=options.conversations?.read(v,agent,kind==='d'?'digest':'conversation',key);if(!raw)return;
   const r=runSchema.parse(raw);if(r.key!==key||r.kind!==(kind==='d'?'digest':'conversation')||!seesConversation(v,r.conversation,agent)||(r.expires!==undefined&&r.expires<=now)||Date.parse(r.at)<oldest||Date.parse(r.at)>now+60000)return;
   return runOpen(r,v);
  }catch{return failure('error','The conversation service couldn’t open this entry.');}
  const db=sources.get(agent);if(sourceErrors.has(agent))return failure('error','The episode store couldn’t open this entry.');if(!db)return failure('unavailable','The episode store is not available.');
  try{if(!has(db))return failure('unavailable','The episode store is not available.');const row=db.prepare(`SELECT ref,title,content,created,project,metadata,expires_at FROM memories WHERE ref=? AND ${active} AND julianday(created)>=julianday(?) AND julianday(created)<=julianday(?)`).get(key,new Date(now).toISOString(),new Date(oldest).toISOString(),new Date(now+60000).toISOString()) as Episode|undefined;return row?episode(v,agent,row):undefined;}catch{return failure('error','The episode store couldn’t open this entry.');}
 }
 const access=(v:Viewer)=>{const today=isoDay(clock.now(),tz()), sources=agents(v), live=sharing().agents;return {id:'activity',allowed:sources.length>0,agents:sources.map(a=>a.agent).filter(agent=>live?.includes(agent)??true),owner:ownerLabel(v),timezone:tz(),today,windows:Array.from({length:11},(_,i)=>dayBefore(today,i*3)),expires:startOf(dayBefore(today,-1),tz())};};
 let closed=false;
 // Metadata only: all active episode deadlines, regardless of the current
 // viewer or list limit. The listener owns one timer for every projection.
 function nextDeadline():number|undefined {
  if(closed||!options.agents.length)return;
  const now=clock.now(),zone=tz();
  let next=startOf(dayBefore(isoDay(now,zone),-1),zone);
  try{const at=options.conversations?.nextDeadline?.(now);if(at!==undefined&&Number.isFinite(at)&&at>now)next=Math.min(next,at);}catch{/* Conversation source failures are reported by the reader. */}
  for(const db of sources.values())try{
   if(!has(db))continue;
   // Only an episode that ends, or one written lately (its writer's clock may run ahead), can set a deadline.
   // The store leaves the others out, so a schedule does not carry every episode ever kept into this program:
   // it runs after each committed change. The store and the loop below read a time differently (one written
   // without a zone is UTC to the store and this machine's time to the loop), so the store keeps back only
   // what is more than two days old by its reading, and anything it cannot read at all is left in.
   for(const raw of db.prepare("SELECT created,expires_at FROM memories WHERE category='episode' AND archived=0 AND (expires_at IS NOT NULL OR julianday(created) IS NULL OR julianday(created)>julianday(?))").iterate(new Date(now-2*DAY_MS).toISOString())){
    const row=raw as {created:string;expires_at:string|null};
    const expiry=row.expires_at===null?undefined:Date.parse(row.expires_at);
    if(expiry!==undefined&&(!Number.isFinite(expiry)||expiry<=now))continue;
    if(expiry!==undefined)next=Math.min(next,expiry);
    // Reads allow one minute of clock skew; windows use an exclusive end.
    const enters=Date.parse(row.created)-60000;
    for(const at of [enters,enters+1])if(Number.isFinite(at)&&at>now)next=Math.min(next,at);
   }
  }catch{/* A failed source remains an explicit reader error, not a timer failure. */}
  return next;
 }
 const reader={ownEpisodeSessions:(v:Viewer)=>once(()=>ownEpisodeSessions(v)),episodePage:(agent:string,v:Viewer,first:number,before?:string|null)=>once(()=>episodePage(agent,v,first,before)),allowed:(v:Viewer)=>once(()=>agents(v).length>0),access:(v:Viewer)=>once(()=>access(v)),window:(scope:string,v:Viewer)=>once(()=>window(scope,v)),read:(id:string,v:Viewer)=>once(()=>read(id,v)),nextDeadline,close(){if(closed)return;closed=true;for(const db of sources.end())db.close();}};
 return reader;
}
