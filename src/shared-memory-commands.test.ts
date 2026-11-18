/** Native command authority, source receipts and the actual shared HTTP/socket door. */
import {afterEach,expect,it,vi} from 'vitest';
import Database,{type Database as Connection} from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync,symlinkSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {getRequestListener} from '@hono/node-server';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {eq} from 'drizzle-orm';
import {z} from 'zod';
import {GraphQLString} from 'graphql/index.js';
import {bodyCommandClient} from './runtime/body-command-client.js';
import {bodyMemoryIdentity,bodyIdentityQuery} from './runtime/body-memory-identity.js';
import {bodyProgram} from './runtime/body-program.js';
import type {WorkerAssignment} from './runtime/worker.js';
const owned=vi.hoisted(()=>({connections:[] as Connection[],failLoad:false}));
vi.mock('better-sqlite3',async importOriginal=>{
 const original=await importOriginal<{default:typeof Database}>();
 return {default:new Proxy(original.default,{construct(target,args,newTarget){const db=Reflect.construct(target,args,newTarget) as Connection;owned.connections.push(db);return db;}})};
});
vi.mock('sqlite-vec',async importOriginal=>{
 const original=await importOriginal<typeof import('sqlite-vec')>();
 return {...original,load:(db:Connection)=>{if(owned.failLoad)throw Error('injected extension setup failure');return original.load(db);}};
});
const releases:Array<()=>void>=[];
const embed=vi.hoisted(()=>({gate:undefined as undefined|(()=>Promise<void>),calls:0}));
vi.mock('./backends/fastembed.js',()=>({FastEmbedProvider:class{
 readonly dimensions=4;
 async embed(text:string){embed.calls++;await embed.gate?.();const v=['alpha','beta','gamma','delta'].map(word=>text.toLowerCase().includes(word)?1:0);if(!v.some(Boolean))v[3]=1;const size=Math.hypot(...v);return v.map(n=>n/size);}
 async embedBatch(texts:string[]){return Promise.all(texts.map(text=>this.embed(text)));}
}}));
import {bodyFixture,bodyCredentials as raw,credentialHash} from '../test/fixtures/conversation-body.js';
import {prepareSharedMemorySources} from './shared-memory.js';
import {ProjectsStore} from './backends/projects.js';
import {PeopleStore} from './backends/people.js';
import * as s from './core/data/schema.js';
import {HELD_REFUSALS} from './shared-place-mail.js';
const clean:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{owned.failLoad=false;embed.gate=undefined;for(const release of releases.splice(0))release();for(const close of clean.splice(0).reverse())await close();vi.useRealTimers();vi.restoreAllMocks();});
const words='alpha NATIVE_PRIVATE_MEMORY_WORDS',title='PRIVATE_MEMORY_TITLE';
const input={category:'project',title,content:words,project:'pond'};
async function fixture(options:{unprepared?:boolean}={}){
 const home=mkdtempSync(join(tmpdir(),'native-memory-fiction-'));clean.push(()=>rmSync(home,{recursive:true,force:true}));clean.push(()=>{for(const db of owned.connections.splice(0))if(db.open)db.close();});
 const common=join(home,'commons'),directory=join(home,'agents/art'),other=join(home,'agents/mark');
 const memory={checkingAgent:'art',sources:{commons:{directory:common,knowledge:join(common,'knowledge.db'),people:join(common,'people.db')},agents:[{agent:'art',directory,memories:join(directory,'memories.db')},{agent:'mark',directory:other,memories:join(other,'memories.db')}]}};
 await prepareSharedMemorySources(memory);const project=new ProjectsStore({dbPath:memory.sources.agents[0].memories});project.write({slug:'pond',name:'Fictional pond'});project.close();
 let sourceBefore:Buffer|undefined;
 if(options.unprepared){const db=new Database(memory.sources.agents[0].memories);db.exec('DROP TABLE memory_command_schema; DROP TABLE memory_command_preparations; DROP TABLE memory_command_receipts');sourceBefore=db.serialize();db.close();await prepareSharedMemorySources(memory);}
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.parse('2026-11-14T18:00:00Z'));
 const f=await bodyFixture(clean,{memory});await f.root.ready;
 const server=createServer(getRequestListener(request=>f.root.http.fetch(request))),detach=f.root.attach(server);
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw Error('No fixture address');const url=`http://127.0.0.1:${address.port}`;
 clean.push(async()=>{detach();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 const path=memory.sources.agents[0].memories,source=new Database(path,{fileMustExist:true});clean.push(()=>{source.close();});
 const call=async(verb:string,value:unknown,id:string,token=raw.body)=>{const response=await fetch(url+'/api/memory/'+verb,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({input:value,id})});return {status:response.status,result:await response.json()};};
 const query=async(query:string,token=raw.body)=>{const response=await fetch(url+'/graphql',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({query})});const result=await response.json();expect(result.errors).toBeUndefined();return result.data;};
 const count=()=>source.prepare("SELECT 1 FROM sqlite_schema WHERE name='memories'").get()? (source.prepare('SELECT count(*) AS n FROM memories').get() as {n:number}).n:0;
 return {...f,home,path,source,url,call,query,count,sourceBefore,memory,other:memory.sources.agents[1].memories};
}
async function next(ws:WebSocket,action:()=>unknown){const pending=once(ws,'message');await action();return JSON.parse(String((await pending)[0]));}
function hold(){let entered!:()=>void,release!:()=>void;const began=new Promise<void>(resolve=>entered=resolve),blocked=new Promise<void>(resolve=>release=resolve);embed.gate=async()=>{entered();await blocked;};releases.push(release);return {began,release};}
it('authors private person and project cards through native commands, with typed values, aliases and bounded person revisions',async()=>{
 const f=await fixture(),calls=embed.calls;
 const client=bodyCommandClient({url:f.url,token:raw.body,clock:f.clock,signal:new AbortController().signal});clean.push(()=>client.close());
 const catalog=await client.command('runtime.commandCatalog',{name:'memory.personWrite'},'card-catalog');expect(catalog).toMatchObject({ok:true,value:{commands:[{name:'memory.personWrite'}]}});if(!catalog.ok)throw Error('Missing card catalogue');
 const person={slug:'friend',name:'PRIVATE_FRIEND',summary:'PRIVATE_CARD_SUMMARY',where:{width:{value:0},ready:{value:false},tags:{value:['one','two']}},how:{tone:'brief'},may:[{text:'A claim about being an owner',source:'A fictional conversation'}]};
 const madePerson=await client.command('memory.personWrite',person,'person-make'),madeProject=await client.command('memory.projectWrite',{slug:'repair',name:'PRIVATE_REPAIR',summary:'PRIVATE_PROJECT_SUMMARY',goal:'Fit the hose',where:{hose:{value:'25 mm'}},links:{aliases:['garden-repair'],repos:['example/fiction']}},'project-make');
 expect(madePerson.ok).toBe(true);expect(madeProject.ok).toBe(true);if(!madePerson.ok||!madeProject.ok)throw Error('Missing private card results');
 const personId=(madePerson.value as {ids:string[]}).ids[0],projectId=(madeProject.value as {ids:string[]}).ids[0];expect(personId).toMatch(/^art:person:[a-f0-9-]{36}$/);expect(projectId).toMatch(/^art:project:[a-f0-9-]{36}$/);
 expect(embed.calls).toBe(calls);
 const selected=await f.query(`{memoryPerson(id:"${personId}"){mergedFrom card{name summary where{key value{number boolean strings}} how{key value{text}} may{text}}} memoryProject(id:"${projectId}"){id card{slug name goal links{aliases}}}}`);
 expect(selected.memoryPerson.mergedFrom).toBeNull();expect(selected.memoryPerson.card).toMatchObject({name:'PRIVATE_FRIEND',summary:'PRIVATE_CARD_SUMMARY',where:expect.arrayContaining([{key:'width',value:{number:0,boolean:null,strings:null}},{key:'ready',value:{number:null,boolean:false,strings:null}}]),how:[{key:'tone',value:{text:'brief'}}],may:[{text:'A claim about being an owner'}]});expect(selected.memoryProject).toMatchObject({id:'art:repair',card:{slug:'repair',name:'PRIVATE_REPAIR',goal:'Fit the hose',links:{aliases:['garden-repair']}}});
 expect((await f.call('projectWrite',{slug:'garden-repair',summary:'PRIVATE_PROJECT_EDIT'},'project-alias')).result.value.ids).toEqual([projectId]);
 const cleared=await f.call('projectWrite',{slug:'repair',links:{aliases:null,notes:null,epic:null,repos:null,venues:null}},'project-clear-links');expect(cleared.status).toBe(200);expect(cleared.result.value.ids).toEqual([projectId]);
 expect((await f.query(`{memoryProject(id:"${projectId}"){card{links{aliases notes epic repos venues}}}}`)).memoryProject.card.links).toEqual({aliases:null,notes:null,epic:null,repos:null,venues:null});expect((await f.query('{memoryProject(id:"art:garden-repair"){name}}')).memoryProject).toBeNull();
 for(let i=0;i<12;i++)expect((await f.call('personWrite',{slug:'friend',summary:'PRIVATE_PERSON_EDIT_'+i},'person-edit-'+i)).status).toBe(200);
 const revisions=(await f.query('{memoryPerson(id:"art:friend"){history{id op actor card{summary}}}}')).memoryPerson.history;expect(revisions).toHaveLength(10);expect(revisions[0]).toMatchObject({actor:'art',card:{summary:'PRIVATE_PERSON_EDIT_10'}});
 const restored=await f.call('personRestoreRevision',{slug:'friend',revision_id:revisions[0].id},'person-revision');expect(restored.status).toBe(200);expect(restored.result.value.ids).toEqual([personId]);expect(await f.call('personRestoreRevision',{slug:'friend',revision_id:revisions[0].id},'person-revision')).toEqual(restored);
 expect((await f.query('{memoryPerson(id:"art:friend"){card{summary} history{card{summary}}}}')).memoryPerson).toMatchObject({card:{summary:'PRIVATE_PERSON_EDIT_10'},history:expect.arrayContaining([{card:{summary:'PRIVATE_PERSON_EDIT_11'}}])});
 expect(f.db.select().from(s.members).all().find(row=>row.id==='alice')?.role).toBe('member');expect(f.db.select().from(s.projectMembers).all()).toHaveLength(1);
 expect(await f.query(`{memoryPerson(id:"${projectId}"){name} memoryProject(id:"${personId}"){name}}`)).toEqual({memoryPerson:null,memoryProject:null});
 for(const value of ['friend','repair','garden-repair','PRIVATE_FRIEND','PRIVATE_REPAIR','PRIVATE_CARD_SUMMARY','PRIVATE_PROJECT_EDIT','PRIVATE_PERSON_EDIT_',f.path])expect(Buffer.from(f.db.$client.serialize()).includes(Buffer.from(value))).toBe(false);
});
it('restricts card writes to the current body source and keeps card claims separate from grants',async()=>{
 const f=await fixture();
 for(const [verb,value] of [['personWrite',{slug:'friend',name:'Friend'}],['projectWrite',{slug:'repair',name:'Repair'}],['personRestoreRevision',{slug:'friend',revision_id:1}]] as const){
  for(const [index,token] of [raw.member,raw.runner].entries())expect((await f.call(verb,value,'card-weak-'+verb+'-'+index,token)).status).toBe(403);
  for(const extra of [{agent:'mark'},{path:f.other}])expect((await f.call(verb,{...value,...extra},'card-path-'+verb+'-'+Object.keys(extra)[0])).status).toBe(400);
  expect((await f.call(verb,{...value,slug:'../mark'},'card-escape-'+verb)).status).toBe(400);
 }
 expect((await f.call('personWrite',{slug:'friend',name:'Friend',where:{role:{value:'owner'}}},'card-claim')).status).toBe(200);
 expect((await f.call('personWrite',{slug:'friend',where:{tier:{value:3}}},'card-reserved')).status).toBe(400);
 expect(await f.query('{memoryPerson(id:"mark:friend"){name} memoryProject(id:"mark:repair"){name}}')).toEqual({memoryPerson:null,memoryProject:null});expect(f.db.select().from(s.members).all().find(row=>row.id==='alice')?.role).toBe('member');
});
it('rolls back card effects with their private receipts and recovers person restoration without another snapshot',async()=>{
 const f=await fixture();expect((await f.call('personWrite',{slug:'friend',name:'PRIVATE_ORIGINAL'},'card-atomic-make')).status).toBe(200);
 f.source.exec("CREATE TRIGGER fail_card_source BEFORE INSERT ON memory_command_receipts WHEN NEW.name IN ('memory.personWrite','memory.projectWrite') BEGIN SELECT RAISE(ABORT,'injected'); END");
 expect((await f.call('personWrite',{slug:'friend',summary:'PRIVATE_ROLLBACK'},'card-atomic-edit')).status).toBe(503);expect((await f.query('{memoryPerson(id:"art:friend"){card{summary} history{id}}}')).memoryPerson).toEqual({card:{summary:null},history:[]});
 expect((await f.call('projectWrite',{slug:'repair',name:'PRIVATE_PROJECT',links:{aliases:['garden-repair']}},'card-atomic-project')).status).toBe(503);expect((await f.query('{memoryProject(id:"art:garden-repair"){name}}')).memoryProject).toBeNull();
 expect(f.source.prepare("SELECT * FROM memory_card_references WHERE kind='project'").all()).toEqual([]);
 expect(f.source.prepare('SELECT slug FROM project_names WHERE name=?').get('garden-repair')).toBeUndefined();f.source.exec('DROP TRIGGER fail_card_source');
 expect((await f.call('personWrite',{slug:'friend',summary:'PRIVATE_ROLLBACK'},'card-atomic-edit')).status).toBe(200);const revision=(await f.query('{memoryPerson(id:"art:friend"){history{id}}}')).memoryPerson.history[0].id;
 f.db.$client.exec("CREATE TRIGGER fail_card_core BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT,'injected'); END");expect((await f.call('personRestoreRevision',{slug:'friend',revision_id:revision},'card-atomic-restore')).status).toBe(503);
 const query='{memoryPerson(id:"art:friend"){card{summary} history{id card{summary}}}}',after=await f.query(query);expect(after.memoryPerson.card.summary).toBeNull();expect(after.memoryPerson.history).toHaveLength(2);
 f.db.$client.exec('DROP TRIGGER fail_card_core');expect((await f.call('personRestoreRevision',{slug:'friend',revision_id:revision},'card-atomic-restore')).status).toBe(200);expect(await f.query(query)).toEqual(after);
});
it('rolls back a person card when the current body ends during its preparation',async()=>{
 const f=await fixture(),write=PeopleStore.prototype.write;
 vi.spyOn(PeopleStore.prototype,'write').mockImplementation(function(this:PeopleStore,value){const result=write.call(this,value);f.root.writes.run(()=>f.db.update(s.jobs).set({state:'done'}).where(eq(s.jobs.id,'job')).run());return result;});
 expect((await f.call('personWrite',{slug:'friend',name:'PRIVATE_REVOKED'},'card-revoked')).status).toBe(403);expect(f.source.prepare('SELECT slug FROM people').all()).toEqual([]);expect(f.source.prepare('SELECT * FROM person_revisions').all()).toEqual([]);
 expect(f.source.prepare('SELECT * FROM memory_card_references').all()).toEqual([]);
});
it('keeps existing semantic-only preparation usable without silently preparing private card references',async()=>{
 const f=await fixture();f.source.exec('DROP TABLE memory_card_references; DROP TABLE memory_card_schema');const before=f.source.serialize();await prepareSharedMemorySources(f.memory);expect(f.source.serialize()).toEqual(before);
 for(const [verb,value] of [['personWrite',{slug:'friend',name:'Friend'}],['projectWrite',{slug:'repair',name:'Repair'}],['personRestoreRevision',{slug:'friend',revision_id:1}]] as const){expect((await f.call(verb,value,'older-'+verb)).status).toBe(503);expect(f.source.serialize().equals(before)).toBe(true);}
 expect(f.source.serialize()).toEqual(before);expect((await f.call('remember',input,'older-semantic')).status).toBe(200);
});
it('browses retained private archive and proposal words through the actual canonical HTTP door without source or shared copies',async()=>{
 const f=await fixture(),made=await f.call('remember',{...input,ttl:'1h'},'retained-make'),id=made.result.value.ids[0];expect((await f.call('archive',{id,note:'PRIVATE_ARCHIVE_REASON'},'retained-archive')).status).toBe(200);
 const proposed=await f.call('propose',{category:'rough capture',title:'PRIVATE_PROPOSAL_TITLE',content:'PRIVATE_PROPOSAL_WORDS',source:'fictional capture'},'retained-propose');expect(proposed.status).toBe(200);const proposal=proposed.result.value.ids[0];
 const later=f.clock.now()+7200000;vi.setSystemTime(later);vi.spyOn(f.clock,'now').mockReturnValue(later);const before=f.source.serialize();
 const query='{memoryArchive(agent:"art",first:1){entries{id title content note expiresAt} nextBefore} memoryProposals(agent:"art"){entries{id title content source} nextBefore}}';
 const rows=await f.query(query);expect(rows.memoryArchive).toEqual({entries:[{id,title,content:words,note:'PRIVATE_ARCHIVE_REASON',expiresAt:'2026-11-14T19:00:00.000Z'}],nextBefore:null});expect(rows.memoryProposals).toEqual({entries:[{id:proposal,title:'PRIVATE_PROPOSAL_TITLE',content:'PRIVATE_PROPOSAL_WORDS',source:'fictional capture'}],nextBefore:null});
 expect((await f.query(`{memoryProjectMemory(id:"${id}"){content}}`)).memoryProjectMemory).toBeNull();expect(f.source.serialize()).toEqual(before);
 expect(await f.query('{memoryArchive(agent:"mark"){entries{content}} memoryProposals(agent:"mark"){entries{content}}}')).toEqual({memoryArchive:null,memoryProposals:null});
 f.root.writes.run(()=>f.db.delete(s.memberAgents).where(eq(s.memberAgents.member,'alice')).run());expect(await f.query(query,raw.member)).toEqual({memoryArchive:null,memoryProposals:null});
 for(const value of [words,title,'PRIVATE_ARCHIVE_REASON','PRIVATE_PROPOSAL_TITLE','PRIVATE_PROPOSAL_WORDS',f.path])expect(Buffer.from(f.db.$client.serialize()).includes(Buffer.from(value))).toBe(false);
});
it('edits and restores bounded private revisions through actual native commands and authorized GraphQL',async()=>{
 const f=await fixture(),id=(await f.call('remember',{...input,ttl:'1h'},'history-make')).result.value.ids[0];
 const history=async(token=raw.body)=>(await f.query(`{memoryHistory(id:"${id}"){id op replacedAt content}}`,token)).memoryHistory as {id:number;op:string;replacedAt:string;content:string}[];
 for(let i=0;i<12;i++)expect((await f.call('update',{id,content:`alpha PRIVATE_EDIT_${i}`},'edit-'+i)).status).toBe(200);
 const revisions=await history();expect(revisions).toHaveLength(10);expect(revisions[0]).toMatchObject({op:'update',content:'alpha PRIVATE_EDIT_10'});expect(revisions.at(-1)?.content).toBe('alpha PRIVATE_EDIT_1');
 expect(await f.query(`{memoryProjectMemory(id:"${id}"){content}}`)).toEqual({memoryProjectMemory:{content:'alpha PRIVATE_EDIT_11'}});
 const restored=await f.call('restoreRevision',{id,revision_id:revisions[0].id},'restore-version');expect(restored.status).toBe(200);expect(restored.result.value).toEqual({ids:[id]});
 expect(await f.query(`{memoryProjectMemory(id:"${id}"){content}}`)).toEqual({memoryProjectMemory:{content:'alpha PRIVATE_EDIT_10'}});
 const after=await history();expect(after).toHaveLength(10);expect(after[0]).toMatchObject({op:'revision-restore',content:'alpha PRIVATE_EDIT_11'});
 expect(await f.call('restoreRevision',{id,revision_id:revisions[0].id},'restore-version')).toEqual(restored);expect(await history()).toEqual(after);
 const before=f.source.serialize();expect(await history()).toEqual(after);expect(f.source.serialize()).toEqual(before);
 const later=f.clock.now()+7200000;vi.setSystemTime(later);vi.spyOn(f.clock,'now').mockReturnValue(later);
 expect((await f.query(`{memoryProjectMemory(id:"${id}"){content}}`)).memoryProjectMemory).toBeNull();expect(await history()).toEqual(after);
 expect((await f.call('archive',{id},'history-archive')).status).toBe(200);expect(await history()).toEqual(after);
 const lifecycle=()=>f.source.prepare('SELECT archived,ttl,expires_at FROM memories WHERE uuid=?').get(id.slice(4));const archived=lifecycle();
 expect((await f.call('restoreRevision',{id,revision_id:after[0].id},'archived-revision')).status).toBe(200);expect(lifecycle()).toEqual(archived);
 expect(archived).toEqual({archived:1,ttl:'1h',expires_at:'2026-11-14T19:00:00.000Z'});expect((await f.query(`{memoryProjectMemory(id:"${id}"){content}}`)).memoryProjectMemory).toBeNull();
 const retained=await history();expect(retained[0]).toMatchObject({op:'revision-restore',content:'alpha PRIVATE_EDIT_10'});expect(await history(raw.member)).toEqual(retained);
 f.root.writes.run(()=>f.db.delete(s.memberAgents).where(eq(s.memberAgents.member,'alice')).run());expect(await history(raw.member)).toEqual([]);
 for(const value of [words,title,'PRIVATE_EDIT_',f.path])expect(Buffer.from(f.db.$client.serialize()).includes(Buffer.from(value))).toBe(false);
});
it('keeps edit and revision-restore authority own-body scoped, and rejects a revision belonging to another memory',async()=>{
 const f=await fixture(),id=(await f.call('remember',input,'target-make')).result.value.ids[0],other=(await f.call('remember',{...input,title:'Other target',content:'beta PRIVATE_OTHER'},'other-make')).result.value.ids[0];
 expect((await f.call('update',{id:other,content:'beta PRIVATE_OTHER_EDIT'},'other-edit')).status).toBe(200);
 const revisions=(await f.query(`{memoryHistory(id:"${other}"){id content}}`)).memoryHistory;
 expect((await f.call('restoreRevision',{id,revision_id:revisions[0].id},'wrong-version')).status).toBe(404);
 for(const [verb,value] of [['update',{id,content:'new words'}],['restoreRevision',{id,revision_id:revisions[0].id}]] as const){
  expect((await f.call(verb,{...value,id:id.replace('art:','mark:')},'foreign-'+verb)).status).toBe(403);
  for(const [index,token] of [raw.member,raw.runner].entries())expect((await f.call(verb,value,'weaker-'+verb+'-'+index,token)).status).toBe(403);
  expect((await f.call(verb,{...value,path:f.other},'path-'+verb)).status).toBe(400);
 }
 expect((await f.call('update',{id},'empty-edit')).status).toBe(400);expect((await f.call('update',{id,content:'  '},'blank-edit')).status).toBe(400);
 expect((await f.query(`{memoryHistory(id:"${id.replace('art:','mark:')}"){content}}`)).memoryHistory).toEqual([]);
 expect(await f.query(`{memoryProjectMemory(id:"${id}"){content}}`)).toEqual({memoryProjectMemory:{content:words}});
});
it('rolls back revisions with failed source receipts and recovers committed revision restores without repeating them',async()=>{
 const f=await fixture(),id=(await f.call('remember',input,'atomic-history-make')).result.value.ids[0];
 const current=()=>f.query(`{memoryProjectMemory(id:"${id}"){content} memoryHistory(id:"${id}"){id op content}}`);
 f.source.exec("CREATE TRIGGER fail_edit_receipt BEFORE INSERT ON memory_command_receipts WHEN NEW.name='memory.update' BEGIN SELECT RAISE(ABORT,'injected'); END");
 expect((await f.call('update',{id,content:'beta PRIVATE_ROLLBACK'},'atomic-edit')).status).toBe(503);expect(await current()).toEqual({memoryProjectMemory:{content:words},memoryHistory:[]});
 f.source.exec('DROP TRIGGER fail_edit_receipt');expect((await f.call('update',{id,content:'beta PRIVATE_ROLLBACK'},'atomic-edit')).status).toBe(200);
 const revision=(await current()).memoryHistory[0].id;
 f.db.$client.exec("CREATE TRIGGER fail_restore_core BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT,'injected'); END");
 expect((await f.call('restoreRevision',{id,revision_id:revision},'atomic-restore')).status).toBe(503);const after=await current();expect(after.memoryProjectMemory.content).toBe(words);expect(after.memoryHistory).toHaveLength(2);const calls=embed.calls;
 f.db.$client.exec('DROP TRIGGER fail_restore_core');expect((await f.call('restoreRevision',{id,revision_id:revision},'atomic-restore')).status).toBe(200);expect(await current()).toEqual(after);expect(embed.calls).toBe(calls);
 const gate=hold(),pending=f.call('update',{id,content:'gamma REVOKED_EDIT'},'revoked-edit');await gate.began;f.root.writes.run(()=>f.db.update(s.jobs).set({state:'done'}).where(eq(s.jobs.id,'job')).run());gate.release();expect((await pending).status).toBe(403);
 expect(f.source.prepare('SELECT content FROM memories').get()).toEqual({content:words});expect(f.source.prepare('SELECT count(*) AS n FROM memory_revisions').get()).toEqual({n:2});
});
it('binds commands to the actual body, publishes committed content, and reads opaque results through current GraphQL authority',async()=>{
 const f=await fixture(),ws=new WebSocket(f.url.replace('http:','ws:')+'/graphql','graphql-transport-ws',{headers:{authorization:'Bearer '+raw.body}});clean.push(()=>ws.terminate());await once(ws,'open');
 expect((await next(ws,()=>ws.send(JSON.stringify({type:'connection_init'})))).type).toBe('connection_ack');
 const catalog=await fetch(f.url+'/api/runtime/commandCatalog',{method:'POST',headers:{authorization:'Bearer '+raw.body,'content-type':'application/json'},body:JSON.stringify({input:{name:'memory.recall'}})});expect(catalog.status).toBe(200);
 const definition=(await catalog.json()).value.commands[0];expect(definition.name).toBe('memory.recall');expect(definition.inputSchema.description).toContain('opaque IDs');expect(definition.inputSchema.properties).not.toHaveProperty('agent');expect(definition.inputSchema.additionalProperties).toBe(false);

 const initial=await next(ws,()=>ws.send(JSON.stringify({type:'subscribe',id:'memory',payload:{query:'subscription($query:String!){observe(query:$query){patches{path value removed}}}',variables:{query:'{memoryProject(id:"art:pond"){sections{key total items{title body}}}}'}}})));
 expect(initial.type).toBe('next');expect(JSON.stringify(initial)).toContain('memories');
 type Frame={id?:string;type:string;payload?:unknown};
 const publication=new Promise<Frame|{closed:number}>(resolve=>{const message=(raw:import('ws').RawData)=>{ws.off('close',closed);resolve(JSON.parse(String(raw)) as Frame);},closed=(code:number)=>{ws.off('message',message);resolve({closed:code});};ws.once('message',message);ws.once('close',closed);});
 const remembered=await f.call('remember',input,'remember');expect(remembered.status).toBe(200);let changed=await publication;
 if('closed' in changed){
  // Guarded publication may request a fresh snapshot if a committed write
  // overtook frame serialization. The canonical client reconnects on1012.
  expect(changed.closed).toBe(1012);
  const retry=new WebSocket(f.url.replace('http:','ws:')+'/graphql','graphql-transport-ws',{headers:{authorization:'Bearer '+raw.body}});clean.push(()=>retry.terminate());await once(retry,'open');await next(retry,()=>retry.send(JSON.stringify({type:'connection_init'})));
  changed=await next(retry,()=>retry.send(JSON.stringify({type:'subscribe',id:'memory',payload:{query:'subscription($query:String!){observe(query:$query){patches{path value removed}}}',variables:{query:'{memoryProject(id:"art:pond"){sections{key total items{title body}}}}'}}})));
 }
 expect(JSON.stringify(changed)).toContain(words);
 const id=remembered.result.value.ids[0];expect(id).toMatch(/^art:[a-f0-9-]{36}$/);expect(JSON.stringify(remembered)).not.toContain(title);expect(JSON.stringify(remembered)).not.toContain(words);
 expect(await f.query(`{memoryProjectMemory(id:"${id}"){title content}}`)).toEqual({memoryProjectMemory:{title,content:words}});
 const recall=await f.call('recall',{query:'alpha',limit:1},'recall');expect(recall.status).toBe(200);expect(recall.result.value).toMatchObject({ids:[id],matches:[{id}]});expect(JSON.stringify(recall)).not.toContain(words);
 const heat=()=>f.source.prepare('SELECT recall_heat,recall_heat_at,last_accessed FROM memories').all();
 // Recall is a read: asking again recalls again, and warms what it finds again.
 const before=embed.calls,again=await f.call('recall',{query:'alpha',limit:1},'recall');expect(again.status).toBe(200);expect(again.result.value).toMatchObject({ids:[id],matches:[{id}]});expect(embed.calls).toBe(before+1);expect(heat()).toHaveLength(1);
 expect(f.source.prepare("SELECT count(*) AS n FROM memory_command_receipts WHERE name='memory.recall'").get()).toEqual({n:0});
 for(const token of [raw.member,raw.runner])expect((await f.call('remember',input,'wrong-'+token[0],token)).status).toBe(403);
 expect((await f.call('remember',{...input,agent:'mark'},'choose-agent')).status).toBe(400);expect((await f.call('remember',{...input,path:f.other},'choose-path')).status).toBe(400);
 const canonical=JSON.stringify({category:input.category,content:input.content,project:input.project,title:input.title}),fingerprint=f.key.hash(canonical);
 expect(fingerprint).not.toBe(createHash('sha256').update(canonical).digest('hex'));
 expect(f.db.select().from(s.operationResults).all().find(row=>row.id==='remember')?.inputHash).toBe(fingerprint);
 expect(f.source.prepare('SELECT input_hash FROM memory_command_receipts WHERE id=?').get('remember')).toEqual({input_hash:fingerprint});
 expect(f.count()).toBe(1);expect(Buffer.from(f.db.$client.serialize()).includes(Buffer.from(words))).toBe(false);expect(Buffer.from(f.db.$client.serialize()).includes(Buffer.from(title))).toBe(false);
});
it('uses shared authored-input validation and the normal episode TTL default',async()=>{
 const f=await fixture();
 for(const change of [{title:'   '},{content:'\n\t'}])expect((await f.call('remember',{...input,...change},'blank-'+Object.keys(change)[0])).status).toBe(400);
 expect(f.count()).toBe(0);expect(f.source.prepare('SELECT count(*) AS n FROM memory_command_preparations').get()).toEqual({n:0});
 const made=await f.call('remember',{...input,category:'episode'},'episode-default');expect(made.status).toBe(200);expect(f.source.prepare('SELECT ttl,expires_at FROM memories').get()).toEqual({ttl:'48h',expires_at:'2026-11-16T18:00:00.000Z'});
 expect((await f.call('remember',{...input,category:'episode',title:'Permanent episode',ttl:'permanent'},'episode-explicit')).status).toBe(200);expect(f.source.prepare('SELECT ttl,expires_at FROM memories WHERE title=?').get('Permanent episode')).toEqual({ttl:'permanent',expires_at:null});
});
it('recalls active candidates past expired top matches without reheating expired memories or requiring pruning',async()=>{
 const f=await fixture(),expired=(await f.call('remember',{...input,ttl:'1h'},'recall-expired')).result.value.ids[0],active=(await f.call('remember',{...input,title:'Still active',content:'alpha beta ACTIVE',ttl:'permanent'},'recall-active')).result.value.ids[0];
 const now=f.clock.now()+3600000;vi.setSystemTime(now);vi.spyOn(f.clock,'now').mockReturnValue(now);
 const result=await f.call('recall',{query:'alpha',limit:1},'recall-after-expiry');expect(result.status).toBe(200);expect(result.result.value.ids).toEqual([active]);expect(f.source.prepare('SELECT recall_heat FROM memories WHERE uuid=?').get(expired.slice(4))).toEqual({recall_heat:0});expect(f.count()).toBe(2);
 expect((await f.call('remember',{...input,ttl:'1h'},'remember-after-expiry')).result.value.ids).toEqual([expired]);expect(await f.query(`{memoryProjectMemory(id:"${expired}"){content}}`)).toEqual({memoryProjectMemory:{content:words}});expect(f.count()).toBe(2);
});
it('forwards TTL, metadata, category and project filters and truncates eligible recall matches',async()=>{
 const f=await fixture(),ids:string[]=[];
 for(const [i,category,project] of [[0,'project','pond'],[1,'project','pond'],[2,'user','pond'],[3,'project','other']] as const){
  const value={category,project,title:'Option '+i,content:'alpha option '+i,...(i===0?{ttl:'2d',metadata:{nested:{enabled:false,count:0},tags:[]}}:{})};
  const result=await f.call('remember',value,'option-'+i);expect(result.status).toBe(200);ids.push(result.result.value.ids[0]);
 }
 const stored=f.source.prepare('SELECT ttl,expires_at,metadata FROM memories WHERE uuid=?').get(ids[0].slice(4));expect(stored).toEqual({ttl:'2d',expires_at:'2026-11-16T18:00:00.000Z',metadata:JSON.stringify({nested:{enabled:false,count:0},tags:[]})});
 const filtered=await f.call('recall',{query:'alpha',category:'project',project:'pond',limit:50},'filtered');expect(filtered.status).toBe(200);expect(new Set(filtered.result.value.ids)).toEqual(new Set(ids.slice(0,2)));
 const limited=await f.call('recall',{query:'alpha',category:'project',project:'pond',limit:1},'limited');expect(limited.result.value.ids).toHaveLength(1);expect(ids.slice(0,2)).toContain(limited.result.value.ids[0]);
});
it('leaves an existing unprepared source byte-for-byte unchanged through startup and refused commands',async()=>{
 const f=await fixture({unprepared:true});expect(f.source.serialize()).toEqual(f.sourceBefore);
 expect(await f.query('{memoryProject(id:"art:pond"){name}}')).toEqual({memoryProject:{name:'Fictional pond'}});
 expect((await f.call('remember',input,'unprepared-start')).status).toBe(503);expect((await f.call('recall',{query:'alpha'},'unprepared-recall')).status).toBe(503);
 for(const [verb,value] of [['personWrite',{slug:'friend',name:'Friend'}],['projectWrite',{slug:'repair',name:'Repair'}],['personRestoreRevision',{slug:'friend',revision_id:1}]] as const)expect((await f.call(verb,value,'unprepared-'+verb)).status).toBe(503);expect(f.source.serialize()).toEqual(f.sourceBefore);
 const id='art:00000000-0000-0000-0000-000000000000';expect((await f.call('update',{id,content:'A valid edit'},'unprepared-edit')).status).toBe(503);expect((await f.call('restoreRevision',{id,revision_id:1},'unprepared-version')).status).toBe(503);expect(f.source.serialize()).toEqual(f.sourceBefore);
 expect((await f.call('propose',input,'unprepared-propose')).status).toBe(503);expect((await f.call('ratify',{id:'art:proposal:00000000-0000-0000-0000-000000000000'},'unprepared-ratify')).status).toBe(503);expect(f.source.serialize()).toEqual(f.sourceBefore);
 expect(f.source.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'memory_command_%'").all()).toEqual([]);
});
it('publishes a committed source effect even when its shared receipt cannot be saved',async()=>{
 const f=await fixture(),gate=hold();f.db.$client.exec("CREATE TRIGGER fail_live_receipt BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT,'injected'); END");
 const pending=f.call('remember',input,'failed-live');await gate.began;
 const ws=new WebSocket(f.url.replace('http:','ws:')+'/graphql','graphql-transport-ws',{headers:{authorization:'Bearer '+raw.body}});clean.push(()=>ws.terminate());await once(ws,'open');await next(ws,()=>ws.send(JSON.stringify({type:'connection_init'})));
 const initial=await next(ws,()=>ws.send(JSON.stringify({type:'subscribe',id:'memory',payload:{query:'subscription($query:String!){observe(query:$query){patches{path value removed}}}',variables:{query:'{memoryProject(id:"art:pond"){sections{key total items{title body}}}}'}}})));expect(JSON.stringify(initial)).not.toContain(words);
 const publication=new Promise<unknown>((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Committed source effect was not published')),2000);ws.once('message',data=>{clearTimeout(timeout);resolve(JSON.parse(String(data)));});});
 gate.release();expect((await pending).status).toBe(503);expect(f.count()).toBe(1);expect(JSON.stringify(await publication)).toContain(words);
});
it('recovers the committed private result after shared receipt failure and reserves the id against unrelated writes',async()=>{
 const f=await fixture();f.db.$client.exec("CREATE TRIGGER fail_memory_core BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT,'injected'); END");
 expect((await f.call('remember',input,'recover')).status).toBe(503);expect(f.count()).toBe(1);const before=embed.calls;
 let writes=0;f.root.operations.register({name:'fixture.write',write:true,input:z.object({}).strict(),output:z.null(),may:()=>true,run(){writes++;return null;}});
 const unrelated=await fetch(f.url+'/api/fixture/write',{method:'POST',headers:{authorization:'Bearer '+raw.body,'content-type':'application/json'},body:JSON.stringify({input:{},id:'recover'})});expect(unrelated.status).toBe(409);expect(writes).toBe(0);
 f.db.$client.exec('DROP TRIGGER fail_memory_core');const replay=await f.call('remember',input,'recover');expect(replay.status).toBe(200);expect(f.count()).toBe(1);expect(embed.calls).toBe(before);
 expect((await f.call('remember',{...input,content:'Different'},'recover')).status).toBe(409);
 f.root.writes.run(()=>f.db.update(s.jobs).set({state:'done'}).where(eq(s.jobs.id,'job')).run());expect([401,403]).toContain((await f.call('remember',input,'recover')).status);
});
it('keeps native proposals outside recall until ratification, applies edits and defaults, and replays opaque results',async()=>{
 const f=await fixture(),before=embed.calls,draft={...input,category:'rough draft',source:'PRIVATE_DRAFT_SOURCE',metadata:{enabled:false,count:0}};
 const proposed=await f.call('propose',draft,'native-proposal');expect(proposed.status).toBe(200);const id=proposed.result.value.ids[0];expect(id).toMatch(/^art:proposal:[a-f0-9-]{36}$/);expect(embed.calls).toBe(before);expect(f.count()).toBe(0);
 expect(await f.call('propose',draft,'native-proposal')).toEqual(proposed);expect(f.source.prepare('SELECT count(*) AS n FROM proposals').get()).toEqual({n:1});expect((await f.call('recall',{query:'alpha'},'draft-invisible')).result.value.ids).toEqual([]);
 expect((await f.call('ratify',{id},'invalid-draft')).status).toBe(400);expect(f.source.prepare('SELECT count(*) AS n FROM proposals').get()).toEqual({n:1});expect(f.count()).toBe(0);
 const ratification={id,overrides:{category:'episode',title:'Ratified native draft',content:'beta RATIFIED_NATIVE_WORDS'}},ratified=await f.call('ratify',ratification,'native-ratify');expect(ratified.status).toBe(200);const memory=ratified.result.value.ids[0];expect(memory).toMatch(/^art:[a-f0-9-]{36}$/);
 expect(f.source.prepare('SELECT count(*) AS n FROM proposals').get()).toEqual({n:0});expect(f.source.prepare('SELECT title,content,category,ttl,metadata FROM memories').get()).toEqual({title:'Ratified native draft',content:'beta RATIFIED_NATIVE_WORDS',category:'episode',ttl:'48h',metadata:JSON.stringify(draft.metadata)});
 expect((await f.call('recall',{query:'beta'},'draft-visible')).result.value.ids).toEqual([memory]);expect(await f.call('ratify',ratification,'native-ratify')).toEqual(ratified);
 for(const value of [words,title,draft.source,'RATIFIED_NATIVE_WORDS',f.path])expect(Buffer.from(f.db.$client.serialize()).includes(Buffer.from(value))).toBe(false);
});
it('rolls back a failed proposal source receipt and recovers its committed draft after shared receipt failure',async()=>{
 const f=await fixture(),drafts=()=>f.source.prepare("SELECT 1 FROM sqlite_schema WHERE name='proposals'").get()?(f.source.prepare('SELECT count(*) AS n FROM proposals').get() as {n:number}).n:0;
 f.source.exec("CREATE TRIGGER fail_propose_source BEFORE INSERT ON memory_command_receipts WHEN NEW.name='memory.propose' BEGIN SELECT RAISE(ABORT,'injected'); END");expect((await f.call('propose',input,'propose-recovery')).status).toBe(503);expect(drafts()).toBe(0);f.source.exec('DROP TRIGGER fail_propose_source');
 f.db.$client.exec("CREATE TRIGGER fail_propose_shared BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT,'injected'); END");expect((await f.call('propose',input,'propose-recovery')).status).toBe(503);expect(drafts()).toBe(1);f.db.$client.exec('DROP TRIGGER fail_propose_shared');
 expect((await f.call('propose',input,'propose-recovery')).status).toBe(200);expect(drafts()).toBe(1);expect(f.count()).toBe(0);
});
it('ratifies atomically with draft removal and private receipt, then recovers a failed shared receipt without duplication',async()=>{
 const f=await fixture(),id=(await f.call('propose',input,'rollback-proposal')).result.value.ids[0];
 f.source.exec("CREATE TRIGGER fail_ratify_source BEFORE INSERT ON memory_command_receipts WHEN NEW.name='memory.ratify' BEGIN SELECT RAISE(ABORT,'injected'); END");
 expect((await f.call('ratify',{id},'ratify-recovery')).status).toBe(503);expect(f.count()).toBe(0);expect(f.source.prepare('SELECT count(*) AS n FROM proposals').get()).toEqual({n:1});f.source.exec('DROP TRIGGER fail_ratify_source');
 f.db.$client.exec("CREATE TRIGGER fail_ratify_shared BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT,'injected'); END");expect((await f.call('ratify',{id},'ratify-recovery')).status).toBe(503);expect(f.count()).toBe(1);expect(f.source.prepare('SELECT count(*) AS n FROM proposals').get()).toEqual({n:0});
 const calls=embed.calls;f.db.$client.exec('DROP TRIGGER fail_ratify_shared');expect((await f.call('ratify',{id},'ratify-recovery')).status).toBe(200);expect(embed.calls).toBe(calls);expect(f.count()).toBe(1);expect((await f.call('remember',input,'ratify-recovery')).status).toBe(409);
});
it('refuses foreign draft IDs and rolls back ratification when the current body ends during embedding',async()=>{
 const f=await fixture(),id=(await f.call('propose',input,'revoked-proposal')).result.value.ids[0];
 for(const token of [raw.member,raw.runner])expect((await f.call('propose',input,'weaker-proposal-'+token[0],token)).status).toBe(403);
 expect((await f.call('ratify',{id:id.replace('art:','mark:')},'foreign-proposal')).status).toBe(403);expect((await f.call('ratify',{id},'member-proposal',raw.member)).status).toBe(403);
 expect((await f.call('propose',{...input,agent:'mark'},'select-proposal')).status).toBe(400);
 const gate=hold(),pending=f.call('ratify',{id},'ratify-ended');await gate.began;f.root.writes.run(()=>f.db.update(s.jobs).set({state:'done'}).where(eq(s.jobs.id,'job')).run());gate.release();expect([401,403]).toContain((await pending).status);expect(f.count()).toBe(0);expect(f.source.prepare('SELECT count(*) AS n FROM proposals').get()).toEqual({n:1});
});
it('archives, restores and forgets one own opaque ID with private notes, replay and a deletion record',async()=>{
 const f=await fixture(),made=await f.call('remember',input,'make-lifecycle'),id=made.result.value.ids[0],uuid=id.slice(4),note='PRIVATE_ARCHIVE_NOTE';
 for(const verb of ['archive','restore','forget']){
  expect((await f.call(verb,{id:id.replace('art:','mark:')},'foreign-'+verb)).status).toBe(403);
  expect((await f.call(verb,{id},'non-agent-'+verb,raw.member)).status).toBe(403);
  expect((await f.call(verb,{id,agent:'mark'},'select-'+verb)).status).toBe(400);
 }
 const archived=await f.call('archive',{id,note},'archive-one');expect(archived.status).toBe(200);expect(archived.result.value.ids).toEqual([id]);
 expect(f.source.prepare('SELECT archived,archive_note FROM memories WHERE uuid=?').get(uuid)).toEqual({archived:1,archive_note:JSON.stringify({note,archived_at:'2026-11-14T18:00:00.000Z'})});
 expect((await f.call('recall',{query:'alpha'},'absent')).result.value.ids).toEqual([]);expect(await f.call('archive',{id,note},'archive-one')).toEqual(archived);
 const restored=await f.call('restore',{id},'restore-one');expect(restored.status).toBe(200);expect(restored.result.value.ids).toEqual([id]);expect((await f.call('recall',{query:'alpha'},'present')).result.value.ids).toEqual([id]);
 expect(await f.call('restore',{id},'restore-one')).toEqual(restored);
 f.source.exec("CREATE TRIGGER fail_forget_source BEFORE INSERT ON memory_command_receipts WHEN NEW.name='memory.forget' BEGIN SELECT RAISE(ABORT,'injected'); END");
 expect((await f.call('forget',{id},'forget-one')).status).toBe(503);expect(f.count()).toBe(1);expect(f.source.prepare('SELECT * FROM memory_deletions').all()).toEqual([]);f.source.exec('DROP TRIGGER fail_forget_source');
 f.db.$client.exec("CREATE TRIGGER fail_forget_core BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT,'injected'); END");expect((await f.call('forget',{id},'forget-one')).status).toBe(503);expect(f.count()).toBe(0);
 f.db.$client.exec('DROP TRIGGER fail_forget_core');const forgotten=await f.call('forget',{id},'forget-one');expect(forgotten.status).toBe(200);expect(forgotten.result.value.ids).toEqual([id]);expect(await f.call('forget',{id},'forget-one')).toEqual(forgotten);
 expect(f.source.prepare('SELECT content,op FROM memory_deletions').all()).toEqual([{content:words,op:'forget'}]);expect((await f.call('restore',{id},'restore-forgotten')).status).toBe(404);
 for(const privateText of [words,title,note,f.path])expect(Buffer.from(f.db.$client.serialize()).includes(Buffer.from(privateText))).toBe(false);
});
it('consumes canonical Memory through the production body command and GraphQL client',async()=>{
 const f=await fixture(),client=bodyCommandClient({url:f.url,token:raw.body,signal:new AbortController().signal,clock:f.clock});clean.push(client.close);
 const catalog=await client.command('runtime.commandCatalog',{name:'memory.remember'},'consumer-catalog');expect(catalog).toMatchObject({ok:true,value:{commands:[{name:'memory.remember'}]}});
 const remembered=await client.command('memory.remember',input,'consumer-remember');expect(remembered.ok).toBe(true);if(!remembered.ok)throw Error('Missing consumer result');
 const {ids:[id]}=z.object({ids:z.array(z.string()).length(1)}).parse(remembered.value);expect(JSON.stringify(remembered)).not.toContain(words);
 expect(await client.query({query:'query($id:String!){memoryProjectMemory(id:$id){content title}}',variables:{id}})).toEqual({data:{memoryProjectMemory:{content:words,title}}});
 expect(await client.command('memory.recall',{query:'alpha'},'consumer-recall')).toMatchObject({ok:true,value:{ids:[id]}});
 for(const verb of ['archive','restore','forget'])expect(await client.command('memory.'+verb,{id},'consumer-'+verb)).toMatchObject({ok:true,value:{ids:[id]}});
 expect(await client.query({query:'query($id:String!){memoryProjectMemory(id:$id){content}}',variables:{id}})).toEqual({data:{memoryProjectMemory:null}});
 f.root.writes.run(()=>f.db.update(s.jobs).set({state:'done'}).where(eq(s.jobs.id,'job')).run());expect(await client.command('memory.remember',input,'consumer-remember')).toMatchObject({ok:false,code:'denied'});
});
it('reads private identity and hottest memories from declared sources through the production body client without writes or env fallback',async()=>{
 const f=await fixture(),directory=dirname(f.path),client=bodyCommandClient({url:f.url,token:raw.body,signal:new AbortController().signal,clock:f.clock});clean.push(client.close);
 writeFileSync(join(directory,'IDENTITY.md'),'PRIVATE_BODY_CREED');writeFileSync(join(directory,'preferences.md'),'PRIVATE_BODY_PREFERENCES');writeFileSync(join(directory,'self-model.md'),'PRIVATE_BODY_SELF_MODEL');writeFileSync(join(dirname(f.other),'IDENTITY.md'),'OTHER_BODY_CREED');
 expect((await f.call('remember',input,'context-memory')).status).toBe(200);expect((await f.call('remember',{...input,category:'episode',title:'Private recent episode',content:'PRIVATE_BODY_EPISODE'},'context-episode')).status).toBe(200);
 f.source.prepare('UPDATE memories SET created=?,authored_at=NULL,recall_heat=0 WHERE category=?').run('2026-07-01T00:00:00.000Z','project');
 const cool=await bodyMemoryIdentity(client,'art');expect(cool).toContain('## Background');expect(cool).toContain(title);
 // The page for the venue the body was started on comes with it: roles/wake.md is what every lane is told.
 mkdirSync(join(directory,'roles'),{recursive:true});writeFileSync(join(directory,'roles','wake.md'),'PRIVATE_LANE_RULES');
 const lane=await bodyMemoryIdentity(client,'art','wake');expect(lane).toContain('# Mode: wake\n\nPRIVATE_LANE_RULES');expect(lane!.indexOf('PRIVATE_LANE_RULES')).toBeGreaterThan(lane!.indexOf('PRIVATE_BODY_CREED'));
 expect(await bodyMemoryIdentity(client,'art','discord')).not.toContain('PRIVATE_LANE_RULES');expect(await bodyMemoryIdentity(client,'art')).not.toContain('Mode:');
 expect((await f.call('recall',{query:'alpha'},'context-recall')).status).toBe(200);const before=f.source.serialize();
 vi.stubEnv('LOOM_SQLITE_DB_PATH',f.other);vi.stubEnv('LOOM_TIMEZONE','Pacific/Honolulu');
 try{const identity=await bodyMemoryIdentity(client,'art');for(const value of ['PRIVATE_BODY_CREED','PRIVATE_BODY_PREFERENCES','PRIVATE_BODY_SELF_MODEL','PRIVATE_BODY_EPISODE',title,'18:00'])expect(identity).toContain(value);expect(identity).toContain('## Recent');expect(identity).not.toContain('OTHER_BODY_CREED');expect(await bodyMemoryIdentity(client,'mark')).toBeNull();}finally{vi.unstubAllEnvs();}
 expect(f.source.serialize()).toEqual(before);for(const value of ['PRIVATE_BODY_CREED','PRIVATE_BODY_PREFERENCES','PRIVATE_BODY_SELF_MODEL','PRIVATE_BODY_EPISODE',words])expect(Buffer.from(f.db.$client.serialize()).includes(Buffer.from(value))).toBe(false);
 const denied=await fetch(f.url+'/graphql',{method:'POST',headers:{authorization:'Bearer '+raw.runner,'content-type':'application/json'},body:JSON.stringify({query:bodyIdentityQuery,variables:{agent:'art'}})}),deniedBody=await denied.json();expect(deniedBody.errors?.length).toBeGreaterThan(0);expect(JSON.stringify(deniedBody)).not.toContain('PRIVATE_BODY_CREED');
 f.root.writes.run(()=>f.db.delete(s.memberAgents).where(eq(s.memberAgents.member,'alice')).run());expect((await f.query('{memoryIdentity(agent:"art"){creed}}',raw.member)).memoryIdentity).toBeNull();
});
it('excludes expired top-of-mind words and old or future episodes without changing precious sources',async()=>{
 const f=await fixture();expect((await f.call('remember',{...input,ttl:'1h'},'context-expiry')).status).toBe(200);
 expect((await f.call('remember',{...input,category:'episode',title:'Old episode',content:'OLD_EPISODE'},'context-old')).status).toBe(200);expect((await f.call('remember',{...input,category:'episode',title:'Future episode',content:'FUTURE_EPISODE'},'context-future')).status).toBe(200);
 f.source.prepare('UPDATE memories SET created=? WHERE title=?').run('2026-11-12T00:00:00.000Z','Old episode');f.source.prepare('UPDATE memories SET created=? WHERE title=?').run('2026-11-16T00:00:00.000Z','Future episode');
 vi.spyOn(f.clock,'now').mockReturnValue(f.clock.now()+3600000);const before=f.source.serialize(),result=await f.query('{memoryIdentity(agent:"art"){topOfMind recent}}');expect(result).toEqual({memoryIdentity:{topOfMind:null,recent:null}});expect(f.source.serialize()).toEqual(before);
});
it('refuses identity files escaping the declared agent directory without leaking words or paths',async()=>{
 const f=await fixture(),outside=join(f.home,'outside-identity.md');writeFileSync(outside,'ESCAPED_IDENTITY_WORDS');symlinkSync(outside,join(dirname(f.path),'IDENTITY.md'));
 const response=await fetch(f.url+'/graphql',{method:'POST',headers:{authorization:'Bearer '+raw.body,'content-type':'application/json'},body:JSON.stringify({query:bodyIdentityQuery,variables:{agent:'art'}})}),payload=await response.json();expect(payload.errors?.length).toBeGreaterThan(0);expect(JSON.stringify(payload)).not.toContain('ESCAPED_IDENTITY_WORDS');expect(JSON.stringify(payload)).not.toContain(outside);
});
it('does not publish top-of-mind words that expire during GraphQL serialization',async()=>{
 const f=await fixture(),creed='CONTEXT_BOUNDARY_CREED';writeFileSync(join(dirname(f.path),'IDENTITY.md'),creed);expect((await f.call('remember',input,'context-boundary')).status).toBe(200);
 f.source.prepare('UPDATE memories SET expires_at=?').run(new Date(f.clock.now()+1).toISOString());let crossed=false;const serialize=GraphQLString.serialize;
 vi.spyOn(GraphQLString,'serialize').mockImplementation(value=>{if(value===creed&&!crossed){crossed=true;f.clock.advance(1);}return serialize(value);});
 const response=await fetch(f.url+'/graphql',{method:'POST',headers:{authorization:'Bearer '+raw.body,'content-type':'application/json'},body:JSON.stringify({query:bodyIdentityQuery,variables:{agent:'art'}})}),payload=await response.json();expect(crossed).toBe(true);expect(JSON.stringify(payload)).not.toContain(words);expect(JSON.stringify(payload)).not.toContain(title);
});
it('loads private Memory into the receiving body before its model without copying it into job metadata or shared logs',async()=>{
 const f=await fixture(),creed='ACTUAL_RECEIVING_BODY_CREED';writeFileSync(join(dirname(f.path),'IDENTITY.md'),creed);expect((await f.call('remember',input,'receiving-memory')).status).toBe(200);
 const token='body_'+'e'.repeat(64);f.root.writes.run(()=>{f.db.delete(s.tokens).where(eq(s.tokens.job,'job')).run();f.db.insert(s.tokens).values({fingerprint:credentialHash(token),label:'Receiving Memory fixture',kind:'agent',agent:'art',job:'job',createdAt:new Date(f.clock.now()).toISOString()}).run();f.db.update(s.jobs).set({harness:'claude',model:'requested'}).where(eq(s.jobs.id,'job')).run();});
 expect((await f.send('Please do work','receiving-mail')).status).toBe(200);
 const job:WorkerAssignment={id:'job',agent:'art',box:'box',conversation:f.thread.conversation,thread:f.thread.id,venue:'loom',model:'requested',account:'fixture',harness:'claude',brief:'',house:{repository:'fixture',file:'HOUSE.md',branch:'next'}};
 const bytes=Buffer.from(JSON.stringify({job,build:'fixture',bootstrap:{origin:f.url,job:'job',token}})),native=vi.fn(async(assigned:WorkerAssignment,context:string)=>{expect(assigned).toEqual(job);expect(context).toContain(creed);expect(context).toContain(title);expect(context.indexOf(creed)).toBeLessThan(context.indexOf('Please do work'));expect(bytes.every(byte=>byte===0)).toBe(true);return{text:'Work completed',model:'observed',actions:[]};}),errors=vi.fn();
 expect(await bodyProgram({args:['fixture'],read:async()=>JSON.stringify({command:'/fake/native',cwd:'/fake/house'}),stdin:async()=>bytes,env:{},signal:new AbortController().signal,clock:f.clock,schedule:{every:()=>()=>{}},native,error:errors})).toBe(0);expect(native).toHaveBeenCalledOnce();expect(errors).not.toHaveBeenCalled();
 expect(f.db.select().from(s.jobs).get()?.brief).toBe('');for(const value of [creed,words,title,token])expect(Buffer.from(f.db.$client.serialize()).includes(Buffer.from(value))).toBe(false);
});
it('rolls back restore embedding after authority loss and rolls back archive on source receipt failure',async()=>{
 const f=await fixture(),id=(await f.call('remember',input,'make-rollback')).result.value.ids[0];
 f.source.exec("CREATE TRIGGER fail_archive_receipt BEFORE INSERT ON memory_command_receipts WHEN NEW.name='memory.archive' BEGIN SELECT RAISE(ABORT,'injected'); END");
 expect((await f.call('archive',{id},'archive-failure')).status).toBe(503);expect(f.source.prepare('SELECT archived FROM memories').get()).toEqual({archived:0});
 f.source.exec('DROP TRIGGER fail_archive_receipt');expect((await f.call('archive',{id},'archive-failure')).status).toBe(200);
 const gate=hold(),pending=f.call('restore',{id},'restore-revoked');await gate.began;
 f.root.writes.run(()=>f.db.update(s.jobs).set({state:'done'}).where(eq(s.jobs.id,'job')).run());gate.release();expect([401,403]).toContain((await pending).status);expect(f.source.prepare('SELECT archived FROM memories').get()).toEqual({archived:1});
 expect(f.source.prepare("SELECT id FROM memory_command_receipts WHERE id='restore-revoked'").all()).toEqual([]);
 embed.gate=undefined;f.root.writes.run(()=>f.db.update(s.jobs).set({state:'running'}).where(eq(s.jobs.id,'job')).run());expect((await f.call('restore',{id},'restore-revoked')).status).toBe(200);expect(f.source.prepare('SELECT archived FROM memories').get()).toEqual({archived:0});
});
it('rolls back a private write if receipt insertion fails, leaving a safe retry reservation',async()=>{
 const f=await fixture();f.source.exec("CREATE TRIGGER fail_memory_source BEFORE INSERT ON memory_command_receipts BEGIN SELECT RAISE(ABORT,'injected'); END");
 expect((await f.call('remember',input,'source-fail')).status).toBe(503);expect(f.count()).toBe(0);
 expect(f.source.prepare("SELECT name FROM sqlite_schema WHERE name IN ('memories','vec_memories')").all()).toEqual([]);
 expect(f.source.prepare('SELECT count(*) AS n FROM memory_command_preparations').get()).toEqual({n:1});expect(f.source.prepare('SELECT count(*) AS n FROM memory_command_receipts').get()).toEqual({n:0});
 f.source.exec('DROP TRIGGER fail_memory_source');expect((await f.call('remember',input,'source-fail')).status).toBe(200);expect(f.count()).toBe(1);
});
it('reserves a pending id globally and rolls back when current body authority ends during embedding',async()=>{
 const f=await fixture(),gate=hold(),pending=f.call('remember',input,'pending');await gate.began;
 let writes=0;f.root.operations.register({name:'fixture.write',write:true,input:z.object({}).strict(),output:z.null(),may:()=>true,run(){writes++;return null;}});
 const response=await fetch(f.url+'/api/fixture/write',{method:'POST',headers:{authorization:'Bearer '+raw.body,'content-type':'application/json'},body:JSON.stringify({input:{},id:'pending'})});expect(response.status).toBe(409);expect(writes).toBe(0);
 f.root.writes.run(()=>f.db.update(s.jobs).set({state:'done'}).where(eq(s.jobs.id,'job')).run());gate.release();expect([401,403]).toContain((await pending).status);expect(f.count()).toBe(0);
 expect(f.source.prepare("SELECT name FROM sqlite_schema WHERE name IN ('memories','vec_memories')").all()).toEqual([]);
 embed.gate=undefined;f.root.writes.run(()=>f.db.update(s.jobs).set({state:'running'}).where(eq(s.jobs.id,'job')).run());expect((await f.call('remember',input,'pending')).status).toBe(200);expect(f.count()).toBe(1);
});

it('keeps two current bodies in their own files even when their agents share a project',async()=>{
 const f=await fixture(),token='k'.repeat(64),at=new Date(f.clock.now()).toISOString();
 f.root.writes.run(()=>{f.db.insert(s.memberAgents).values({member:'bob',agent:'mark'}).run();f.db.insert(s.projectAgents).values({project:'pond',agent:'mark'}).run();});
 const thread=f.root.services.comms!.threads.open({member:'bob',agent:'mark',project:'pond',title:'Other private'});
 f.root.writes.run(()=>{
  f.db.insert(s.jobs).values({id:'other-job',agent:'mark',box:'box',member:'bob',project:'pond',conversation:thread.conversation,title:'Other body',state:'running',brief:'',model:'fixture',startedByKind:'member',startedBy:'bob',houseRepository:'fixture',houseFile:'HOUSE.md',houseBranch:'next',queuedAt:at}).run();
  f.db.insert(s.tokens).values({fingerprint:credentialHash(token),label:'Other body',kind:'agent',agent:'mark',job:'other-job',createdAt:at}).run();
 });
 const own=await f.call('remember',input,'own'),other=await f.call('remember',{...input,content:'beta OTHER_PRIVATE_MEMORY'},'own',token);expect(own.status).toBe(200);expect(other.status).toBe(200);
 const id=other.result.value.ids[0];expect(id).toMatch(/^mark:/);expect(await f.query(`{memoryProjectMemory(id:"${id}"){content}}`,token)).toEqual({memoryProjectMemory:{content:'beta OTHER_PRIVATE_MEMORY'}});
 expect(await f.query(`{memoryProjectMemory(id:"${id}"){content}}`)).toEqual({memoryProjectMemory:null});expect(await f.query(`{memoryProjectMemory(id:"${id}"){content}}`,raw.member)).toEqual({memoryProjectMemory:null});
 expect((await f.call('recall',{query:'alpha',limit:50},'lookup')).result.value.ids).toEqual(own.result.value.ids);
});
it('keeps the original retry deadline after recovery and leaves existing unprepared metadata untouched',async()=>{
 const f=await fixture(),start=f.clock.now();f.db.$client.exec("CREATE TRIGGER fail_memory_core BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT,'injected'); END");
 expect((await f.call('remember',input,'expiry')).status).toBe(503);
 const deadline=(f.source.prepare('SELECT expires FROM memory_command_receipts').get() as {expires:number}).expires;expect(deadline).toBe(start+30*86400000);
 f.db.$client.exec('DROP TRIGGER fail_memory_core');vi.spyOn(f.clock,'now').mockReturnValue(start+29*86400000);
 expect((await f.call('remember',input,'expiry')).status).toBe(200);expect(f.db.select().from(s.operationResults).all()[0].expiresAt).toBe(new Date(deadline).toISOString());
 expect(f.source.prepare('SELECT expires FROM memory_command_receipts').get()).toEqual({expires:deadline});
 f.source.exec('DROP TABLE memory_command_schema');const before=f.source.serialize();
 expect((await f.call('remember',input,'unprepared')).status).toBe(503);expect(f.source.serialize()).toEqual(before);
});

it('closes an acquired native connection if extension setup fails and closes execution failures after rollback',async()=>{
 const f=await fixture(),before=new Set(owned.connections);owned.failLoad=true;
 expect((await f.call('remember',input,'constructor')).status).toBe(503);owned.failLoad=false;
 const constructor=owned.connections.filter(db=>!before.has(db)&&db.name===f.path);expect(constructor.length).toBeGreaterThan(0);expect(constructor.every(db=>!db.open)).toBe(true);expect(f.count()).toBe(0);
 const opened=new Set(owned.connections);embed.gate=async()=>{throw Error('injected asynchronous embedding failure');};
 expect((await f.call('remember',input,'async-failure')).status).toBe(503);embed.gate=undefined;
 const execution=owned.connections.filter(db=>!opened.has(db)&&db.name===f.path);expect(execution.length).toBeGreaterThan(0);expect(execution.every(db=>!db.open)).toBe(true);expect(f.count()).toBe(0);
 expect(f.source.prepare("SELECT name FROM sqlite_schema WHERE name IN ('memories','vec_memories')").all()).toEqual([]);
 const deadline=(f.source.prepare('SELECT expires FROM memory_command_preparations WHERE id=?').get('async-failure') as {expires:number}).expires;
 vi.spyOn(f.clock,'now').mockReturnValue(f.clock.now()+29*86400000);
 expect((await f.call('remember',input,'async-failure')).status).toBe(200);
 expect(f.source.prepare('SELECT expires FROM memory_command_receipts WHERE id=?').get('async-failure')).toEqual({expires:deadline});expect(f.db.select().from(s.operationResults).all().find(row=>row.id==='async-failure')?.expiresAt).toBe(new Date(deadline).toISOString());
});
it('drains an active command on shutdown, rolls back its source and releases command and reader connections',async()=>{
 const f=await fixture(),before=new Set(owned.connections),readers=owned.connections.filter(db=>db.name===f.path&&db.readonly&&db.open),gate=hold(),pending=f.call('remember',input,'shutdown');await gate.began;
 const active=owned.connections.filter(db=>!before.has(db)&&db.name===f.path&&db.open);expect(active).toHaveLength(1);expect(readers.length).toBeGreaterThan(0);
 const closing=f.root.close();gate.release();expect([401,403,503]).toContain((await pending).status);await closing;
 expect(active.every(db=>!db.open)).toBe(true);expect(readers.every(db=>!db.open)).toBe(true);expect(f.count()).toBe(0);
 expect(f.source.prepare("SELECT name FROM sqlite_schema WHERE name IN ('memories','vec_memories')").all()).toEqual([]);
});
it('lets a no-job agent credential read and write shared Knowledge through the real HTTP door',async()=>{
 const f=await fixture();
 expect(f.db.select().from(s.tokens).all().find(row=>row.fingerprint===credentialHash(raw.agent))?.job).toBeNull();
 const input={title:'Terminal knowledge',domain:'household',body:'A shared fact from a terminal.',source:''};
 const response=await fetch(f.url+'/api/mind/knowledgeAdd',{method:'POST',headers:{authorization:'Bearer '+raw.agent,'content-type':'application/json'},body:JSON.stringify({id:'terminal-knowledge',input})});
 expect(response.status).toBe(200);expect(await response.json()).toMatchObject({ok:true,value:{slug:'terminal-knowledge'}});
 const selection='{memoryKnowledgeAccess{allowed canAdd canVerify canRecheck} memoryKnowledgePage(slug:"terminal-knowledge"){body}}';
 expect(await f.query(selection,raw.agent)).toMatchObject({memoryKnowledgeAccess:{allowed:true,canAdd:true,canVerify:true,canRecheck:true},memoryKnowledgePage:{body:input.body}});
 expect(await f.query(selection,raw.member)).toMatchObject({memoryKnowledgeAccess:{allowed:false,canAdd:false,canVerify:false,canRecheck:false},memoryKnowledgePage:null});
 const denied=await fetch(f.url+'/api/mind/knowledgeAdd',{method:'POST',headers:{authorization:'Bearer '+raw.member,'content-type':'application/json'},body:JSON.stringify({id:'member-knowledge',input:{...input,title:'Forbidden member fact'}})});
 expect(denied.status).toBe(403);
});
it('lists live memories newest first by category and project with sourcing, forgettable IDs and no recall heat',async()=>{
 const f=await fixture(),ids:string[]=[];
 for(const [i,category,project] of [[0,'project','pond'],[1,'project','pond'],[2,'user','pond'],[3,'project','other'],[4,'project','pond'],[5,'project','pond']] as const){
  vi.setSystemTime(Date.parse('2026-11-14T18:00:00Z')+i*60000);
  const made=await f.call('remember',{category,project,title:'Listed '+i,content:'alpha listed '+i,...(i===1?{sourcing:'relayed',provenance:'PRIVATE_PROVENANCE, fictional lane'}:{}),...(i===5?{ttl:'1h'}:{})},'list-'+i);expect(made.status).toBe(200);ids.push(made.result.value.ids[0]);
 }
 expect(f.source.prepare('SELECT sourcing,provenance FROM memories WHERE uuid=?').get(ids[1].slice(4))).toEqual({sourcing:'relayed',provenance:'PRIVATE_PROVENANCE, fictional lane'});
 expect((await f.call('remember',{...input,title:'Bad sourcing',sourcing:'guessed'},'bad-sourcing')).status).toBe(400);expect((await f.call('remember',{...input,title:'Long provenance',provenance:'p'.repeat(2001)},'long-provenance')).status).toBe(400);
 // A draft has nowhere to keep them, so it refuses rather than drops them.
 expect((await f.call('propose',{...input,sourcing:'relayed'},'propose-sourcing')).status).toBe(400);expect(f.count()).toBe(6);
 expect((await f.call('archive',{id:ids[4]},'list-archive')).status).toBe(200);
 const later=Date.parse('2026-11-14T20:30:00Z');vi.setSystemTime(later);vi.spyOn(f.clock,'now').mockReturnValue(later);const before=f.source.serialize();
 const all=(await f.query('{memoryList(agent:"art"){id title category project created updated sourcing}}')).memoryList as Array<{id:string;title:string;category:string;project:string;created:string;updated:string;sourcing:string|null}>;
 expect(all.map(row=>row.id)).toEqual([ids[3],ids[2],ids[1],ids[0]]);expect(all[2]).toMatchObject({title:'Listed 1',category:'project',project:'pond',created:'2026-11-14T18:01:00.000Z',updated:'2026-11-14T18:01:00.000Z',sourcing:'relayed'});
 expect((await f.query('{memoryList(agent:"art",category:"project"){id}}')).memoryList).toEqual([{id:ids[3]},{id:ids[1]},{id:ids[0]}]);
 expect((await f.query('{memoryList(agent:"art",project:"pond"){id}}')).memoryList).toEqual([{id:ids[2]},{id:ids[1]},{id:ids[0]}]);
 expect((await f.query('{memoryList(agent:"art",category:"project",project:"pond",first:1){id}}')).memoryList).toEqual([{id:ids[1]}]);
 expect((await f.query('{memoryList(agent:"art",category:"reference"){id}}')).memoryList).toEqual([]);
 for(const args of ['first:0','first:501','category:""']){const response=await fetch(f.url+'/graphql',{method:'POST',headers:{authorization:'Bearer '+raw.body,'content-type':'application/json'},body:JSON.stringify({query:`{memoryList(agent:"art",${args}){id}}`})});expect((await response.json()).errors?.[0].message).toBe('Memory list selection is invalid');}
 expect(f.source.serialize()).toEqual(before);expect(f.source.prepare('SELECT sum(recall_heat) AS heat FROM memories').get()).toEqual({heat:0});
 // Only a caller who may see this agent's Memory lists it.
 expect((await f.query('{memoryList(agent:"art"){id}}',raw.member)).memoryList).toHaveLength(4);
 expect(await f.query('{memoryList(agent:"mark"){id}}')).toEqual({memoryList:null});expect(await f.query('{memoryList(agent:"nobody"){id}}')).toEqual({memoryList:null});
 f.root.writes.run(()=>f.db.delete(s.memberAgents).where(eq(s.memberAgents.member,'alice')).run());expect(await f.query('{memoryList(agent:"art"){id title}}',raw.member)).toEqual({memoryList:null});
 // Nor does the body working for her: it reaches what is the agent's only while she has the agent.
 expect(await f.query('{memoryList(agent:"art"){id}}')).toEqual({memoryList:null});
 // And it changes none of it either: the commands answer a body by the same rule as the read.
 expect((await f.call('forget',{id:all[0].id},'lost-forget')).status).toBe(403);expect((await f.call('remember',{...input,title:'After she lost the agent'},'lost-remember')).status).toBe(403);
 f.root.writes.run(()=>f.db.insert(s.memberAgents).values({member:'alice',agent:'art'}).run());
 const forgotten=await f.call('forget',{id:all[0].id},'list-forget');expect(forgotten.status).toBe(200);expect(forgotten.result.value.ids).toEqual([ids[3]]);
 expect((await f.query('{memoryList(agent:"art"){id}}')).memoryList).toEqual([{id:ids[2]},{id:ids[1]},{id:ids[0]}]);
 for(const value of ['PRIVATE_PROVENANCE','Listed 1',f.path])expect(Buffer.from(f.db.$client.serialize()).includes(Buffer.from(value))).toBe(false);
});
it('checks a Knowledge page without changing its words unless a note is given, and keeps its freshness anchor',async()=>{
 const f=await fixture(),knowledge=new Database(f.memory.sources.commons.knowledge,{readonly:true,fileMustExist:true});clean.push(()=>{knowledge.close();});
 const mind=async(verb:string,value:unknown,id:string,token=raw.agent)=>{const response=await fetch(f.url+'/api/mind/'+verb,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({id,input:value})});return {status:response.status,result:await response.json()};};
 const page={title:'Fictional pump',domain:'household',body:'Fictional pump words.',source:''};
 expect((await mind('knowledgeAdd',{...page,freshnessAnchor:'  Pump OS 1.21  '},'add-anchored')).status).toBe(200);expect((await mind('knowledgeAdd',{...page,title:'Plain fact'},'add-plain')).status).toBe(200);
 expect((await mind('knowledgeAdd',{...page,title:'Blank anchor',freshnessAnchor:'   '},'add-blank')).status).toBe(400);
 const fields='slug freshness_anchor sla_class';
 expect(await f.query(`{memoryKnowledgePage(slug:"fictional-pump"){${fields}} plain:memoryKnowledgePage(slug:"plain-fact"){${fields}} memoryKnowledge{pages{${fields}}} memoryKnowledgeSearch(query:"pump words"){${fields}}}`,raw.agent)).toEqual({
  memoryKnowledgePage:{slug:'fictional-pump',freshness_anchor:'Pump OS 1.21',sla_class:'software'},plain:{slug:'plain-fact',freshness_anchor:null,sla_class:'default'},
  memoryKnowledge:{pages:expect.arrayContaining([{slug:'fictional-pump',freshness_anchor:'Pump OS 1.21',sla_class:'software'},{slug:'plain-fact',freshness_anchor:null,sla_class:'default'}])},
  memoryKnowledgeSearch:expect.arrayContaining([{slug:'fictional-pump',freshness_anchor:'Pump OS 1.21',sla_class:'software'},{slug:'plain-fact',freshness_anchor:null,sla_class:'default'}])});
 const state=()=>knowledge.prepare(`SELECT p.body,p.updated,p.verified_at,p.freshness_anchor,p.sla_class,(SELECT count(*) FROM page_revisions r WHERE r.page_id=p.id) AS revisions,(SELECT count(*) FROM verifications v WHERE v.page_id=p.id) AS checks FROM pages p WHERE p.slug='plain-fact'`).get() as {body:string;updated:string;verified_at:string;freshness_anchor:string|null;sla_class:string;revisions:number;checks:number};
 const made=state();expect(made).toMatchObject({body:page.body,revisions:0,checks:0,freshness_anchor:null});
 const move=(at:string)=>{const now=Date.parse(at);vi.setSystemTime(now);vi.spyOn(f.clock,'now').mockReturnValue(now);};
 // No note: a pure stamp. The words, their date and their kept versions stay.
 move('2026-11-15T18:00:00Z');const stamped=await mind('knowledgeVerify',{slug:'plain-fact'},'verify-plain');expect(stamped.status).toBe(200);expect(stamped.result.value).toMatchObject({slugs:['plain-fact'],stamped:true,noted:false});
 expect(state()).toEqual({...made,verified_at:'2026-11-15T18:00:00.000Z',checks:1});expect(knowledge.prepare('SELECT verifier,outcome FROM verifications').all()).toEqual([{verifier:expect.any(String),outcome:'confirmed'}]);
 // Asking for another check records it without renewing the stamp or touching the words.
 move('2026-11-16T18:00:00Z');expect((await mind('knowledgeRecheck',{slug:'plain-fact'},'recheck-plain')).result.value).toMatchObject({stamped:false,noted:false});
 expect(state()).toEqual({...made,verified_at:'2026-11-15T18:00:00.000Z',checks:2});expect((await f.query('{memoryKnowledgePage(slug:"plain-fact"){checked{outcome}}}',raw.agent)).memoryKnowledgePage).toEqual({checked:{outcome:'stale'}});
 // An anchor alone is still no change to the words; it moves the class.
 move('2026-11-17T18:00:00Z');expect((await mind('knowledgeVerify',{slug:'plain-fact',freshnessAnchor:' as of v2.0 '},'verify-anchor')).status).toBe(200);
 expect(state()).toEqual({...made,verified_at:'2026-11-17T18:00:00.000Z',freshness_anchor:'as of v2.0',sla_class:'software',checks:3});
 expect((await f.query(`{memoryKnowledgePage(slug:"plain-fact"){${fields} verified_at}}`,raw.agent)).memoryKnowledgePage).toEqual({slug:'plain-fact',freshness_anchor:'as of v2.0',sla_class:'software',verified_at:'2026-11-17T18:00:00.000Z'});
 // A note is asked for: it is appended, dated, and the prior words are kept as a version.
 move('2026-11-18T18:00:00Z');const noted=await mind('knowledgeVerify',{slug:'plain-fact',note:'  Checked against the fictional manual.  '},'verify-note');expect(noted.result.value).toMatchObject({noted:true});
 expect(state()).toEqual({body:page.body+'\n\n## Verification — 2026-11-18\n\nChecked against the fictional manual.',updated:'2026-11-18T18:00:00.000Z',verified_at:'2026-11-18T18:00:00.000Z',freshness_anchor:'as of v2.0',sla_class:'software',revisions:1,checks:4});
 for(const bad of [{note:'   '},{note:'n'.repeat(4001)},{freshnessAnchor:'a'.repeat(201)}])expect((await mind('knowledgeVerify',{slug:'plain-fact',...bad},'verify-bad-'+Object.keys(bad)[0]+String(Object.values(bad)[0]).length)).status).toBe(400);
 expect(state().checks).toBe(4);
});
it('answers a recall on a fresh home with nothing, before any memory has been written',async()=>{
 const f=await fixture();expect(f.source.prepare("SELECT 1 FROM sqlite_schema WHERE name IN ('memories','vec_memories')").get()).toBeUndefined();
 const before=f.source.serialize(),recall=await f.call('recall',{query:'alpha'},'fresh-recall');
 expect(recall.status).toBe(200);expect(recall.result.value).toEqual({ids:[],matches:[]});
 // Reading made nothing: the tables still arrive with the first write, in its transaction.
 expect(f.source.serialize()).toEqual(before);
 const remembered=await f.call('remember',input,'fresh-remember');expect(remembered.status).toBe(200);
 expect((await f.call('recall',{query:'alpha'},'fresh-recall-again')).result.value).toMatchObject({ids:remembered.result.value.ids});
});
/** Puts the fixture's job on anybody else's word: in a shared room, holding one message from a member who does not have the agent. */
function heldBody(f:Awaited<ReturnType<typeof fixture>>){
 const conversation=f.thread.conversation,token='body_'+'e'.repeat(64);
 f.root.writes.run(()=>{
  f.db.delete(s.threads).where(eq(s.threads.id,f.thread.id)).run();
  f.db.update(s.conversations).set({venue:'slack',member:null,project:null,place:JSON.stringify(['T','C',null])}).where(eq(s.conversations.id,conversation)).run();
  f.db.update(s.jobs).set({member:null,project:null}).where(eq(s.jobs.id,'job')).run();
  const old=f.db.select().from(s.tokens).where(eq(s.tokens.fingerprint,credentialHash(raw.body))).get()!;
  f.db.delete(s.tokens).where(eq(s.tokens.fingerprint,old.fingerprint)).run();
  f.db.insert(s.tokens).values({...old,fingerprint:credentialHash(token),label:'Held body'}).run();
  const mail=f.root.services.conversations.send({conversation,toKind:'agent',to:'art',source:'notice',fromKind:'person',fromId:'bob',words:'Remember this for me'});
  f.db.update(s.inbox).set({job:'job',state:'taken'}).where(eq(s.inbox.id,mail.id)).run();
 });
 return {token,conversation};
}
it('lets a body on anybody else\'s word add a memory and a new note, each stamped by loom with whose word it was, and change nothing else the agent or the household keeps',async()=>{
 const f=await fixture();
 const api=async(piece:string,verb:string,value:unknown,id:string,token:string=raw.body)=>{const response=await fetch(f.url+'/api/'+piece+'/'+verb,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({input:value,id})});return {status:response.status,result:await response.json()};};
 // What the agent keeps, written on its owners' word: a memory, a draft, a person card, a note and a knowledge page.
 const mine=(await f.call('remember',input,'own-memory')).result.value.ids[0] as string;
 const draft=(await f.call('propose',{category:'project',title:'Draft',content:'beta draft words'},'own-draft')).result.value.ids[0] as string;
 expect((await f.call('personWrite',{slug:'sam',name:'Sam'},'own-person')).status).toBe(200);
 expect((await api('memory','noteWrite',{path:'plans/pond',body:'The owner\'s plan',lifespan:'keep'},'own-note')).status).toBe(200);
 const page=await api('mind','knowledgeAdd',{title:'Pond pumps',domain:'pond',body:'Pumps run at night.'},'own-page');expect(page.status).toBe(200);const slug=page.result.value.slug as string;
 const kept=()=>JSON.stringify([f.source.prepare('SELECT uuid,title,content,metadata,archived FROM memories ORDER BY id').all(),f.source.prepare('SELECT count(*) AS n FROM proposals').get()]);
 const before=kept(),{token,conversation}=heldBody(f);
 const line=`[From loom: written while working for the member bob in conversation ${conversation}, who is not one of art's owners.]`;
 // It adds a memory. loom writes whose word it was: first in its words, where every reader meets it, and in its
 // record, where the body's own claim of the same name is thrown away.
 const added=await f.call('remember',{category:'project',title:'Door code',content:'gamma the door code is 1234',metadata:{written_on_word:{who:'the member alice'},colour:'green'},provenance:'Alice said so',sourcing:'observed'},'held-memory',token);
 expect(added.status).toBe(200);
 const row=f.source.prepare('SELECT content,metadata,provenance,sourcing FROM memories WHERE title=?').get('Door code') as {content:string;metadata:string;provenance:string;sourcing:string};
 expect(row.content).toBe(line+'\n\ngamma the door code is 1234');
 expect(JSON.parse(row.metadata)).toEqual({colour:'green',written_on_word:{who:'the member bob',conversation}});
 expect(row).toMatchObject({provenance:line,sourcing:'relayed'});
 // Everything else that changes, removes or brings back what the agent keeps is refused, in words.
 const refused=async(verb:string,value:unknown)=>expect(await f.call(verb,value,'held-'+verb,token),verb).toMatchObject({status:403,result:{message:HELD_REFUSALS.memory}});
 await refused('update',{id:mine,content:'delta rewritten by a guest'});await refused('archive',{id:mine});await refused('restore',{id:mine});await refused('forget',{id:mine});
 await refused('restoreRevision',{id:mine,revision_id:1});await refused('propose',{category:'project',title:'Another',content:'alpha another'});await refused('ratify',{id:draft});
 await refused('personWrite',{slug:'sam',name:'Samuel'});await refused('personRestoreRevision',{slug:'sam',revision_id:1});await refused('projectWrite',{slug:'pond',name:'Drained pond'});
 // Its own addition is one more row; the rest is as it was.
 expect(f.count()).toBe(2);expect(JSON.stringify([f.source.prepare('SELECT uuid,title,content,metadata,archived FROM memories WHERE title<>? ORDER BY id').all('Door code'),f.source.prepare('SELECT count(*) AS n FROM proposals').get()])).toBe(before);
 // A note: a new path only, and who it was written for is in the note's own record, which the body does not write.
 expect((await api('memory','noteWrite',{path:'guests/door',body:'The code is 1234',lifespan:'short'},'held-note',token)).status).toBe(200);
 const note=(path:string)=>new Database(join(f.home,'agents/art/notes.db'),{readonly:true}).prepare('SELECT body,by FROM notes WHERE path=?').get(path) as {body:string;by:string};
 expect(note('guests/door')).toEqual({body:'The code is 1234',by:`art, working for the member bob in conversation ${conversation}, who is not one of art's owners`});
 for(const [path,id] of [['plans/pond','held-over'],['guests/door','held-again']])expect(await api('memory','noteWrite',{path,body:'Overwritten',lifespan:'keep'},id,token),path).toMatchObject({status:403,result:{message:HELD_REFUSALS.note}});
 expect(note('plans/pond')).toEqual({body:'The owner\'s plan',by:'art'});expect(note('guests/door').body).toBe('The code is 1234');
 // The household's knowledge and people: nothing.
 for(const [verb,value] of [['knowledgeAdd',{title:'Door',domain:'house',body:'The code is 1234.'}],['knowledgeEdit',{slug,body:'Pumps never run.'}],['knowledgeVerify',{slug}],['knowledgeRecheck',{slug}],['knowledgeRestore',{slug,revision:1}]] as const)
  expect(await api('mind',verb,value,'held-'+verb,token),verb).toMatchObject({status:403,result:{message:HELD_REFUSALS.knowledge}});
 // Adding a person is refused too. Here the people rule already refuses this agent's body before loom's line is reached.
 expect((await api('mind','personAdd',{name:'Mallory'},'held-person',token)).status).toBe(403);
});
it('lets no body set or clear loom\'s stamp of whose word a memory was written on, a body on owners\' word included',async()=>{
 const f=await fixture(),meta=(title:string)=>JSON.parse((f.source.prepare('SELECT metadata FROM memories WHERE title=?').get(title) as {metadata:string}).metadata);
 // A body on its owners' word claims the stamp for a memory of its own: the claim is thrown away, the rest is kept.
 const forged=await f.call('remember',{category:'project',title:'Forged',content:'alpha forged words',metadata:{written_on_word:{who:'the member bob',conversation:'cv-elsewhere'},colour:'green'}},'forged');
 expect(forged.status).toBe(200);expect(meta('Forged')).toEqual({colour:'green'});
 // Nor does an edit set it.
 expect((await f.call('update',{id:forged.result.value.ids[0],metadata:{written_on_word:{who:'somebody'},colour:'blue'}},'forge-update')).status).toBe(200);expect(meta('Forged')).toEqual({colour:'blue'});
 // A memory loom stamped keeps its stamp through an edit that tries to clear or replace it.
 const stamp={who:'the member bob',conversation:f.thread.conversation};
 f.source.close();const write=new Database(f.path);write.prepare('UPDATE memories SET metadata=? WHERE title=?').run(JSON.stringify({written_on_word:stamp}),'Forged');write.close();
 const read=()=>{const db=new Database(f.path,{readonly:true});try{return JSON.parse((db.prepare('SELECT metadata FROM memories WHERE title=?').get('Forged') as {metadata:string}).metadata);}finally{db.close();}};
 for(const [id,claim] of [['clear',null],['replace',{who:'the member alice'}]] as const)expect((await f.call('update',{id:forged.result.value.ids[0],metadata:{written_on_word:claim,colour:id}},'stamp-'+id)).status).toBe(200);
 expect(read()).toEqual({written_on_word:stamp,colour:'replace'});
});
