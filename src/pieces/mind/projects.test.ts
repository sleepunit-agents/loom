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
async function fixture(a:string,b?:string,roles:{notes?:ProjectSectionRole;conversations?:ProjectSectionRole;changes?:ProjectSectionRole}={}){
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
 expect(memory.total).toBe(40);expect(memory.items).toHaveLength(30);expect(memory.items?.[0].ref).toBe('m-39');expect(memory.items?.at(-1)?.ref).toBe('m-0');expect(memory.items?.map(i=>i.ref).sort()).toEqual([...Array.from({length:10},(_,i)=>`m-${i}`),...Array.from({length:20},(_,i)=>`m-${i+20}`)].sort());
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
 const expired=windows.map(w=>new Promise<void>(resolve=>{const onMessage=(raw:Buffer)=>{const frame=JSON.parse(raw.toString());if(frame.record?.sections.find((s:{key:string})=>s.key==='memories')?.total===0){w.off('message',onMessage);resolve();}};w.on('message',onMessage);}));(app.operations.clock as FakeClock).advance(86400000);await Promise.all(expired);
});
it('passes note selectors and original viewer through the new role, preserving bounded metadata and deadlines',async()=>{
 const a=source();a.write({slug:'pond',name:'Pond',links:{notes:['pond','field/research']}});let asked:unknown;
 const all=Array.from({length:25},(_,i)=>({path:`pond/n-${i}`,updated:new Date(Date.parse('2026-11-13T00:00:00Z')+i*1000).toISOString(),expires:Date.parse('2026-11-14T12:00:00Z')}));all.push({...all[0],path:'pond-other/no-match'});
 const app=await fixture(a.database.name,undefined,{notes:{read(v,q){asked={viewer:v,prefixes:q.card.links.notes};const prefixes=q.card.links.notes??[q.card.slug];const rows=all.filter(n=>n.expires>q.now&&prefixes.some(p=>n.path===p||n.path.startsWith(p+'/'))).sort((a,b)=>Date.parse(b.updated)-Date.parse(a.updated));return {available:true,total:rows.length,activity:rows[0]?.updated,expires:rows[0]?.expires,items:rows.slice(0,20).map(n=>({title:n.path,when:n.updated}))};}}});
 const p=read(app,'art:pond',partial);expect(asked).toEqual({viewer:partial,prefixes:['pond','field/research']});expect(p.sections.find(s=>s.key==='notes')).toMatchObject({total:25,items:expect.any(Array)});expect(p.sections.find(s=>s.key==='notes')?.items).toHaveLength(20);expect(p.activity).toBe(all[24].updated);
 (app.operations.clock as FakeClock).advance(86400000);expect(read(app,'art:pond').sections.find(s=>s.key==='notes')).toMatchObject({total:0,items:[]});
});
it('isolates malformed role output instead of letting it erase a valid Tasks or memory section',async()=>{
 const a=source();a.write({slug:'pond',name:'Pond'});
 const app=await fixture(a.database.name,undefined,{notes:{read:()=>({available:true,items:null}) as never}});
 const p=read(app,'art:pond');expect(p.sections.find(s=>s.key==='notes')).toMatchObject({error:"Notes couldn't answer"});expect(p.sections[0]).toMatchObject({key:'tasks',available:true,groups:[]});
});
it('preserves readiness with hidden blockers, done-since cutoff, and complete epic descendants',async()=>{
 const a=source();a.write({slug:'pond',name:'Pond',links:{epic:'t-1'}});const app=await fixture(a.database.name);
 const call=(verb:string,input:Record<string,unknown>,id:string)=>app.operations.call('direct',owner,`tasks.${verb}`,{actor:'owner',at:'2026-11-13T10:00:00Z',...input},id);
 for(const [title,parent] of [['Epic',undefined],['Ready task','t-1'],['Blocked task','t-1'],['Done recent','t-1'],['Done old','t-1'],['Grandchild','t-2'],['Private blocker',undefined]])expect(call('create',{title,...(parent?{parent}:{}),...(title==='Epic'?{type:'epic'}:{})},title)).toMatchObject({value:{result:{ok:true}}});
 expect(call('link',{id:'t-3',dependsOn:'t-7',type:'blocks'},'block')).toMatchObject({value:{result:{ok:true}}});
 for(const [id,at] of [['t-4','2026-11-12T10:00:00Z'],['t-5','2026-11-01T10:00:00Z']])expect(call('close',{id,at},id)).toMatchObject({value:{result:{ok:true}}});
 const groups=read(app,'art:pond').sections[0].groups!;
 expect(groups.find(g=>g.title==='Ready')?.items.map(i=>i.title)).toEqual(expect.arrayContaining(['Ready task','Grandchild']));
 expect(groups.find(g=>g.title==='Blocked or in progress')?.items.map(i=>i.title)).toContain('Blocked task');
 expect(groups.find(g=>g.title==='Done lately')?.items.map(i=>i.title)).toEqual(['Done recent']);
});
it('links and fully reads an authorized memory, denying project-only members and expiring direct reads',async()=>{
 const a=source();a.write({slug:'pond',name:'Pond'});a.database.exec(`CREATE TABLE memories(id INTEGER PRIMARY KEY,ref TEXT,category TEXT,title TEXT,content TEXT,created TEXT,updated TEXT,project TEXT,archived INTEGER,expires_at TEXT);INSERT INTO memories VALUES(1,'m-test','project','Full memory','The complete body','2026-11-12T12:00:00Z',NULL,'pond',0,'2026-11-14T12:00:00Z')`);
 const app=await fixture(a.database.name),item=read(app,'art:pond').sections.find(s=>s.key==='memories')!.items![0];expect(item.href).toBe('/p/projects-preview/project/art%3Apond/memory/m-test');
 expect(app.operations.call('direct',partial,'mind.projectMemoryRead',{id:'art:m-test'})).toMatchObject({value:{title:'Full memory',content:'The complete body'}});
 expect(app.operations.call('direct',{kind:'member',id:'outsider'},'mind.projectMemoryRead',{id:'art:m-test'})).toMatchObject({code:'denied'});
 expect(app.operations.call('direct',{kind:'service',id:'cards'},'mind.projectMemoryRead',{id:'art:m-test'})).toMatchObject({code:'denied'});
 (app.operations.clock as FakeClock).advance(86400000);expect(app.operations.call('direct',owner,'mind.projectMemoryRead',{id:'art:m-test'})).toMatchObject({code:'not-found'});
});
it('supplies the default note prefix and derives Lately, waiting and a seven-day activity line without promoting role timestamps to card activity',async()=>{
 const a=source();a.write({slug:'pond',name:'Pond'});let prefixes:string[]=[];
 const app=await fixture(a.database.name,undefined,{notes:{read(_v,q){prefixes=q.notePrefixes;return {available:true,items:[{title:'Old note',when:'2026-11-01T12:00:00Z'},{title:'Newest note',when:'2026-11-13T11:00:00Z'},{title:'Third note',when:'2026-11-13T09:00:00Z'},{title:'Fourth note',when:'2026-11-13T08:00:00Z'}],activity:'2026-11-13T11:00:00Z'};}},conversations:{read(v){return {available:true,items:v.id==='owner'?[{title:'An ask',when:'2026-11-13T11:30:00Z',waiting:true,who:['Casey','art']},{title:'A digest',when:'2026-11-13T10:00:00Z',who:['Casey','Pat']}]:[]};}}});
 const p=read(app,'art:pond');expect(prefixes).toEqual(['pond']);expect(p.waiting.map(i=>i.title)).toEqual(['An ask']);expect(p.lately.map(i=>i.title)).toEqual(['Newest note','A digest','Third note']);expect(p.people).toEqual(['art','Casey','Pat']);expect(p.spark).toEqual([0,0,0,0,0,0,5]);expect(p.activity).toBe('2026-11-13T11:00:00Z');
});
it('derives Changes open/failing/checking counts, keeping merged items in Lately and waiting out of it',async()=>{
 const a=source();a.write({slug:'pond',name:'Pond'});const app=await fixture(a.database.name,undefined,{changes:{read:()=>({available:true,groups:[{title:'Waiting',waiting:true,items:[{title:'Answer PR',status:'Waiting on you',when:'2026-11-13T11:00:00Z',who:['Pat']}]},{title:'Author',items:[{title:'Red PR',status:'CI red',when:'2026-11-13T10:00:00Z'},{title:'Checking PR',status:'CI running',when:'2026-11-13T09:00:00Z'},{title:'Merged PR',status:'Merged',when:'2026-11-13T08:00:00Z'}]}]})}});
 const p=read(app,'art:pond');expect(p.changes).toEqual({open:3,failing:1,running:1});expect(p.waiting.map(i=>i.title)).toEqual(['Answer PR']);expect(p.lately.map(i=>i.title)).toEqual(['Red PR','Checking PR','Merged PR']);expect(p.people).toEqual(['art','Pat']);expect(p.spark.reduce((a,b)=>a+b,0)).toBe(4);
});
