/** Real CLI/default listener, with only fictional prepared stores and keys. */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import {generateX25519Identity} from 'age-encryption';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,chmodSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {WebSocket} from 'ws';
import {createServer} from 'node:http';
import {createDataSchema,dataSchemaNumber} from './core/data/database.js';
import {members,agents,memberAgents,household} from './core/data/schema.js';
import {requestLocalLink} from './core/signin/operator.js';
import {FakeClock} from './core/clock.js';
import {startSharedHome} from './shared-startup.js';
import * as startup from './shared-startup.js';
import {serve as run,signin} from './index.js';
import {SqliteKnowledgeBackend} from './backends/sqlite-knowledge.js';
import {PeopleStore} from './backends/people.js';
import {ProjectsStore} from './backends/projects.js';
const cleanups:Array<()=>unknown|Promise<unknown>>=[];
beforeEach(()=>{vi.stubEnv('LOOM_WORKER_SOCKET',undefined);vi.stubEnv('LOOM_PUBLIC_URL',undefined);});
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();vi.unstubAllEnvs();});
async function fixture(){
 const home=mkdtempSync(join(tmpdir(),'loom-default-fiction-'));cleanups.push(()=>rmSync(home,{recursive:true,force:true}));
 const database=join(home,'app.db'),client=new Database(database),db=createDataSchema(client);
 const at='2026-11-15T12:00:00.000Z';
 db.insert(members).values([{id:'owner',role:'owner',joinedAt:at},{id:'peer',role:'member',joinedAt:at}]).run();
 db.insert(agents).values({id:'fiction',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();
 db.insert(memberAgents).values({member:'owner',agent:'fiction'}).run();
 db.insert(household).values({defaultAgent:'fiction',timezone:'Asia/Tokyo'}).run();client.close();
 const webRoot=join(home,'public');mkdirSync(webRoot);writeFileSync(join(webRoot,'next.html'),'<main>SHARED FICTIONAL ENTRY</main>');
 const commsKey=join(home,'comms.key');writeFileSync(commsKey,await generateX25519Identity(),{mode:0o600});
 const common=join(home,'commons'),agent=join(home,'agents/fiction');
 const program={database,commsKey,signinMember:'owner',webRoot,memory:{checkingAgent:'fiction',sources:{commons:{directory:common,knowledge:join(common,'knowledge.db'),people:join(common,'people.db')},agents:[{agent:'fiction',directory:agent,memories:join(agent,'memories.db')}]}}};
 const config=join(home,'program.json');writeFileSync(config,JSON.stringify(program),{mode:0o600});
 return {home,config,program};
}
async function signedIn(home:string,url:string,member='owner'){
 const link=await requestLocalLink(home,{request:'link',member,label:'Fictional local sign-in',ttl:30});expect(link.url).toBe(url);
 const response=await fetch(url+link.path,{method:'POST',redirect:'manual',headers:{origin:url,'user-agent':'Fictional browser'}});
 expect(response.status).toBe(303);return response.headers.get('set-cookie')!.split(';',1)[0];
}
it('normal serve --http installs public assets, current sign-in, Memory, Comms and Tempo on the same real door',async()=>{
 const f=await fixture(),errors:string[]=[],printed:string[]=[];let ready!:(url:string)=>void;
 symlinkSync(f.program.commsKey,join(f.program.webRoot,'key.js'));
 const started=new Promise<string>(resolve=>{ready=resolve;});
 const pending=run(['--http','--home',f.home,'--host','127.0.0.1','--port','0'],{stdin:Readable.from([]),stdinIsTTY:false,env:{},stdout:text=>printed.push(text),stderr:text=>{errors.push(text);const match=/shared app on (\S+)/.exec(text);if(match)ready(match[1]);}});
 cleanups.push(async()=>{process.emit('SIGTERM');expect(await pending).toBe(0);});
 const url=await Promise.race([started,pending.then(code=>{throw Error(`CLI stopped (${code}): ${errors.join('')}`);})]);
 expect(await (await fetch(url+'/p/knowledge-preview')).text()).toBe('<main>SHARED FICTIONAL ENTRY</main>');
 expect(await (await fetch(url+'/auth/session')).json()).toEqual({viewer:null});
 expect((await fetch(url+'/app/key.js')).status).toBe(404);
 // Startup says how to sign in and prints no credential; the operator's command gets the link.
 expect(printed).toEqual([`To sign in from this machine: loom signin --home ${f.home}\n`]);
 const asked:string[]=[];expect(await signin(['--home',f.home],{stdout:text=>asked.push(text),stderr:()=>{}})).toBe(0);
 expect(asked).toHaveLength(1);expect(asked[0]).toMatch(new RegExp('^'+url+'/login/[0-9a-f]{64}\n$'));
 const pushKey=JSON.parse(readFileSync(join(f.home,'push-vapid.json'),'utf8'));expect(pushKey.publicKey).toEqual(expect.any(String));expect(pushKey.privateKey).toEqual(expect.any(String));
 const bootstrap=await fetch(asked[0].trim(),{method:'POST',redirect:'manual',headers:{origin:url}});expect(bootstrap.status).toBe(303);
 const cookie=bootstrap.headers.get('set-cookie')!.split(';',1)[0];
 expect(await (await fetch(url+'/auth/session',{headers:{cookie}})).json()).toMatchObject({viewer:{kind:'member',id:'owner'}});
 const query=async(cookie:string)=>{const response=await fetch(url+'/graphql',{method:'POST',headers:{cookie,origin:url,'content-type':'application/json'},body:JSON.stringify({query:'{ deskTime { timezone } homeComms { agents } memoryKnowledge { pages { title } } memoryPeople { id } memoryProjects { id } memoryActivity { entries { title } } triggers { id } }'})});expect(response.status).toBe(200);const result=await response.json();expect(result.errors).toBeUndefined();return result.data;};
 expect(await query(cookie)).toMatchObject({deskTime:{timezone:'Asia/Tokyo'},homeComms:{agents:['fiction']},memoryKnowledge:{pages:[]},memoryPeople:[],memoryProjects:[],memoryActivity:{entries:[]},triggers:expect.arrayContaining([{id:'knowledge-sweep:fiction'}])});
 const socket=new WebSocket(url.replace('http:','ws:')+'/graphql','graphql-transport-ws',{headers:{cookie,origin:url}});socket.on('error',()=>{});cleanups.push(()=>socket.terminate());await once(socket,'open');
 const next=async(action:()=>unknown)=>{const message=once(socket,'message');await action();return JSON.parse(String((await message)[0]));};
 expect((await next(()=>socket.send(JSON.stringify({type:'connection_init'})))).type).toBe('connection_ack');
 const initial=await next(()=>socket.send(JSON.stringify({type:'subscribe',id:'memory',payload:{query:'subscription($query:String!){observe(query:$query){revision patches{path value removed}}}',variables:{query:'{memoryKnowledge{pages{title}}}'}}})));
 expect(initial.payload.data.observe.revision).toBe(1);
 const changed=await next(async()=>{const response=await fetch(url+'/api/mind/knowledgeAdd',{method:'POST',headers:{cookie,origin:url,'content-type':'application/json'},body:JSON.stringify({id:'startup-fact',input:{title:'Socket fact',domain:'fiction',body:'Fictional words',source:''}})});expect(await response.json()).toMatchObject({ok:true});});
 expect(JSON.stringify(changed)).toContain('Socket fact');
 const pushMetadata=await(await fetch(url+'/graphql',{method:'POST',headers:{cookie,origin:url,'content-type':'application/json'},body:JSON.stringify({query:'{ account { notifications { publicKey devices { ref } } } }'})})).json();expect(pushMetadata.data.account.notifications).toEqual({publicKey:pushKey.publicKey,devices:[]});expect(JSON.stringify(pushMetadata)).not.toContain(pushKey.privateKey);
 const peer=await signedIn(f.home,url,'peer');expect((await query(peer)).memoryKnowledge).toBeNull();
 const audit=new Database(f.program.database,{readonly:true});try{for(const token of audit.prepare('SELECT fingerprint,label FROM tokens').all() as Array<{fingerprint:string;label:string}>)expect(token.label.includes(token.fingerprint)).toBe(false);}finally{audit.close();}
 expect((await fetch(url+'/live')).status).toBe(404);expect(errors).toEqual([`loom: shared app on ${url}\n`]);
});
it('refuses an old SQLite store before preparing Memory files and preserves its exact bytes',async()=>{
 const f=await fixture(),old=join(f.home,'old.db'),client=new Database(old);client.exec("CREATE TABLE precious(words TEXT);INSERT INTO precious VALUES('FICTIONAL PRECIOUS WORDS')");client.close();
 const before=readFileSync(old);writeFileSync(f.config,JSON.stringify({...f.program,database:old}),{mode:0o600});
 await expect(startSharedHome({home:f.home,port:0})).rejects.toThrow('separate move');
 expect(readFileSync(old)).toEqual(before);expect(existsSync(f.program.memory.sources.commons.knowledge)).toBe(false);expect(existsSync(join(f.home,'operator.sock'))).toBe(false);
});
it('upgrades a household installed at an earlier schema number, and refuses an interim one at that number with its exact bytes',async()=>{
 const first=readFileSync(new URL('./core/data/shipped-shapes/1.sql',import.meta.url),'utf8'),at='2026-11-15T12:00:00.000Z';
 // One transaction: the installation SQL is some 1,300 statements, and committing each to disk on its own took most of this test's time.
 const earlier=(file:string,extra='')=>{const client=new Database(file);client.exec('BEGIN;'+first+extra+';COMMIT');client.prepare('INSERT INTO migrations (number,applied_at) VALUES (1,?)').run(at);
  client.prepare("INSERT INTO members (id,role,joined_at) VALUES ('owner','owner',?)").run(at);
  client.exec("INSERT INTO agents (id,about,mark_bg,mark_fg,face_shape,face_eyes) VALUES ('fiction','','','','pebble','dot');INSERT INTO member_agents (member,agent) VALUES ('owner','fiction');INSERT INTO household (default_agent,timezone) VALUES ('fiction','Asia/Tokyo')");client.close();};
 const f=await fixture(),interim=join(f.home,'interim.db');earlier(interim,'CREATE TABLE interim_notes (words text);');
 const before=readFileSync(interim);writeFileSync(f.config,JSON.stringify({...f.program,database:interim}),{mode:0o600});
 await expect(startSharedHome({home:f.home,port:0})).rejects.toThrow('separate move');
 expect(readFileSync(interim)).toEqual(before);expect(existsSync(interim+'-journal')).toBe(false);expect(existsSync(interim+'-wal')).toBe(false);expect(existsSync(join(f.home,'operator.sock'))).toBe(false);
 const known=join(f.home,'earlier.db');earlier(known);writeFileSync(f.config,JSON.stringify({...f.program,database:known}),{mode:0o600});
 const app=await startSharedHome({home:f.home,port:0,stdout:()=>{}});await app.close();
 const upgraded=new Database(known,{readonly:true});
 try{expect(upgraded.prepare('SELECT max(number) AS number FROM migrations').get()).toEqual({number:dataSchemaNumber});expect(upgraded.prepare('SELECT id,removed_at FROM members').all()).toEqual([{id:'owner',removed_at:null}]);}finally{upgraded.close();}
},30_000);
it('releases the adapter, database, source listeners and home ownership after bind failure and on repeated close',async()=>{
 const f=await fixture(),module=join(f.home,'adapters.mjs');
 writeFileSync(module,"import {writeFileSync} from 'node:fs';import {join} from 'node:path';export let client,closed=0;export default ({db,home})=>{client=db.$client;return {close(){closed++;writeFileSync(join(home,'adapter-closed'),String(client.prepare('SELECT count(*) AS n FROM members').get().n));}}};",{mode:0o600});
 writeFileSync(f.config,JSON.stringify({...f.program,adapters:module}),{mode:0o600});
 const blocked=createServer();await new Promise<void>(ok=>blocked.listen(0,'127.0.0.1',ok));cleanups.push(()=>new Promise<void>(ok=>blocked.close(()=>ok())));
 const address=blocked.address();if(!address||typeof address==='string')throw Error('No port');
 const clock=new FakeClock(),scheduled=vi.spyOn(clock,'at');
 await expect(startSharedHome({home:f.home,port:address.port,clock})).rejects.toThrow();
 const adapter=await import(pathToFileURL(module).href);expect(adapter.client.open).toBe(false);expect(adapter.closed).toBe(1);
 expect(readFileSync(join(f.home,'adapter-closed'),'utf8')).toBe('2');const calls=scheduled.mock.calls.length;clock.advance(86400000);expect(scheduled).toHaveBeenCalledTimes(calls);
 const app=await startSharedHome({home:f.home,port:0,clock,stdout:()=>{}});expect(adapter.client.open).toBe(true);
 await expect(startSharedHome({home:f.home,port:0,clock,stdout:()=>{}})).rejects.toThrow('already running');expect(adapter.client.open).toBe(true);
 await Promise.all([app.close(),app.close()]);expect(adapter.client.open).toBe(false);expect(adapter.closed).toBe(2);
 const reopened=new Database(f.program.database,{readonly:true});expect(reopened.prepare('SELECT count(*) AS n FROM members').get()).toEqual({n:2});reopened.close();
});
it('refuses a public startup inventory without starting a listener',async()=>{
 const f=await fixture();chmodSync(f.config,0o644);
 await expect(startSharedHome({home:f.home,port:0})).rejects.toThrow();expect(existsSync(join(f.home,'operator.sock'))).toBe(false);
});
it('refuses public assets overlapping private files or a startup owner who is not an owner',async()=>{
 const f=await fixture();
 writeFileSync(f.config,JSON.stringify({...f.program,webRoot:f.home}),{mode:0o600});
 await expect(startSharedHome({home:f.home,port:0})).rejects.toThrow('overlap');
 const alias=join(f.home,'public-alias');symlinkSync(f.home,alias);
 writeFileSync(f.config,JSON.stringify({...f.program,webRoot:alias}),{mode:0o600});
 await expect(startSharedHome({home:f.home,port:0})).rejects.toThrow('overlap');
 writeFileSync(f.config,JSON.stringify({...f.program,signinMember:'peer'}),{mode:0o600});
 await expect(startSharedHome({home:f.home,port:0})).rejects.toThrow('existing household owner');
 expect(existsSync(f.program.memory.sources.commons.knowledge)).toBe(false);
});
it('rechecks the configured startup owner after service adapters finish',async()=>{
 const f=await fixture(),module=join(f.home,'demote.mjs'),printed=vi.fn();
 writeFileSync(module,"export default ({db})=>{db.$client.prepare(\"UPDATE members SET role='member' WHERE id='owner'\").run();return {};};",{mode:0o600});
 writeFileSync(f.config,JSON.stringify({...f.program,adapters:module}),{mode:0o600});
 await expect(startSharedHome({home:f.home,port:0,stdout:printed})).rejects.toThrow('no longer allowed');expect(printed).not.toHaveBeenCalled();expect(existsSync(join(f.home,'operator.sock'))).toBe(false);
 const client=new Database(f.program.database,{readonly:true});expect(client.prepare('SELECT count(*) AS n FROM signin_links').get()).toEqual({n:0});client.close();
});
it('keeps existing precious source bytes unchanged through failed and complete startup',async()=>{
 const f=await fixture(),sources=f.program.memory.sources;mkdirSync(sources.commons.directory,{recursive:true});mkdirSync(sources.agents[0].directory,{recursive:true});
 const knowledge=new SqliteKnowledgeBackend({dbPath:sources.commons.knowledge});await knowledge.writePage({slug:'kept',title:'Kept fact',domain:'fiction',body:'PRECIOUS FICTIONAL WORDS'});knowledge.close();
 new PeopleStore({dbPath:sources.commons.people}).close();new PeopleStore({dbPath:sources.agents[0].memories}).close();new ProjectsStore({dbPath:sources.agents[0].memories}).close();
 const paths=[sources.commons.knowledge,sources.commons.people,sources.agents[0].memories],before=paths.map(path=>readFileSync(path));
 const snapshots=()=>paths.map(path=>{const db=new Database(path,{readonly:true,fileMustExist:true});try{return db.serialize();}finally{db.close();}}),initial=snapshots();
 const unchanged=()=>snapshots().every((bytes,index)=>bytes.equals(initial[index]))&&paths.every((path,index)=>readFileSync(path).equals(before[index]));
 const blocked=createServer();await new Promise<void>(ok=>blocked.listen(0,'127.0.0.1',ok));cleanups.push(()=>new Promise<void>(ok=>blocked.close(()=>ok())));const address=blocked.address();if(!address||typeof address==='string')throw Error('No port');
 await expect(startSharedHome({home:f.home,port:address.port,stdout:()=>{}})).rejects.toThrow();expect(unchanged()).toBe(true);
 const app=await startSharedHome({home:f.home,port:0,stdout:()=>{}}),cookie=await signedIn(f.home,app.url);cleanups.push(()=>app.close());
 const response=await fetch(app.url+'/graphql',{method:'POST',headers:{cookie,origin:app.url,'content-type':'application/json'},body:JSON.stringify({query:'{memoryKnowledge{pages{title}} memoryPeople{id} memoryProjects{id} memoryActivity{entries{title}}}'})});
 expect(await response.json()).toMatchObject({data:{memoryKnowledge:{pages:[{title:'Kept fact'}]}}});
 const write=await fetch(app.url+'/api/mind/knowledgeAdd',{method:'POST',headers:{cookie,origin:app.url,'content-type':'application/json'},body:JSON.stringify({id:'unprepared',input:{title:'No upgrade',domain:'fiction',body:'Fiction',source:''}})});expect(await write.json()).toMatchObject({ok:false,code:'unavailable'});
 await app.close();expect(unchanged()).toBe(true);
});

it('runs file triggers, pauses, notices and recipient volume through the normal CLI program',async()=>{
 const clock=new FakeClock(Date.now()),actualStart=startSharedHome;
 const injection=vi.spyOn(startup,'startSharedHome').mockImplementation(options=>actualStart({...options,clock}));
 cleanups.push(()=>injection.mockRestore());
 const f=await fixture(),repository=join(f.home,'routine-repository');
 mkdirSync(join(repository,'routines'),{recursive:true});
 const routine=join(repository,'routines','tempo.md');writeFileSync(routine,'ORIGINAL ROUTINE WORDS');
 writeFileSync(f.config,JSON.stringify({...f.program,repository}),{mode:0o600});
 const prepared=new Database(f.program.database);
 prepared.prepare('INSERT INTO tempo_settings(who_kind,who,settle_seconds) VALUES (?,?,?)').run('person','owner',0);prepared.close();
 const printed:string[]=[],errors:string[]=[];let ready!:(url:string)=>void;
 const started=new Promise<string>(resolve=>{ready=resolve;});
 const pending=run(['--http','--home',f.home,'--host','127.0.0.1','--port','0'],{
  stdin:Readable.from([]),stdinIsTTY:false,env:{},stdout:text=>printed.push(text),
  stderr:text=>{errors.push(text);const match=/shared app on (\S+)/.exec(text);if(match)ready(match[1]);},
 });
 cleanups.push(async()=>{process.emit('SIGTERM');expect(await pending).toBe(0);});
 const url=await Promise.race([started,pending.then(code=>{throw Error(`CLI stopped (${code}): ${errors.join('')}`);})]);
 const login=await fetch(url+(await requestLocalLink(f.home,{request:'link'})).path,{method:'POST',redirect:'manual',headers:{origin:url}});
 expect(login.status).toBe(303);const cookie=login.headers.get('set-cookie')!.split(';',1)[0];
 const headers={cookie,origin:url,'content-type':'application/json'};
 const command=async(name:string,input:unknown,id:string)=>{
  const response=await fetch(url+'/api/'+name.replace('.','/'),{method:'POST',headers,body:JSON.stringify({input,id})});
  const result=await response.json();expect(response.status,name+': '+JSON.stringify(result)).toBe(200);expect(result).toMatchObject({ok:true});
 };
 const query=async(query:string,variables:Record<string,unknown>={})=>{
  const response=await fetch(url+'/graphql',{method:'POST',headers,body:JSON.stringify({query,variables})});
  expect(response.status).toBe(200);const result=await response.json();expect(result.errors).toBeUndefined();return result.data;
 };
 const rows=()=>query('{triggers{id state enabled} inboxItems(source:"trigger"){id body{words}}}');
 const base={ownerKind:'household',sourceKind:'time',lifespan:'once',targetKind:'inbox',toKind:'agent',to:'fiction',note:'Normal entry routine'};
 const future=new Date(clock.now()+3600000).toISOString();
 await command('tempo.pause',{agent:'fiction'},'normal-pause');
 await command('tempo.set',{...base,id:'normal-paused',times:future,instructions:'HELD AGENT WORDS'},'normal-paused');
 let state=await rows();expect(state.triggers.find((row:{id:string})=>row.id==='normal-paused')).toMatchObject({state:'held'});
 await command('tempo.resume',{agent:'fiction'},'normal-resume');
 expect((await rows()).triggers.find((row:{id:string})=>row.id==='normal-paused')).toMatchObject({state:'standing'});
 await command('tempo.runNow',{id:'normal-paused'},'normal-agent-now');
 expect((await rows()).triggers.find((row:{id:string})=>row.id==='normal-paused')).toMatchObject({state:'fired'});
 // The personal Inbox reads its own notice; agent mail has a separate recipient.
 await command('tempo.set',{...base,toKind:'person',to:'owner',id:'normal-file',times:future,file:'routines/tempo.md'},'normal-file');
 expect((await rows()).inboxItems.some((row:{body?:{words:string}})=>row.body?.words==='ORIGINAL ROUTINE WORDS')).toBe(false);
 writeFileSync(routine,'CURRENT ROUTINE WORDS');
 await command('tempo.runNow',{id:'normal-file'},'normal-file-now');
 state=await rows();expect(state.triggers.find((row:{id:string})=>row.id==='normal-file')).toMatchObject({state:'fired'});
 expect(state.inboxItems.filter((row:{body?:{words:string}})=>row.body?.words==='CURRENT ROUTINE WORDS')).toHaveLength(1);
 await command('tempo.set',{...base,id:'normal-cancel',times:future,instructions:'CANCELLED ROUTINE WORDS'},'normal-cancel');
 await command('tempo.stop',{id:'normal-cancel'},'normal-stop');
 await command('tempo.set',{...base,id:'normal-person',times:future,toKind:'person',to:'owner',instructions:'NORMAL PERSON NOTICE'},'normal-person');
 await command('tempo.runNow',{id:'normal-person'},'normal-now');
 clock.advance(0);
 expect((await query('{settledInboxNotice{id count}}')).settledInboxNotice?.count).toBe(2);
 state=await rows();expect(state.triggers.find((row:{id:string})=>row.id==='normal-cancel')).toMatchObject({state:'stopped',enabled:false});
 const item=state.inboxItems.find((row:{body?:{words:string}})=>row.body?.words==='NORMAL PERSON NOTICE');expect(item).toBeDefined();
 const readItem=async()=> (await query('query($id:String!){inboxItem(id:$id){volume quietUntil}}',{id:item.id})).inboxItem;
 for(const volume of ['dim','mute','full']){
  await command('inbox.volume',{item:item.id,volume},'normal-volume-'+volume);
  const current=await readItem();expect(current.volume).toBe(volume);
  if(volume==='mute')expect(current.quietUntil).toBe(new Date(clock.now()+7*86400000).toISOString());
  if(volume==='full')expect(current.quietUntil).toBeNull();
 }
 expect((await fetch(url+'/api/clock/in',{method:'POST',headers,body:JSON.stringify({input:{},id:'retired'})})).status).toBe(404);
 expect(errors).toEqual([`loom: shared app on ${url}\n`]);
});
it('persists a narrow outside-program token and an empty grant marker through normal home restarts',async()=>{
 const f=await fixture();let app=await startSharedHome({home:f.home,port:0,stdout:()=>{}});cleanups.push(()=>app.close());
 const call=(path:string,input:unknown,headers:Record<string,string>)=>fetch(app.url+path,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(input)});
 let cookie=await signedIn(f.home,app.url);const response=await call('/api/signin/program',{member:'peer',label:'Persistent outside client',records:['tasks'],operations:['tasks.command']},{cookie});expect(response.status).toBe(200);
 const {value}=await response.json(),headers={authorization:'Bearer '+value.token};
 const read=()=>call('/graphql',{query:'{ tasks { id } }'},headers).then(response=>response.json());expect(await read()).toEqual({data:{tasks:[]}});
 const command={id:'programme-task-create',input:{action:'create',input:{title:'Programme task',goal:'Actual granted operation',why:'Fictional proof',owner:{kind:'member',id:'peer'}}}},created=await call('/api/tasks/command',command,headers);expect(created.status).toBe(200);const task=(await created.json()).value.id;
 expect((await(await call('/graphql',{query:'{ projects { id } }'},headers)).json()).errors).toBeDefined();
 await app.close();app=await startSharedHome({home:f.home,port:0,stdout:()=>{}});expect(await read()).toEqual({data:{tasks:[{id:task}]}});cookie=await signedIn(f.home,app.url);
 const changed=await call('/api/program/setGrants',{id:'clear-persistent-program',input:{fingerprint:value.fingerprint,records:[],operations:[]}},{cookie});expect(changed.status).toBe(200);expect((await read()).errors).toBeDefined();
 await app.close();app=await startSharedHome({home:f.home,port:0,stdout:()=>{}});expect((await read()).errors).toBeDefined();expect((await call('/api/tasks/command',command,headers)).status).toBe(403);cookie=await signedIn(f.home,app.url);
 const metadata=await(await call('/graphql',{query:'{ programSetup { tokens { fingerprint records operations } } }'},{cookie})).json();expect(metadata.data.programSetup.tokens).toContainEqual({fingerprint:value.fingerprint,records:[],operations:[]});
 expect((await call('/api/token/revoke',{id:'revoke-persistent-program',input:{fingerprint:value.fingerprint}},{cookie})).status).toBe(200);expect((await call('/graphql',{query:'{ tasks { id } }'},headers)).status).toBe(403);
});
it('makes no credential at start, and keeps one token row per member for every local sign-in the operator asks for',async()=>{
 const f=await fixture(),printed:string[]=[];
 const rows=()=>{const client=new Database(f.program.database,{readonly:true});try{return {tokens:client.prepare('SELECT label,kind,member,expires_at AS expiresAt,revoked_at AS revokedAt FROM tokens ORDER BY label').all(),links:(client.prepare('SELECT count(*) AS n FROM signin_links').get() as {n:number}).n,sessions:(client.prepare('SELECT count(*) AS n FROM sessions').get() as {n:number}).n};}finally{client.close();}};
 let app=await startSharedHome({home:f.home,port:0,stdout:text=>printed.push(text)});cleanups.push(()=>app.close());
 await app.close();app=await startSharedHome({home:f.home,port:0,stdout:text=>printed.push(text)});
 // Two starts: two hints, no link, no token row.
 expect(printed.join('')).not.toContain('/login/');expect(printed).toHaveLength(2);expect(rows()).toEqual({tokens:[],links:0,sessions:0});
 // The operator asks, three times for the configured owner and once for another member.
 const first=await requestLocalLink(f.home,{request:'link'});expect(first.url).toBe(app.url);
 await requestLocalLink(f.home,{request:'link',label:'Second'});await signedIn(f.home,app.url);
 const cookie=await signedIn(f.home,app.url,'peer');
 expect(await(await fetch(app.url+'/auth/session',{headers:{cookie}})).json()).toEqual({viewer:{kind:'member',id:'peer'}});
 expect(rows()).toEqual({links:2,sessions:2,tokens:[
  {label:'Local sign-in: owner',kind:'owner',member:'owner',expiresAt:null,revokedAt:null},
  {label:'Local sign-in: peer',kind:'owner',member:'peer',expiresAt:null,revokedAt:null}]});
 // A link asked for less than five minutes lasts that long; one asked for more lasts five minutes.
 const writable=()=>{const client=new Database(f.program.database);client.function('loom_now',()=>new Date().toISOString());return client;};
 const client=writable();
 try{
  const ends=(client.prepare('SELECT expires_at AS at FROM signin_links ORDER BY expires_at').all() as {at:string}[]).map(row=>Date.parse(row.at)-Date.now());
  for(const left of ends){expect(left).toBeGreaterThan(290_000);expect(left).toBeLessThanOrEqual(300_000);}
  // Revoking the row ends what rode on it; the next local sign-in gets a new one.
  client.prepare("UPDATE tokens SET revoked_at=? WHERE label='Local sign-in: peer'").run(new Date().toISOString());
 }finally{client.close();}
 expect(await(await fetch(app.url+'/auth/session',{headers:{cookie}})).json()).toEqual({viewer:null});
 await signedIn(f.home,app.url,'peer');
 expect(rows().tokens.filter(row=>(row as {member:string}).member==='peer')).toHaveLength(2);
 // Nobody the household does not have, and no default once the configured owner is no longer one.
 await expect(requestLocalLink(f.home,{request:'link',member:'nobody'})).rejects.toThrow('Local sign-in refused');
 const demote=writable();demote.prepare("UPDATE members SET role='member' WHERE id='owner'").run();demote.close();
 await expect(requestLocalLink(f.home,{request:'link'})).rejects.toThrow('Local sign-in refused');
 await signedIn(f.home,app.url,'owner');
});
it('tells the operator plainly when there is no running program to ask for a sign-in link',async()=>{
 const home=mkdtempSync(join(tmpdir(),'loom-nothing-running-'));cleanups.push(()=>rmSync(home,{recursive:true,force:true}));chmodSync(home,0o700);
 const out:string[]=[],errors:string[]=[];
 expect(await signin(['--home',home],{stdout:text=>out.push(text),stderr:text=>errors.push(text)})).toBe(1);
 expect(out).toEqual([]);expect(errors.join('')).toContain('No sign-in link');
 expect(await signin(['--bogus'],{stdout:text=>out.push(text),stderr:text=>errors.push(text)})).toBe(2);
});
