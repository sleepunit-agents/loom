/** Computed hubs over existing private agent cards. Missing sources remain missing until restart. */
import {existsSync} from 'node:fs';
import BetterSqlite3,{type Database} from 'better-sqlite3';
import {z} from 'zod';
import {operation,maySee,type Operations,type Live,type Viewer,type Sharing} from '../../core/index.js';
import type {Mind} from './role.js';
import type {PersonRecord} from './people-model.js';
import type {ProjectCard,ProjectRecord,ProjectSection,ProjectItem} from './projects-model.js';
import type {ProjectSectionRole,ProjectQuery} from './projects-roles.js';
export type {ProjectRecord} from './projects-model.js';
const day=86400000;
const has=(db:Database,name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const latest=(times:string[])=>times.sort((a,b)=>Date.parse(b)-Date.parse(a))[0];
export function installMindProjects(operations:Operations,live:Live,options:{agents:Array<{agent:string;memories:string}>;sharing():Sharing;people?:Mind;tasks?:ProjectSectionRole;notes?:ProjectSectionRole;conversations?:ProjectSectionRole;changes?:ProjectSectionRole}){
 const sources=new Map<string,Database>();
 try{for(const a of options.agents)if(existsSync(a.memories))sources.set(a.agent,new BetterSqlite3(a.memories,{readonly:true,fileMustExist:true,timeout:0}));}catch(e){for(const db of sources.values())db.close();throw e;}
 const allowed=(v:Viewer,agent:string)=>maySee(v,{type:'project',agent},options.sharing());
 function ids(scope?:string){if(scope!==undefined)return scope?[scope]:[];return [...sources].flatMap(([agent,db])=>has(db,'projects')?(db.prepare('SELECT slug FROM projects WHERE archived_at IS NULL ORDER BY slug').all() as {slug:string}[]).map(r=>`${agent}:${r.slug}`):[]);}
 function memorySection(db:Database,q:ProjectQuery,v:Viewer):ProjectSection{
  if(!has(db,'memories'))return {key:'memories',label:'Memories',available:false};
  if(!maySee(v,{type:'memory',agent:q.agent},options.sharing()))return {key:'memories',label:'Memories',available:false};
  const cols=(db.pragma('table_info(memories)') as {name:string}[]).map(c=>c.name);
  const where=`archived=0 AND (expires_at IS NULL OR julianday(expires_at)>julianday(?)) AND project IN (${q.names.map(()=>'?').join(',')})`;
  const args=[new Date(q.now).toISOString(),...q.names];
  interface Row {ref:string;category:string;title:string;content:string;created:string;updated:string|null}
  const fields='ref,category,title,content,created,updated';
  const rows=db.prepare(`SELECT ${fields} FROM memories WHERE ${where} ORDER BY created DESC,id DESC LIMIT 20`).all(...args) as Row[];
  if(cols.includes('salience'))rows.push(...db.prepare(`SELECT ${fields} FROM memories WHERE ${where} ORDER BY salience DESC,created DESC,id DESC LIMIT 10`).all(...args) as Row[]);
  const counts=Object.fromEntries((db.prepare(`SELECT category,count(*) AS n FROM memories WHERE ${where} GROUP BY category`).all(...args) as {category:string;n:number}[]).map(r=>[r.category,r.n]));
  const activity=(db.prepare(`SELECT max(coalesce(updated,created)) AS at FROM memories WHERE ${where}`).get(...args) as {at:string|null}).at;
  return {key:'memories',label:'Memories',available:true,...(activity?{activity}:{}),counts,total:Object.values(counts).reduce((a,b)=>a+b,0),items:[...new Map(rows.map(r=>[r.ref,r])).values()].sort((a,b)=>Date.parse(b.created)-Date.parse(a.created)).map(r=>({title:`${r.title} — ${r.content}`.replace(/\s+/g,' ').slice(0,200),ref:r.ref,when:r.created,status:r.category,new:Date.parse(r.updated??r.created)>Date.parse(q.since)}))};
 }
 function peopleSection(v:Viewer,q:ProjectQuery):ProjectSection{
  if(!options.people)return {key:'people',label:'People',available:false};
  const result=options.people.call(v,'peopleList',{});if(!result.ok)throw Error('People could not answer');
  const fields=q.names.map(n=>n.replace(/-/g,'_'));
  // A hub may use the household directory and its own agent relationships, never another agent's cards.
  const rows=(result.value as PersonRecord[]).filter(p=>!p.agent||p.agent===q.agent);
  return {key:'people',label:'People',available:true,items:rows.flatMap(p=>p.fields.filter(f=>fields.includes(f.key)).map(f=>({title:p.name,ref:p.id,status:f.state,body:`${f.key}: ${f.value}`,href:`/p/people-preview/person/${encodeURIComponent(p.slug)}`}))).sort((a,b)=>a.title.localeCompare(b.title))};
 }
 function read(id:string,viewer:Viewer,readingHub=false):ProjectRecord|undefined{
  const colon=id.indexOf(':');if(colon<1)return;
  const agent=id.slice(0,colon),asked=id.slice(colon+1),db=sources.get(agent);
  if(!allowed(viewer,agent)||!db||!has(db,'projects'))return;
  const row=db.prepare('SELECT slug,card_json,updated,archived_at FROM projects WHERE slug=? OR (archived_at IS NULL AND slug IN (SELECT slug FROM project_names WHERE name=?)) ORDER BY CASE WHEN slug=? THEN 0 ELSE 1 END LIMIT 1').get(asked,asked,asked) as {slug:string;card_json:string;updated:string;archived_at:string|null}|undefined;
  if(!row)return;
  const card=JSON.parse(row.card_json) as ProjectCard,now=operations.clock.now();
  const q:ProjectQuery={agent,card,names:[card.slug,...(card.links.aliases??[])],since:new Date(now-7*day).toISOString(),now};
  const sections:ProjectSection[]=[];
  const section=(key:string,label:string,fn:()=>Omit<ProjectSection,'key'|'label'>)=>{try{sections.push({...fn(),key,label});}catch{sections.push({key,label,available:true,error:`${label} couldn't answer`});}};
  const role=(key:string,label:string,r:ProjectSectionRole|undefined)=>section(key,label,()=>r?.read(viewer,q)??{available:false});
  // Quiet cards don't run roles on the index; scoped hubs still compute their sections.
  if(!row.archived_at&&(card.status==='active'||readingHub)){
   role('tasks','Tasks',options.tasks);
   role('changes','Changes',options.changes);
   section('people','People',()=>peopleSection(viewer,q));
   role('conversations','Conversations',options.conversations);
   role('notes','Notes',options.notes);
   section('memories','Memories',()=>db.transaction(()=>memorySection(db,q,viewer))());
  }
  const dated:ProjectItem[]=[],waiting:ProjectItem[]=[],people=new Set([agent]);
  let changes:ProjectRecord['changes'];
  for(const s of sections){
   if(s.error||!s.available)continue;
   for(const item of s.items??[]){if(item.waiting)waiting.push(item);if(item.when)dated.push(item);if(s.key==='people')people.add(item.title);for(const who of item.who??[])people.add(who);}
   if(s.key==='changes')changes={open:0,failing:0,running:0};
   for(const g of s.groups??[])for(const item of g.items){const i={...item,...(g.waiting?{waiting:true}:{})};if(i.waiting)waiting.push(i);if(i.when)dated.push(i);for(const who of i.who??[])people.add(who);if(changes&&s.key==='changes'&&!/^(merged|closed)$/i.test(i.status??'')){changes.open++;if(/^CI red/i.test(i.status??''))changes.failing++;if(/^CI running/i.test(i.status??''))changes.running++;}}
  }
  dated.sort((a,b)=>Date.parse(b.when!)-Date.parse(a.when!));
  const spark=Array.from({length:7},()=>0);for(const i of dated){const back=Math.floor((now-Date.parse(i.when!))/day);if(back>=0&&back<7)spark[6-back]++;}
  const activity=latest([row.updated,...sections.filter(s=>['memories','notes'].includes(s.key)&&s.available&&!s.error&&s.activity).map(s=>s.activity!)]);
  return {id:`${agent}:${row.slug}`,agent,slug:row.slug,name:card.name,card,updated:row.updated,activity,archived:!!row.archived_at,sections,waiting,unknown:sections.some(s=>!!s.error||(!s.available&&['tasks','conversations','changes'].includes(s.key))),lately:dated.filter(i=>!i.waiting).slice(0,3),people:[...people],spark,...(changes?{changes}:{}),fields:Object.entries(card.where).map(([key,f])=>({key,value:f.value,state:!f.verified_at?'unverified':now>Date.parse(f.verified_at)+(f.stale_after_days??14)*day?'stale':'fresh'}))};
 }
 // Live registers separate index/hub projections so paused cards never invoke roles just to list them.
 const hub=(id:string,v:Viewer)=>read(id,v,true);
 operations.register(operation({name:'mind.projectsList',input:z.object({}).strict(),output:z.unknown(),may:()=>true,run:ctx=>ids().flatMap(id=>{const r=read(id,ctx.viewer);return r?[r]:[];})}));
 operations.register(operation({name:'mind.projectRead',input:z.object({id:z.string().min(3).max(200)}).strict(),output:z.unknown(),may:(v,i)=>allowed(v,i.id.split(':')[0]),run:(ctx,i)=>hub(i.id,ctx.viewer)??{ok:false,code:'not-found',message:'Project not found'}}));
 const changed=(c:{type:string})=>['project','memory','person','task','change','core.access','household.sharing'].includes(c.type)||c.type==='note'||c.type.startsWith('notes.')||c.type.startsWith('comms.')||c.type.startsWith('attention.');
 const expires=(r:ProjectRecord)=>{
  const db=sources.get(r.agent),now=operations.clock.now(),deadlines=Object.values(r.card.where).flatMap(f=>f.verified_at?[Date.parse(f.verified_at)+(f.stale_after_days??14)*day+1]:[]);
  if(db&&has(db,'memories')){const names=[r.slug,...(r.card.links.aliases??[])];try{const row=db.prepare(`SELECT min(expires_at) AS at FROM memories WHERE archived=0 AND julianday(expires_at)>julianday(?) AND project IN (${names.map(()=>'?').join(',')})`).get(new Date(now).toISOString(),...names) as {at:string|null};if(row.at)deadlines.push(Date.parse(row.at));}catch{/* Section already exposes a source error. */}}
  deadlines.push(...r.sections.flatMap(s=>s.expires?[s.expires]:[]));
  deadlines.push(...r.sections.flatMap(s=>[...(s.items??[]),...(s.groups??[]).flatMap(g=>g.items)]).flatMap(i=>i.when?[Date.parse(i.when)+7*day+1]:[]));
  return deadlines.filter(t=>t>now).sort((a,b)=>a-b)[0];
 };
 live.register({name:'project',ids,read:(id,v)=>read(id,v),inScope:(r,s)=>s===undefined||r.id===s,refreshOn:changed,expires:r=>expires(r as ProjectRecord)});
 live.register({name:'project.hub',ids,read:hub,inScope:(r,s)=>s!==undefined&&(r.id===s||((r as ProjectRecord).card.links.aliases??[]).some(a=>`${r.agent}:${a}`===s)),refreshOn:changed,expires:r=>expires(r as ProjectRecord)});
 live.register({name:'projects.access',ids:()=>['projects'],read:(_id,v)=>({id:'projects',allowed:options.agents.some(a=>allowed(v,a.agent)),agents:options.agents.filter(a=>allowed(v,a.agent)).map(a=>a.agent)}),inScope:()=>true});
 return {close(){for(const db of sources.values())db.close();}};
}
