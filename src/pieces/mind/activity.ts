/** Activity reads existing episode stores in place; conversation content comes only from its new role. */
import {existsSync} from 'node:fs';
import BetterSqlite3,{type Database} from 'better-sqlite3';
import {z} from 'zod';
import {operation,maySee,type Operations,type Live,type Viewer,type Sharing} from '../../core/index.js';
import {plainEpisode,fallbackParts,whereOfConversation} from './activity-episode.js';
import {MAX_BACK,MAX_ENTRIES,VENUES,whereLabel,isoDay,hourOf,dayBefore,oneLine,refsIn,venueKey,whatOf,splitTitle,startOf,validDay,windowDays,type ActivityEntry,type ActivityOpen,type ActivityWindow} from './activity-model.js';
import type {ActivityConversations,ActivityConversation,ActivityRun} from './activity-role.js';
const link=z.object({label:z.string(),href:z.string().optional()}).strict();
const conversationSchema=z.object({id:z.string(),agent:z.string(),venue:z.string(),place:z.string(),label:z.string(),people:z.array(z.string()),expires:z.number().finite().optional(),member:z.string().optional()}).strict();
const runSchema=z.object({kind:z.enum(['digest','conversation']),key:z.string().min(1).max(300),at:z.string().datetime({offset:true}),conversation:conversationSchema,summary:z.string().optional(),turns:z.number().int().nonnegative().optional(),replies:z.number().int().nonnegative().optional(),asked:z.array(z.string()),decided:z.array(z.string()),tasks:z.array(z.string()),links:z.array(link),steps:z.array(z.object({label:z.string(),state:z.string(),tool:z.string()}).strict()).optional(),needs:z.string().optional(),needsHref:z.string().optional(),needsForMember:z.string().optional(),expires:z.number().finite().optional(),more:z.array(z.object({id:z.string(),at:z.string(),title:z.string()}).strict())}).strict();
interface ActivityFailure {[key:string]:unknown;id:string;state:'error'|'unavailable';message:string}
interface Episode {ref:string;title:string;content:string;created:string;project:string|null;metadata:string|null;expires_at:string|null}
const active="category='episode' AND archived=0 AND (expires_at IS NULL OR julianday(expires_at)>julianday(?))";
const has=(db:Database)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memories'").get();
const parse=(s:string|null):Record<string,unknown>=>{try{const v=JSON.parse(s??'{}');return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}catch{return {};}};
export function installMindActivity(operations:Operations,live:Live,options:{agents:Array<{agent:string;memories:string}>;sharing():Sharing;conversations?:ActivityConversations;timezone?:string;owner?:string;ownerLabel?:string;github?:string}){
 const tz=options.timezone??'America/Chicago';isoDay(operations.clock.now(),tz);
 const sources=new Map<string,Database>(),sourceErrors=new Set<string>();
 for(const a of options.agents)try{if(existsSync(a.memories))sources.set(a.agent,new BetterSqlite3(a.memories,{readonly:true,fileMustExist:true,timeout:0}));}catch{sourceErrors.add(a.agent);}
 const allowed=(v:Viewer,agent:string,type='memory')=>maySee(v,{type,agent},options.sharing());
 const agents=(v:Viewer)=>options.agents.filter(a=>allowed(v,a.agent)||allowed(v,a.agent,'conversation'));
 // These are private agent records, never project-scoped. A member scope is
 // checked independently so even the household owner cannot read another thread.
 const seesConversation=(v:Viewer,c:ActivityConversation,agent:string)=>(c.expires===undefined||c.expires>operations.clock.now())&&c.agent===agent&&allowed(v,agent,'conversation')&&maySee(v,{type:'conversation',agent,...(c.member!==undefined?{member:c.member}:{})},options.sharing())&&(venueKey(c.venue)!=='comms'||c.member!==undefined);
 const conversation=(v:Viewer,agent:string,id:string)=>{const raw=options.conversations?.conversation(v,agent,id);if(!raw)return;const c=conversationSchema.parse(raw);return c.id===id&&seesConversation(v,c,agent)?c:undefined;};
 const stamp=(at:string)=>({day:isoDay(Date.parse(at),tz),hour:hourOf(Date.parse(at),tz)});
 function fromRun(r:ActivityRun):ActivityEntry{
  const c=r.conversation,title=c.label.trim().replace(/^(?:schedule|alert) [\w.-]+:\s+(?=\S)/,'').replace(/^\p{Ll}/u,x=>x.toUpperCase())||`A ${VENUES[venueKey(c.venue)]??c.venue} conversation`;
  const venue=venueKey(c.venue),where=venue==='wakes'?(/^lane:|^schedule /.test(c.place)||/^schedule /.test(c.label)?'Lane':/^alert:/.test(c.place)?'Alert':'Wake'):whereLabel(whereOfConversation(c))||VENUES[venue]||c.venue;
  return {id:`${r.kind==='digest'?'d':'c'}~${c.agent}~${r.key}`,agent:c.agent,at:r.at,...stamp(r.at),title,line:r.summary?oneLine(r.summary):`${r.turns??0} turns${r.replies?`, ${r.replies} replies`:''}, no summary yet`,venue,where,what:whatOf({place:c.place,title,line:r.summary}),...(r.expires!==undefined||c.expires!==undefined?{expires:Math.min(r.expires??Infinity,c.expires??Infinity)}:{}),...(venue==='comms'||(options.owner&&c.people.includes(options.owner))?{owner:true as const}:{})};
 }
 function runOpen(r:ActivityRun,v:Viewer):ActivityOpen{
  const entry=fromRun(r),refs=refsIn([r.summary??'',...r.decided].join('\n'),options.github),theirs=v.kind==='member'&&r.needsForMember===v.id;
  return {...entry,asked:r.asked,decided:r.decided,...(r.summary?{story:r.summary}:{}),tasks:[...new Set([...r.tasks,...refs.tasks])].map(id=>({label:id,href:`/p/tasks-preview/task/${encodeURIComponent(id)}`})),prs:refs.prs,
   links:[...r.links,...(theirs&&r.needsHref?[{label:'What it needs you for',href:r.needsHref}]:[])],...(theirs&&r.needs?{needs:r.needs}:{}),
   ...(entry.venue==='comms'&&r.steps?{steps:r.steps.filter(s=>s.tool!=='text')}:{}) ,more:r.more.slice(0,8)};
 }
 function episode(v:Viewer,agent:string,e:Episode):(ActivityOpen & {conversationId?:string})|undefined{
  const meta=parse(e.metadata),where=typeof meta.where==='string'?meta.where:e.project??'?';
  const p=plainEpisode({title:e.title,content:e.content,where,meta},agent,id=>conversation(v,agent,id));
  const venue=venueKey(p.where.split(/[:/]/)[0]),related=p.conversation?conversation(v,agent,p.conversation):undefined;
  if(venue==='comms'){
   const c=related;
   if(!c||venueKey(c.venue)!=='comms')return;
  }
  // A conversation id on any episode can refer to a private Comms thread even
  // when its writer used "terminal" as the surface. Fail closed on named ids
  // the NEW owner cannot authorize; do not guess via legacy stores.
  if(p.conversation&&!related)return;
  const parts=fallbackParts(e.content),refs=refsIn(`${p.title}\n${e.content}`,options.github);
  return {id:`e~${agent}~${e.ref}`,...(p.conversation?{conversationId:p.conversation}:{}),agent,at:e.created,...stamp(e.created),...splitTitle(p.title),venue,where:whereLabel(p.where)||VENUES[venue]||venue,what:whatOf({place:p.where,title:p.title}),
   ...(options.owner&&p.where.includes(options.owner)?{owner:true as const}:{}),...(e.expires_at||related?.expires!==undefined?{expires:Math.min(e.expires_at?Date.parse(e.expires_at):Infinity,related?.expires??Infinity)}:{}),
   asked:parts?.asked?[parts.asked]:[],decided:parts?.shipped??[],story:parts?parts.said:e.content,tasks:refs.tasks.map(id=>({label:id,href:`/p/tasks-preview/task/${id}`})),prs:refs.prs,links:[{label:'The memory',href:`/p/activity-preview/memory/${encodeURIComponent(`${agent}:${e.ref}`)}`}],more:[]};
 }
 function window(scope:string,v:Viewer):ActivityWindow|undefined{
  if(!agents(v).length)return;
  const now=operations.clock.now(),today=isoDay(now,tz),to=scope==='recent'?today:scope;
  if(!validDay(to)||to>today||to<dayBefore(today,MAX_BACK))return;
  const days=windowDays(to,today),from=startOf(days.at(-1)!,tz),until=Math.min(now+60000,startOf(dayBefore(to,-1),tz));
  const entries:ActivityEntry[]=[],runs:Array<{agent:string;venue:string;at:number}>=[],covered=new Set<string>();
  let conversations:ActivityWindow['conversations']=options.conversations?'available':'unavailable',episodes:ActivityWindow['episodes']='available',truncated=false;
  const deadlines=[startOf(dayBefore(today,-1),tz)];
  for(const {agent} of agents(v)){
   if(options.conversations&&allowed(v,agent,'conversation'))try{
    const answer=z.object({available:z.boolean(),rows:z.array(runSchema).max(MAX_ENTRIES+1),expires:z.number().finite().optional()}).strict().parse(options.conversations.list(v,{agent,from,until,limit:MAX_ENTRIES+1}));
    if(!answer.available){conversations='unavailable';}else{
     const rows=answer.rows.filter(r=>seesConversation(v,r.conversation,agent)&&(r.expires===undefined||r.expires>now)&&Date.parse(r.at)>=from&&Date.parse(r.at)<until);
     const digested=new Set(rows.filter(r=>r.kind==='digest').map(r=>r.conversation.id));
     for(const r of rows){if(r.kind==='conversation'&&digested.has(r.conversation.id))continue;const e=fromRun(r);entries.push(e);if(e.expires)deadlines.push(e.expires);covered.add(`${agent}:${r.conversation.id}`);if(r.kind==='digest')runs.push({agent,venue:e.venue,at:Date.parse(e.at)});}
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
    const query=db.prepare(`SELECT ref,title,substr(content,1,20000) AS content,created,project,metadata,expires_at FROM memories WHERE ${active} AND julianday(created)>=julianday(?) AND julianday(created)<julianday(?) ORDER BY julianday(created) DESC,ref`);
    let n=0;
    for(const raw of query.iterate(new Date(now).toISOString(),new Date(from).toISOString(),new Date(until).toISOString())){
     const row=raw as Episode,e=episode(v,agent,row);if(!e)continue;
     const cv=e.conversationId;
     if(cv&&covered.has(`${agent}:${cv}`))continue;
     if(runs.some(r=>r.agent===agent&&r.venue===e.venue&&Math.abs(r.at-Date.parse(e.at))<20*60000))continue;
     if(e.expires&&e.expires>now)deadlines.push(e.expires);
     const {asked:_a,decided:_d,story:_s,tasks:_t,prs:_p,links:_l,more:_m,conversationId:_cv,...entry}=e;entries.push(entry);
     if(++n>MAX_ENTRIES){truncated=true;break;}
    }
   }catch{episodes='error';}
  }
  const sorted=[...new Map(entries.map(e=>[e.id,e])).values()].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)||a.id.localeCompare(b.id));
  return {id:scope,to,days,...(days.at(-1)!>dayBefore(today,MAX_BACK)?{earlier:dayBefore(days.at(-1)!)}:{}),entries:sorted.slice(0,MAX_ENTRIES),conversations,episodes,truncated:truncated||sorted.length>MAX_ENTRIES,expires:Math.min(...deadlines)};
 }
 function read(id:string,v:Viewer):ActivityOpen|ActivityFailure|undefined{
  const m=/^([dce])~([a-z][a-z0-9-]{0,39})~(.{1,300})$/.exec(id);if(!m)return;
  const [,kind,agent,key]=m;if(!agents(v).some(a=>a.agent===agent))return;
  const now=operations.clock.now(),oldest=startOf(dayBefore(isoDay(now,tz),MAX_BACK),tz);
  if(kind!=='e'&&!allowed(v,agent,'conversation'))return;
  if(kind==='e'&&!allowed(v,agent))return;
  const failure=(state:'error'|'unavailable',message:string):ActivityFailure=>({id,state,message});
  if(kind!=='e')try{
   if(!options.conversations)return failure('unavailable','Conversations and digests are not available yet.');
   const raw=options.conversations?.read(v,agent,kind==='d'?'digest':'conversation',key);if(!raw)return;
   const r=runSchema.parse(raw);if(r.key!==key||r.kind!==(kind==='d'?'digest':'conversation')||!seesConversation(v,r.conversation,agent)||(r.expires!==undefined&&r.expires<=now)||Date.parse(r.at)<oldest||Date.parse(r.at)>now+60000)return;
   return runOpen(r,v);
  }catch{return failure('error','The conversation service couldn’t open this entry.');}
  const db=sources.get(agent);if(sourceErrors.has(agent))return failure('error','The episode store couldn’t open this entry.');if(!db)return failure('unavailable','The episode store is not available.');
  try{if(!has(db))return failure('unavailable','The episode store is not available.');const row=db.prepare(`SELECT ref,title,substr(content,1,20000) AS content,created,project,metadata,expires_at FROM memories WHERE ref=? AND ${active} AND julianday(created)>=julianday(?) AND julianday(created)<=julianday(?)`).get(key,new Date(now).toISOString(),new Date(oldest).toISOString(),new Date(now+60000).toISOString()) as Episode|undefined;return row?episode(v,agent,row):undefined;}catch{return failure('error','The episode store couldn’t open this entry.');}
 }
 const changed=(c:{type:string})=>['memory','core.access','household.sharing','conversation','digest','attention.conversation'].includes(c.type)||c.type.startsWith('comms.');
 operations.register(operation({name:'mind.activityList',input:z.object({to:z.string().max(10).default('recent')}).strict(),output:z.unknown(),may:v=>agents(v).length>0,run:(ctx,i)=>window(i.to,ctx.viewer)??{ok:false,code:'not-found',message:'Activity window not found'}}));
 operations.register(operation({name:'mind.activityRead',input:z.object({id:z.string().max(350)}).strict(),output:z.unknown(),may:v=>agents(v).length>0,run:(ctx,i)=>read(i.id,ctx.viewer)??{ok:false,code:'not-found',message:'Activity entry not found'}}));
 live.register({name:'activity.window',ids:s=>s?[s]:[],read:window,inScope:(r,s)=>r.id===s,refreshOn:changed,expires:r=>(r as ActivityWindow).expires});
 live.register({name:'activity.entry',ids:s=>s?[s]:[],read,inScope:(r,s)=>r.id===s,refreshOn:changed,expires:r=>Math.min((r as ActivityOpen).expires??Infinity,startOf(dayBefore(isoDay(operations.clock.now(),tz),-1),tz))});
 live.register({name:'activity.access',ids:()=>['activity'],read:(_id,v)=>{const today=isoDay(operations.clock.now(),tz);return {id:'activity',allowed:agents(v).length>0,agents:agents(v).map(a=>a.agent),owner:options.ownerLabel??options.owner??'Owner',timezone:tz,today,windows:Array.from({length:11},(_,i)=>dayBefore(today,i*3)),expires:startOf(dayBefore(today,-1),tz)};},inScope:()=>true,refreshOn:changed,expires:r=>r.expires as number});
 return {close(){for(const db of sources.values())db.close();}};
}
