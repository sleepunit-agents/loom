import {afterEach,expect,it} from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {startLoom} from '../../foundation.js';
import {FakeClock,type Sharing,type Viewer} from '../../core/index.js';
import {ProjectsStore} from '../../backends/projects.js';
import {PeopleStore} from '../../backends/people.js';
import {installTouched} from '../../core/touched/index.js';
import {installTasks} from '../tasks/index.js';
import {tasksRole} from '../tasks/role.js';
import {mindRole} from './role.js';
import {installMindPeople} from './people.js';
import {installMindProjects,type ProjectRecord} from './projects.js';
import {projectTasks,type ProjectSectionRole} from './projects-roles.js';
const homes:string[]=[],closes:Array<()=>void|Promise<void>>=[];
const dir=()=>{const h=mkdtempSync(join(tmpdir(),'mind-projects-'));homes.push(h);return h;};
afterEach(async()=>{for(const fn of closes.splice(0).reverse())await fn();for(const h of homes.splice(0))rmSync(h,{recursive:true,force:true});});
const owner:Viewer={kind:'member',id:'owner'},partial:Viewer={kind:'member',id:'partial'};
const sharing:Sharing={members:{owner:{owner:true,agents:[]},partial:{owner:false,agents:['art']},outsider:{owner:false,agents:[]}},projects:{pond:{members:['outsider'],agents:[]}},services:{cards:{types:['project'],operations:['mind.projectRead']}}};
function source(){const path=join(dir(),'memories.db');const store=new ProjectsStore({dbPath:path,now:()=>Date.parse('2026-11-12T12:00:00Z')});const database=new BetterSqlite3(path);closes.push(()=>store.close(),()=>database.close());return {write:store.write.bind(store),database};}
async function fixture(a:string,b?:string,roles:{notes?:ProjectSectionRole;conversations?:ProjectSectionRole}={}){
 const clock=new FakeClock(Date.parse('2026-11-13T12:00:00Z'));
 const app=await startLoom({home:dir(),clock,authenticate:req=>({viewer:req.url?.includes('partial')?partial:owner,valid:()=>true}),install(app){
  installTasks(app.db,app.operations,app.live,()=>sharing);
  const agents=[{agent:'art',memories:a},...(b?[{agent:'other',memories:b}]:[])];
  const people=installMindPeople(app.operations,app.live,{agents,sharing:()=>sharing});app.onClose(()=>people.close());
  const projects=installMindProjects(app.operations,app.live,{agents,sharing:()=>sharing,people:mindRole(app.operations),tasks:projectTasks(tasksRole(app.operations)),...roles});app.onClose(()=>projects.close());
  installTouched(app.operations,(v,c)=>v.kind==='agent'&&v.id==='art'?c:undefined);
 }});closes.push(()=>app.close());return app;
}
function read(app:Awaited<ReturnType<typeof fixture>>,id:string,v=owner){const r=app.operations.call('direct',v,'mind.projectRead',{id});if(!r.ok)throw Error(r.message);return r.value as ProjectRecord;}
it('keeps private agent project selection and each content type independently authorized',async()=>{
 const a=source(),b=source();a.write({slug:'pond',name:'Art Pond'});b.write({slug:'pond',name:'Other Pond'});
 const app=await fixture(a.database.name,b.database.name);
 expect(app.operations.call('direct',partial,'mind.projectsList',{})).toMatchObject({value:[{id:'art:pond',name:'Art Pond'}]});
 expect(app.operations.call('direct',{kind:'member',id:'outsider'},'mind.projectsList',{})).toMatchObject({value:[]});
 expect(app.operations.call('direct',partial,'mind.projectRead',{id:'other:pond'})).toMatchObject({code:'denied'});
 expect(read(app,'art:pond',{kind:'service',id:'cards'}).sections.find(s=>s.key==='people')).toMatchObject({available:true,items:[]});
 expect(app.operations.call('direct',{kind:'agent',id:'other'},'mind.projectsList',{})).toMatchObject({value:[{id:'other:pond'}]});
});
it('selects newest twenty plus ten salient memories by aliases, excludes archived/expired, and keeps section failures separate',async()=>{
 const a=source();a.write({slug:'pond',name:'Pond',links:{aliases:['on-pond']}});
 a.database.exec('CREATE TABLE memories(id INTEGER PRIMARY KEY,ref TEXT,category TEXT,title TEXT,content TEXT,created TEXT,updated TEXT,project TEXT,archived INTEGER,expires_at TEXT,salience REAL)');
 const insert=a.database.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?,?)');
 for(let i=0;i<40;i++)insert.run(i,`m-${i}`,'project',`Memory ${i}`,'content',new Date(Date.parse('2026-11-12T00:00:00Z')+i*1000).toISOString(),null,i%2?'on-pond':'pond',0,null,40-i);
 insert.run(50,'expired','project','Expired','secret','2026-11-13T00:00:00Z',null,'pond',0,'2026-11-13T12:00:00Z',100);
 insert.run(51,'archived','project','Archived','secret','2026-11-13T00:00:00Z',null,'pond',1,null,100);
 const app=await fixture(a.database.name,undefined,{notes:{read(){throw Error('private path should not leak');}},conversations:{read:(v,q)=>({available:true,items:v.id==='owner'?[{title:q.card.name,waiting:true,href:'/p/inbox-preview'}]:[]})}});
 const p=read(app,'art:on-pond');const memory=p.sections.find(s=>s.key==='memories')!;
 expect(memory.total).toBe(40);expect(memory.items).toHaveLength(30);expect(memory.items?.[0].ref).toBe('m-39');expect(memory.items?.at(-1)?.ref).toBe('m-0');
 expect(memory.items?.some(i=>i.ref==='expired'||i.ref==='archived')).toBe(false);
 expect(p.sections.find(s=>s.key==='notes')).toMatchObject({error:"Notes couldn't answer"});expect(JSON.stringify(p)).not.toContain('private path');
 expect(p.waiting).toHaveLength(1);expect(read(app,'art:pond',partial).waiting).toHaveLength(0);
 expect(read(app,'art:pond',{kind:'service',id:'cards'}).sections.find(s=>s.key==='memories')).toMatchObject({available:false});
});
it('uses own agent and directory people, matching hyphen aliases without opening other agent relationships',async()=>{
 const a=source(),b=source();a.write({slug:'pond',name:'Pond',links:{aliases:['on-pond']}});
 const pa=new PeopleStore({dbPath:a.database.name}),pb=new PeopleStore({dbPath:b.database.name});closes.push(()=>pa.close(),()=>pb.close());
 pa.write({slug:'friend',name:'Friend',where:{on_pond:{value:'Maintainer'}}});pb.write({slug:'hidden',name:'Other private friend',where:{pond:{value:'Secret'}}});
 const app=await fixture(a.database.name,b.database.name);expect(read(app,'art:pond').sections.find(s=>s.key==='people')?.items).toEqual([expect.objectContaining({title:'Friend',body:'on_pond: Maintainer'})]);
});
it('projects the tasks role first: epic descendants, outside names, waiting, readiness and done since',async()=>{
 const a=source();a.write({slug:'pond',name:'Pond',links:{epic:'t-1'}});const app=await fixture(a.database.name);
 const create=(title:string,extra={})=>app.operations.call('direct',owner,'tasks.create',{title,actor:'owner',at:'2026-11-13T10:00:00Z',...extra},`create-${title}`);
 expect(create('Pond epic',{type:'epic'})).toMatchObject({ok:true});create('Inside',{parent:'t-1'});create('Outside pond task');create('Unrelated');
 app.operations.call('direct',owner,'tasks.update',{id:'t-2',actor:'owner',at:'2026-11-13T10:00:00Z',set:{assignee:'owner',ask:'Approve this?'}},'ask');
 const p=read(app,'art:pond');expect(p.sections[0].key).toBe('tasks');expect(p.waiting.map(i=>i.title)).toEqual(['Inside']);
 const items=p.sections[0].groups?.flatMap(g=>g.items)??[];expect(items.map(i=>i.title)).toEqual(expect.arrayContaining(['Pond epic','Inside','Outside pond task']));expect(items.some(i=>i.title==='Unrelated')).toBe(false);expect(items.find(i=>i.title==='Outside pond task')?.status).toBe('outside the tree');
});
it('does not create missing sources; quiet index skips roles and scoped hubs still compute them',async()=>{
 const missing=join(dir(),'missing.db'),a=source();a.write({slug:'quiet',name:'Quiet',status:'paused'});let calls=0;
 const app=await fixture(a.database.name,missing,{notes:{read(){calls++;return {available:true,items:[]};}}});
 expect(app.operations.call('direct',owner,'mind.projectsList',{})).toMatchObject({value:[{sections:[]}]});expect(calls).toBe(0);
 expect(read(app,'art:quiet').sections.length).toBeGreaterThan(0);expect(calls).toBe(1);expect(existsSync(missing)).toBe(false);
});
it('updates two windows after outside project writes, and removes expired memory at the precise clock deadline',async()=>{
 const a=source();a.write({slug:'pond',name:'Pond'});
 a.database.exec(`CREATE TABLE memories(id INTEGER PRIMARY KEY,ref TEXT,category TEXT,title TEXT,content TEXT,created TEXT,updated TEXT,project TEXT,archived INTEGER,expires_at TEXT,salience REAL); INSERT INTO memories VALUES(1,'m-one','project','Brief','Temporary','2026-11-13T00:00:00Z',NULL,'pond',0,'2026-11-14T12:00:00.000Z',1)`);
 const app=await fixture(a.database.name);
 const windows=await Promise.all(['','?partial'].map(async suffix=>{const ws=new WebSocket(app.url.replace('http:','ws:')+'/live'+suffix);closes.push(()=>ws.close());await once(ws,'open');const initial=once(ws,'message');ws.send(JSON.stringify({kind:'subscribe',type:'project.hub',scope:'art:pond'}));expect(JSON.parse((await initial)[0].toString()).records[0].name).toBe('Pond');return ws;}));
 let next=windows.map(w=>once(w,'message'));a.write({slug:'pond',name:'Changed pond'});app.operations.call('direct',{kind:'agent',id:'art'},'core.touched',{type:'project',id:'art:pond'});
 for(const p of next)expect(JSON.parse((await p)[0].toString()).record.name).toBe('Changed pond');
 next=windows.map(w=>once(w,'message'));(app.operations.clock as FakeClock).advance(86400000);
 for(const p of next){const frame=JSON.parse((await p)[0].toString());expect(frame.record.sections.find((s:{key:string})=>s.key==='memories').total).toBe(0);}
});
