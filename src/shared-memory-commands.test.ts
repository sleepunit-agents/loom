/** Native command authority, source receipts and the actual shared HTTP/socket door. */
import {afterEach,expect,it,vi} from 'vitest';
import Database,{type Database as Connection} from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {getRequestListener} from '@hono/node-server';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {eq} from 'drizzle-orm';
import {z} from 'zod';
import {bodyCommandClient} from './runtime/body-command-client.js';
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
  for(const [index,token] of [raw.agent,raw.member,raw.runner].entries())expect((await f.call(verb,value,'card-weak-'+verb+'-'+index,token)).status).toBe(403);
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
 const priorHeat=heat(),before=embed.calls;expect(await f.call('recall',{query:'alpha',limit:1},'recall')).toEqual(recall);expect(embed.calls).toBe(before);expect(heat()).toEqual(priorHeat);
 for(const token of [raw.agent,raw.member,raw.runner])expect((await f.call('remember',input,'wrong-'+token[0],token)).status).toBe(403);
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
 expect(f.source.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'memory_command_%'").all()).toEqual([]);
});
it('recovers recall after shared receipt failure without adding heat again',async()=>{
 const f=await fixture();expect((await f.call('remember',input,'initial')).status).toBe(200);
 f.db.$client.exec("CREATE TRIGGER fail_recall_core BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT,'injected'); END");expect((await f.call('recall',{query:'alpha'},'recover-recall')).status).toBe(503);
 const heat=()=>f.source.prepare('SELECT recall_heat,recall_heat_at,last_accessed FROM memories').all(),before=heat(),calls=embed.calls;expect(before).toEqual([expect.objectContaining({recall_heat:expect.any(Number)})]);
 f.db.$client.exec('DROP TRIGGER fail_recall_core');expect((await f.call('recall',{query:'alpha'},'recover-recall')).status).toBe(200);expect(heat()).toEqual(before);expect(embed.calls).toBe(calls);
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
it('archives, restores and forgets one own opaque ID with private notes, replay and a deletion record',async()=>{
 const f=await fixture(),made=await f.call('remember',input,'make-lifecycle'),id=made.result.value.ids[0],uuid=id.slice(4),note='PRIVATE_ARCHIVE_NOTE';
 for(const verb of ['archive','restore','forget']){
  expect((await f.call(verb,{id:id.replace('art:','mark:')},'foreign-'+verb)).status).toBe(403);
  expect((await f.call(verb,{id},'non-body-'+verb,raw.agent)).status).toBe(403);
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
  f.db.update(s.conversations).set({job:'other-job'}).where(eq(s.conversations.id,thread.conversation)).run();
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
