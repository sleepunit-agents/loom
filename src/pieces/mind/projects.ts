/** Computed hubs over existing private agent cards. A source is opened when its agent is first listed; one whose file is missing then stays missing until restart. */
import { DAY_MS } from '../../core/day.js';
import {STORE_ID} from '../../slug.js';
import {existsSync} from 'node:fs';
import BetterSqlite3,{type Database} from 'better-sqlite3';
import {AgentFiles} from './sources.js';
import {z} from 'zod';
import {maySee,type Viewer,type Sharing} from '../../core/index.js';
import type {Clock} from '../../core/clock.js';
import {projectDeadline} from './project-deadlines.js';
import {resolveCardReference} from './card-references.js';
import type {PersonRecord} from './people-model.js';
import type {ProjectCard,ProjectRecord,ProjectSection,ProjectItem,ProjectMemory} from './projects-model.js';
import type {ProjectSectionRole,ProjectSectionRead,ProjectQuery} from './projects-roles.js';
import {MAX_REVISIONS,fieldState} from '../../backends/cards.js';
import {hottestIds} from '../../backends/salience.js';
export type {ProjectRecord} from './projects-model.js';
const itemSchema=z.object({title:z.string(),ref:z.string().optional(),when:z.string().optional(),changed:z.string().optional(),status:z.string().optional(),body:z.string().optional(),href:z.string().optional(),who:z.array(z.string()).optional(),waiting:z.boolean().optional(),new:z.boolean().optional()}).strict();
const sectionSchema=z.object({available:z.boolean(),error:z.string().optional(),items:z.array(itemSchema).optional(),groups:z.array(z.object({title:z.string(),waiting:z.boolean().optional(),items:z.array(itemSchema)}).strict()).optional(),total:z.number().int().nonnegative().optional(),counts:z.record(z.string(),z.number()).optional(),activity:z.string().optional(),expires:z.number().finite().optional(),conversationIds:z.array(z.string().min(1).max(200)).optional()}).strict();
const sectionItems=(s:ProjectSection)=>[...(s.items??[]),...(s.groups??[]).flatMap(g=>g.items.map(i=>({...i,...(g.waiting?{waiting:true}:{})})))];
const activeMemory='archived=0 AND (expires_at IS NULL OR julianday(expires_at)>julianday(?))';
const day=DAY_MS;
const days=(ms:number)=>{const n=Math.floor(Math.max(0,ms)/day);return `${n} day${n===1?'':'s'}`;};
const has=(db:Database,name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const latest=(times:string[])=>times.sort((a,b)=>Date.parse(b)-Date.parse(a))[0];
type ProjectRow = {slug:string; card_json:string; updated:string; archived_at:string|null};
export interface ProjectsOptions {agents:Array<{agent:string;memories:string}>;sharing():Sharing;people?:{list(viewer:Viewer,sharing?:Sharing):PersonRecord[]};tasks?:ProjectSectionRole;notes?:ProjectSectionRole;conversations?:ProjectSectionRole;changes?:ProjectSectionRole}
export type ProjectsReader=ReturnType<typeof createProjectsReader>;
/** Read-only sources and typed roles; no registry, live transport or schema initialization. */
export function createProjectsReader(clock:Pick<Clock,'now'>,options:ProjectsOptions){
 const sources=new AgentFiles<{agent:string;memories:string},Database>(()=>options.agents,a=>existsSync(a.memories)?new BetterSqlite3(a.memories,{readonly:true,fileMustExist:true,timeout:0}):undefined);
 try{sources.follow();}catch(e){for(const db of sources.end())db.close();throw e;}
 // One listing reads many projects, and each read asks who may see what several times and lists the people
 // again. The sharing facts are a read of whole tables and nothing in a read writes, so one synchronous call
 // of this reader reads the facts once and lists the people once (`held`). Nothing is kept past the call.
 let held:{sharing:Sharing;viewer:Viewer;people?:PersonRecord[]}|undefined;
 const sharing=()=>held?.sharing??options.sharing();
 const once=<T>(viewer:Viewer,work:()=>T):T=>{if(held)return work();held={sharing:options.sharing(),viewer};try{return work();}finally{held=undefined;}};
 const allowed=(v:Viewer,agent:string)=>maySee(v,{type:'project',agent},sharing());
 const visibleAgents=(viewer:Viewer)=>options.agents.filter(source=>allowed(viewer,source.agent)).map(source=>source.agent);
 function ids(scope?:string){if(scope!==undefined)return scope?[scope]:[];return [...sources].flatMap(([agent,db])=>has(db,'projects')?(db.prepare('SELECT slug FROM projects WHERE archived_at IS NULL ORDER BY slug').all() as {slug:string}[]).map(r=>`${agent}:${r.slug}`):[]);}
 function memorySection(db:Database,q:ProjectQuery,v:Viewer):ProjectSection{
  if(!has(db,'memories'))return {key:'memories',label:'Memories',available:false};
  if(!maySee(v,{type:'memory',agent:q.agent},sharing()))return {key:'memories',label:'Memories',available:false};
  const where=`${activeMemory} AND project IN (${q.names.map(()=>'?').join(',')})`;
  const args=[new Date(q.now).toISOString(),...q.names];
  interface Row {ref:string;category:string;title:string;content:string;created:string;updated:string|null}
  const fields='ref,category,title,content,created,updated';
  const rows=db.prepare(`SELECT ${fields} FROM memories WHERE ${where} ORDER BY created DESC,id DESC LIMIT 20`).all(...args) as Row[];
  // And the ten hottest right now, which may be older than those twenty.
  const hot=hottestIds(db,where,args,10,q.now);
  if(hot.length)rows.push(...db.prepare(`SELECT ${fields} FROM memories WHERE id IN (${hot.map(()=>'?').join(',')})`).all(...hot) as Row[]);
  const counts=Object.fromEntries((db.prepare(`SELECT category,count(*) AS n FROM memories WHERE ${where} GROUP BY category`).all(...args) as {category:string;n:number}[]).map(r=>[r.category,r.n]));
  const activity=(db.prepare(`SELECT max(coalesce(updated,created)) AS at FROM memories WHERE ${where}`).get(...args) as {at:string|null}).at;
  const expiry=(db.prepare(`SELECT expires_at AS at FROM memories WHERE ${where} AND expires_at IS NOT NULL ORDER BY julianday(expires_at),expires_at LIMIT 1`).get(...args) as {at:string}|undefined)?.at;
  return {key:'memories',label:'Memories',available:true,...(expiry?{expires:Date.parse(expiry)}:{}),...(activity?{activity}:{}),counts,total:Object.values(counts).reduce((a,b)=>a+b,0),items:[...new Map(rows.map(r=>[r.ref,r])).values()].sort((a,b)=>Date.parse(b.created)-Date.parse(a.created)).map(r=>({title:`${r.title} — ${r.content}`.replace(/\s+/g,' ').slice(0,200),href:`/p/projects-preview/project/${encodeURIComponent(`${q.agent}:${q.card.slug}`)}/memory/${encodeURIComponent(r.ref)}`,ref:r.ref,when:r.created,changed:r.updated??r.created,status:r.category,new:Date.parse(r.updated??r.created)>Date.parse(q.since)}))};
 }
 function peopleSection(v:Viewer,q:ProjectQuery):ProjectSection{
  if(!options.people)return {key:'people',label:'People',available:false};
  // The people reader is handed the facts this call read, so the two readers read them once between them.
  const people=held?.viewer===v?(held.people??=options.people.list(v,held.sharing)):options.people.list(v);
  const fields=q.names.map(n=>n.replace(/-/g,'_'));
  // A hub may use the household directory and its own agent relationships, never another agent's cards.
  const rows=people.filter(p=>!p.agent||p.agent===q.agent);
  return {key:'people',label:'People',available:true,items:rows.flatMap(p=>p.fields.filter(f=>fields.includes(f.key)).map(f=>({title:p.name,ref:p.id,status:f.state,body:`${f.key}: ${f.value}`,href:`/p/people-preview/person/${encodeURIComponent(p.slug)}`}))).sort((a,b)=>a.title.localeCompare(b.title))};
 }
 function read(id:string,viewer:Viewer,readingHub=false):ProjectRecord|undefined{
  const colon=id.indexOf(':');if(colon<1)return;
  const agent=id.slice(0,colon),reference=id.slice(colon+1),db=sources.get(agent);
  if(!allowed(viewer,agent)||!db||!has(db,'projects'))return;
  const asked=resolveCardReference(db,'project',reference);
  const row=db.prepare('SELECT slug,card_json,updated,archived_at FROM projects WHERE slug=? OR (archived_at IS NULL AND slug IN (SELECT slug FROM project_names WHERE name=?)) ORDER BY CASE WHEN slug=? THEN 0 ELSE 1 END LIMIT 1').get(asked,asked,asked) as ProjectRow|undefined;
  return row && projectRecord(agent, db, row, viewer, readingHub);
 }
 function projectRecord(agent:string, db:Database, row:ProjectRow, viewer:Viewer, readingHub:boolean, agents=visibleAgents(viewer), prepared?:Map<ProjectSectionRole,ProjectSectionRead>):ProjectRecord{
  const card=JSON.parse(row.card_json) as ProjectCard,now=clock.now();
  const q:ProjectQuery={agent,card,names:[card.slug,...(card.links.aliases??[])],notePrefixes:card.links.notes?.length?card.links.notes:[card.slug],since:new Date(now-7*day).toISOString(),now};
  const sections:ProjectSection[]=[];
  const section=(key:string,label:string,fn:()=>Omit<ProjectSection,'key'|'label'>)=>{try{const raw=fn();const {key:_key,label:_label,...data}=raw as ProjectSection;sections.push({...sectionSchema.parse(data),key,label});}catch{sections.push({key,label,available:true,error:`${label} couldn't answer`});}};
  const role=(key:string,label:string,r:ProjectSectionRole|undefined)=>section(key,label,()=>{
   if (!r) return {available:false};
   if (!prepared || !r.prepareForList) return r.read(viewer,q);
   let reader = prepared.get(r);
   if (!reader) {
    try { reader = r.prepareForList(viewer); }
    catch (error) { reader = () => { throw error; }; }
    prepared.set(r,reader);
   }
   return reader(q);
  });
  // Quiet cards don't run roles on the index; scoped hubs still compute their sections.
  if(!row.archived_at&&(card.status==='active'||readingHub)){
   role('conversations','Conversations',options.conversations);
   const conversations=sections.pop()!;q.conversations=conversations.conversationIds??[];
   role('tasks','Tasks',options.tasks);
   role('changes','Changes',options.changes);
   section('people','People',()=>peopleSection(viewer,q));
   sections.push(conversations);
   role('notes','Notes',options.notes);
   section('memories','Memories',()=>db.transaction(()=>memorySection(db,q,viewer))());
  }
  const dated:ProjectItem[]=[],waiting:ProjectItem[]=[],people=new Map<string,string>([[agent.toLowerCase(),agent]]);
  const addPerson=(name:string)=>{const key=name.trim().toLowerCase();if(key&&!people.has(key))people.set(key,name);};
  for(const item of sections.find(s=>s.key==='people'&&s.available&&!s.error)?.items??[])addPerson(item.title);
  for(const s of sections.filter(s=>s.key!=='people'&&s.key!=='conversations'&&s.available&&!s.error))for(const item of sectionItems(s))for(const name of item.who??[])addPerson(name);
  for(const item of sections.filter(s=>s.key==='conversations'&&s.available&&!s.error).flatMap(sectionItems))for(const name of item.who??[])addPerson(name);
  let changes:ProjectRecord['changes'];
  for(const s of sections){
   if(s.error||!s.available)continue;
   if(s.key==='changes')changes={open:0,failing:0,running:0};
   const items=sectionItems(s);
   for(const item of items){
    if(item.waiting)waiting.push(item);if(item.when)dated.push(item);
    if(changes&&s.key==='changes'&&!/^(merged|closed)$/i.test(item.status??'')){changes.open++;if(/^CI red/i.test(item.status??''))changes.failing++;if(/^CI running/i.test(item.status??''))changes.running++;}
   }
  }
  dated.sort((a,b)=>Date.parse(b.when!)-Date.parse(a.when!));
  const spark=Array.from({length:7},()=>0);for(const i of dated){const back=Math.floor((now-Date.parse(i.when!))/day);if(back>=0&&back<7)spark[6-back]++;}
  const activity=latest([row.updated,...sections.filter(s=>['memories','notes'].includes(s.key)&&s.available&&!s.error&&s.activity).map(s=>s.activity!)]);
  return {id:`${agent}:${row.slug}`,agent,agents:[...agents],now,slug:row.slug,name:card.name,card,updated:row.updated,activity,archived:!!row.archived_at,sections,waiting,unknown:sections.some(s=>!!s.error||(!s.available&&['tasks','conversations','changes'].includes(s.key))),lately:dated.filter(i=>!i.waiting).slice(0,3),people:[...people.values()],spark,...(changes?{changes}:{}),fields:Object.entries(card.where).map(([key,f])=>({key,value:f.value,state:!f.verified_at?'not checked':fieldState(f,now).kind==='stale'?`stale for ${days(now-Date.parse(f.verified_at))}`:`checked ${days(now-Date.parse(f.verified_at))} ago`}))};
 }
 // Keep separate index/hub projections so paused cards never invoke roles just to list them.
 const list = (viewer:Viewer) => once(viewer, () => {
  const projects:ProjectRecord[] = [];
  const prepared = new Map<ProjectSectionRole,ProjectSectionRead>();
  let agents:string[]|undefined;
  for (const [agent, db] of sources) {
   if (!allowed(viewer, agent) || !has(db, 'projects')) continue;
   const rows = db.prepare('SELECT slug,card_json,updated,archived_at FROM projects WHERE archived_at IS NULL ORDER BY slug').all() as ProjectRow[];
   if (!rows.length) continue;
   agents ??= visibleAgents(viewer);
   for (const row of rows) projects.push(projectRecord(agent, db, row, viewer, false, agents, prepared));
  }
  return projects;
 });
 const hub=(id:string,v:Viewer)=>once(v,()=>read(id,v,true));
 const expires=(r:ProjectRecord)=>{
  const db=sources.get(r.agent),now=clock.now(),deadlines=[projectDeadline(r,now)];
  if(db&&has(db,'memories')){const names=[r.slug,...(r.card.links.aliases??[])];try{const row=db.prepare(`SELECT expires_at AS at FROM memories WHERE ${activeMemory} AND expires_at IS NOT NULL AND project IN (${names.map(()=>'?').join(',')}) ORDER BY julianday(expires_at),expires_at LIMIT 1`).get(new Date(now).toISOString(),...names) as {at:string}|undefined;if(row)deadlines.push(Date.parse(row.at));}catch{/* Section already exposes a source error. */}}
  return deadlines.filter((at):at is number=>at!==undefined&&Number.isFinite(at)&&at>now).sort((a,b)=>a-b)[0];
 };
 const memorySource=(id:string,v:Viewer)=>{
  const colon=id.indexOf(':');if(colon<1)return;const agent=id.slice(0,colon),ref=id.slice(colon+1),db=sources.get(agent);
  if(!db||!maySee(v,{type:'memory',agent},sharing())||!has(db,'memories'))return;
  const opaque=(db.pragma('table_info(memories)') as {name:string}[]).some(column=>column.name==='uuid');
  return {agent,db,selector:opaque?'(ref=? OR uuid=?)':'ref=?',params:opaque?[ref,ref]:[ref]};
 };
 const memoryRead=(id:string,v:Viewer):ProjectMemory|undefined=>{
  const source=memorySource(id,v);if(!source)return;const {agent,db,selector,params}=source;
  const row=db.prepare(`SELECT ref,title,content,category,created,coalesce(updated,created) AS updated,expires_at FROM memories WHERE ${selector} AND ${activeMemory}`).get(...params,new Date(clock.now()).toISOString()) as {ref:string;title:string;content:string;category:string;created:string;updated:string;expires_at:string|null}|undefined;
  if(!row)return;const {expires_at,...data}=row;return {id,agent,...data,...(expires_at?{expires:Date.parse(expires_at)}:{})};
 };
 const retained=(agent:string,v:Viewer,kind:'archive'|'proposal',first:number,before?:string|null)=>{
  const db=sources.get(agent);if(!db||!maySee(v,{type:'memory',agent},sharing()))return null;
  const table=kind==='archive'?'memories':'proposals';if(!has(db,table))return {entries:[],nextBefore:null};
  const columns=new Set((db.pragma(`table_info(${table})`) as {name:string}[]).map(column=>column.name));
  if(!columns.has(kind==='archive'?'archived':'status'))throw Error('Retained source schema is unavailable');
  const fields={uuid:'uuid',ref:'ref',title:'title',content:'content',category:'category',project:'project',ttl:'ttl',created:'created',expires_at:'expiresAt',archive_note:'archiveNote',source:'source'};
  const projection=Object.entries(fields).map(([column,alias])=>`${columns.has(column)?column:'NULL'} AS ${alias}`).join(',');
  const cursor=before===undefined||before===null?[]:[before];
  const rows=db.prepare(`SELECT CAST(id AS TEXT) AS cursor,${projection} FROM ${table} WHERE ${kind==='archive'?'archived=1':"status='pending'"}${cursor.length?' AND id<?':''} ORDER BY id DESC LIMIT ?`).all(...cursor,first+1) as Array<{cursor:string;uuid:string|null;ref:string|null;title:string|null;content:string|null;category:string|null;project:string|null;ttl:string|null;created:string|null;expiresAt:string|null;archiveNote:string|null;source:string|null}>;
  const page=rows.slice(0,first);
  return {entries:page.map(({cursor:_cursor,uuid,archiveNote,...row})=>{
   let note=archiveNote,archivedAt:string|null=null;
   try{const parsed:unknown=JSON.parse(archiveNote??'null');if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)){const value=parsed as Record<string,unknown>;note=typeof value.note==='string'?value.note:null;archivedAt=typeof value.archived_at==='string'?value.archived_at:null;}}catch{/* Unparsed archive notes stay readable without source changes. */}
   return {...row,id:uuid&&STORE_ID.test(uuid)?`${agent}:${kind==='proposal'?'proposal:':''}${uuid}`:null,note,archivedAt};
  }),nextBefore:rows.length>first?page.at(-1)!.cursor:null};
 };
 // Every live memory's line, newest first, under the same private Memory
 // visibility as the other reads. A plain read: it adds no recall heat.
 const memoryList=(agent:string,v:Viewer,filter:{category?:string|null;project?:string|null},first:number)=>{
  const db=sources.get(agent);if(!db||!maySee(v,{type:'memory',agent},sharing()))return null;
  if(!has(db,'memories'))return [];
  const columns=new Set((db.pragma('table_info(memories)') as {name:string}[]).map(column=>column.name));
  if(!columns.has('archived'))throw Error('Memory source schema is unavailable');
  const column=(name:string)=>columns.has(name)?name:'NULL',clauses=['archived=0'],params:unknown[]=[];
  if(columns.has('expires_at')){clauses.push("(expires_at IS NULL OR julianday(expires_at)>julianday(?))");params.push(new Date(clock.now()).toISOString());}
  for(const name of ['category','project'] as const)if(filter[name]){clauses.push(`${column(name)}=?`);params.push(filter[name]);}
  const rows=db.prepare(`SELECT ${column('uuid')} AS uuid,${column('title')} AS title,${column('category')} AS category,${column('project')} AS project,${column('created')} AS created,coalesce(${column('updated')},${column('created')}) AS updated,${column('sourcing')} AS sourcing FROM memories WHERE ${clauses.join(' AND ')} ORDER BY ${column('created')} DESC,id DESC LIMIT ?`).all(...params,first) as Array<{uuid:string|null;title:string|null;category:string|null;project:string|null;created:string|null;updated:string|null;sourcing:string|null}>;
  return rows.map(({uuid,...row})=>({id:uuid&&STORE_ID.test(uuid)?`${agent}:${uuid}`:null,...row}));
 };
 const memoryHistory=(id:string,v:Viewer)=>{
  const source=memorySource(id,v);if(!source||!has(source.db,'memory_revisions'))return [];const {db,selector,params}=source;
  const row=db.prepare(`SELECT id FROM memories WHERE ${selector}`).get(...params) as {id:number}|undefined;
  // History is an explicit retained-version read, including archived/expired
  // rows, under the same current private Memory visibility as the source.
  return row?db.prepare('SELECT id,op,replaced_at AS replacedAt,content FROM memory_revisions WHERE memory_id=? ORDER BY id DESC LIMIT ?').all(row.id,MAX_REVISIONS) as {id:number;op:string;replacedAt:string;content:string}[]:[];
 };
 const access=(v:Viewer)=>once(v,()=>({id:'projects',allowed:options.agents.some(a=>allowed(v,a.agent)),agents:options.agents.filter(a=>allowed(v,a.agent)).map(a=>a.agent)}));
 let closed=false;
 const reader={access,ids,allowed,expires,readIndex:(id:string,v:Viewer)=>once(v,()=>read(id,v)),read:hub,memoryRead,memoryHistory,retained,memoryList,list,close(){if(closed)return;closed=true;for(const db of sources.values())db.close();}};
 return reader;
}
