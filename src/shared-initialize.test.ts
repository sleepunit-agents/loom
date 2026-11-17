import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as age from 'age-encryption';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import * as rows from './core/data/schema.js';
import {privateSecretClient} from './pieces/secrets/private-client.js';
import {ownHome} from './core/daemon-home.js';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,readdirSync,statSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import * as schema from './core/data/database.js';
import {FakeClock} from './core/clock.js';
import {householdService} from './apps/household.js';
import {initializeSharedHome} from './shared-initialize.js';
import {startSharedHome} from './shared-startup.js';
import {startSharedHolder} from './shared-holder-process.js';
import {inProcessSharedHolder} from '../test/fixtures/shared-holder.js';
// The household's first owner: who it is is in the household database, not in program.json.
const ownerOf=(database:string)=>{const db=new Database(database,{readonly:true});try{return (db.prepare("SELECT id FROM members WHERE role='owner'").get() as {id:string}).id;}finally{db.close();}};
const sqlite=vi.hoisted(()=>({opened:[]as Array<{name:string;open:boolean}>}));
vi.mock('better-sqlite3',async original=>{const real=await original<{default:typeof import('better-sqlite3')}>();return {...real,default:new Proxy(real.default,{construct(target,args,newTarget){const db=Reflect.construct(target,args,newTarget);sqlite.opened.push(db);return db;}})};});
vi.mock('./shared-holder-process.js',async()=>({startSharedHolder:vi.fn((await import('../test/fixtures/shared-holder.js')).inProcessSharedHolder)}));
vi.mock('node:fs',async original=>{const real=await original<typeof import('node:fs')>();return {...real,openSync:vi.fn(real.openSync),fsyncSync:vi.fn(real.fsyncSync),renameSync:vi.fn(real.renameSync)};});
vi.mock('age-encryption',async original=>{const real=await original<typeof import('age-encryption')>();return {...real,generateX25519Identity:vi.fn(real.generateX25519Identity)};});
beforeEach(()=>{vi.stubEnv('LOOM_PUBLIC_URL',undefined);vi.stubEnv('LOOM_WORKER_SOCKET',undefined);});
const clean:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{vi.restoreAllMocks();const real=await vi.importActual<typeof import('node:fs')>('node:fs');vi.mocked(fs.renameSync).mockImplementation(real.renameSync);for(const close of clean.splice(0).reverse())await close();vi.unstubAllEnvs();});
function fixture(){const root=mkdtempSync(join(tmpdir(),'empty-shared-')),home=join(root,'home');mkdirSync(home);clean.push(()=>rmSync(root,{recursive:true,force:true}));return home;}
it('first install publishes a private prepared inventory and the ordinary startup link admits HTTP and GraphQL',async()=>{
 const home=fixture(),webRoot=fixture(),clock=new FakeClock();writeFileSync(join(webRoot,'next.html'),'Shared app');let link='';
 const app=await startSharedHome({home,webRoot,port:0,clock,stdout:()=>{}});link=app.signinLink();clean.push(()=>app.close());
 const program=JSON.parse(readFileSync(join(home,'program.json'),'utf8'));
 for(const name of ['program.json','comms.key','loom.db'])expect(statSync(join(home,name)).mode&0o777).toBe(0o600);
 // Where things are, and nobody's name: the first owner and agent are rows in the database below.
 expect(program).not.toHaveProperty('signinMember');expect(program.memory.sources).not.toHaveProperty('agents');
 const audit=new Database(program.database,{readonly:true});try{expect(audit.prepare('SELECT count(*) AS n FROM members').get()).toEqual({n:1});expect(audit.prepare('SELECT count(*) AS n FROM agents').get()).toEqual({n:1});}finally{audit.close();}
 const response=await fetch(link,{method:'POST',redirect:'manual'});expect(response.status).toBe(303);const cookie=response.headers.get('set-cookie')!.split(';')[0];
 const secretValue='fictional-normal-startup-value-172';
 const secretPost=async(url:string,path:string,input:unknown)=>{const response=await fetch(url+'/api/secrets/'+path,{method:'POST',headers:{cookie,origin:url,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),input})});expect(response.status).toBe(200);return response.json();};
 const openIndex=vi.mocked(fs.openSync).mock.calls.findIndex(([path,flags])=>path===dirname(home)&&typeof flags==='number'&&!!(flags&fs.constants.O_DIRECTORY));expect(openIndex).toBeGreaterThan(-1);
 const opened=vi.mocked(fs.openSync).mock.results[openIndex].value,openAt=vi.mocked(fs.openSync).mock.invocationCallOrder[openIndex],holderAt=vi.mocked(startSharedHolder).mock.invocationCallOrder.at(-1)!;
 expect(vi.mocked(fs.fsyncSync).mock.calls.some(([fd],index)=>fd===opened&&vi.mocked(fs.fsyncSync).mock.invocationCallOrder[index]>openAt&&vi.mocked(fs.fsyncSync).mock.invocationCallOrder[index]<holderAt)).toBe(true);
 expect(program.secretHolder).toBe(true);
 expect(await secretPost(app.url,'set',{id:randomUUID(),name:'EXAMPLE',mode:'add',value:secretValue})).toEqual({ok:true,value:{saved:true}});
 const holderDb=new Database(join(home,'secret-holder/holder.db'),{readonly:true});try{const row=holderDb.prepare('SELECT ciphertext FROM holder_values WHERE name=?').get('EXAMPLE') as {ciphertext:Buffer};expect(row.ciphertext.includes(Buffer.from(secretValue))).toBe(false);}finally{holderDb.close();}
 for(const name of readdirSync(home).filter(name=>name.startsWith('loom.db')))expect(readFileSync(join(home,name)).includes(Buffer.from(secretValue))).toBe(false);
 await receiveGrantedValue(app,program,clock,cookie,secretValue);
 const query='{ tasks { id title } }';
 const http=await fetch(app.url+'/graphql',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({query})});expect((await http.json()).data.tasks).toEqual([]);
 const ws=new WebSocket(app.url.replace('http:','ws:')+'/graphql','graphql-transport-ws',{headers:{cookie,origin:app.url}});clean.push(()=>{ws.terminate();});await once(ws,'open');
 const frame=async(send:unknown)=>{const incoming=once(ws,'message');ws.send(JSON.stringify(send));return JSON.parse(String((await incoming)[0]));};
 expect(await frame({type:'connection_init'})).toEqual({type:'connection_ack'});
 const initial=await frame({type:'subscribe',id:'tasks',payload:{query:'subscription($query:String!){observe(query:$query){revision patches{path removed value}}}',variables:{query}}});expect(initial.payload.data.observe.revision).toBe(1);
 const {viewer}=await (await fetch(app.url+'/auth/session',{headers:{cookie}})).json(),next=once(ws,'message');
 app.writes.run(()=>app.services.tasks.create({title:'Fresh live task',goal:'Water flows',why:'Exercise the initial credential',owner:{kind:'household'}},{kind:'member',id:viewer.id}));
 expect(String((await next)[0])).toContain('Fresh live task');
 await app.close();
 const resumed=await startSharedHome({home,webRoot,port:0,clock,stdout:()=>{}});clean.push(()=>resumed.close());
 expect(await secretPost(resumed.url,'set',{id:randomUUID(),name:'EXAMPLE',mode:'replace',value:'fictional-replacement'})).toEqual({ok:true,value:{saved:true}});
 expect(await secretPost(resumed.url,'remove',{id:randomUUID(),name:'EXAMPLE'})).toEqual({ok:true,value:{saved:true}});
 await resumed.close();const before=readFileSync(join(home,'program.json'));await initializeSharedHome(home,clock);expect(readFileSync(join(home,'program.json'))).toEqual(before);
});
it('first install stores the server zone once and preserves a later household choice',async()=>{
 vi.stubEnv('TZ','America/Chicago');const home=fixture();await initializeSharedHome(home,new FakeClock());
 const program=JSON.parse(readFileSync(join(home,'program.json'),'utf8')),db=new Database(program.database);
 try{
  expect(db.prepare('SELECT timezone FROM household').get()).toEqual({timezone:'America/Chicago'});
  db.prepare('UPDATE household SET timezone = ?').run('Asia/Tokyo');
  vi.stubEnv('TZ','Europe/London');
  const now=()=>new Date(0).toISOString();householdService(schema.dataDatabase(db,now),now).initialize('assistant');
  await initializeSharedHome(home,new FakeClock());
  expect(db.prepare('SELECT timezone FROM household').get()).toEqual({timezone:'Asia/Tokyo'});
 }finally{db.close();}
});
it.each(['precious-memory.md','loom.db'])('never initializes a nonempty home containing %s',async name=>{
 const home=fixture();writeFileSync(join(home,name),name==='loom.db'?'':'Precious words');const before=readFileSync(join(home,name));
 await expect(initializeSharedHome(home,new FakeClock())).rejects.toThrow('separate data move');expect(readdirSync(home)).toEqual([name]);expect(readFileSync(join(home,name))).toEqual(before);
});
it('failed private schema creation leaves the requested home empty and retryable',async()=>{
 const home=fixture(),failing=vi.spyOn(schema,'createDataSchema').mockImplementationOnce(client=>client.transaction(()=>{client.exec('CREATE TABLE unfinished (id TEXT)');throw Error('Synthetic initialization failure');})());
 try{await expect(initializeSharedHome(home,new FakeClock())).rejects.toThrow('Synthetic initialization failure');}finally{failing.mockRestore();}
 expect(readdirSync(home)).toEqual([]);await initializeSharedHome(home,new FakeClock());expect(readdirSync(home).sort()).toEqual(['comms.key','loom.db','program.json']);
});

it('holds home ownership while the private build is suspended and releases it on failure',async()=>{
 const home=fixture(),gate=suspend();const pending=initializeSharedHome(home,new FakeClock()),failed=expect(pending).rejects.toThrow('Synthetic key failure');await gate.began;
 await expect(ownHome(home)).rejects.toThrow('already running');gate.reject();await failed;expect(readdirSync(home)).toEqual([]);
 const release=await ownHome(home);await release();
});
it.each(['file','directory'])('failed staging preserves a foreign %s at its original pathname and link count',async kind=>{
 const home=fixture(),gate=suspend();const pending=initializeSharedHome(home,new FakeClock()),failed=expect(pending).rejects.toThrow('Synthetic key failure');await gate.began;
 const path=join(home,'loom.db');if(kind==='directory'){mkdirSync(path);writeFileSync(join(path,'memory.md'),'PRECIOUS WORDS');}else writeFileSync(path,'PRECIOUS WORDS');
 const before=statSync(path);gate.reject();await failed;const after=statSync(path);
 expect(after.ino).toBe(before.ino);expect(after.nlink).toBe(before.nlink);expect(readFileSync(kind==='directory'?join(path,'memory.md'):path,'utf8')).toBe('PRECIOUS WORDS');
});
it('atomic publication refuses a home populated by another writer without moving its entries',async()=>{
 const home=fixture(),actual=(await vi.importActual<typeof import('node:fs')>('node:fs')).renameSync;let replaced=false;
 vi.mocked(fs.renameSync).mockImplementation((from,to)=>{if(to===home){replaced=true;mkdirSync(join(home,'loom.db'));writeFileSync(join(home,'loom.db/memory.md'),'CONCURRENT PRECIOUS WORDS');}return actual(from,to);});
 await expect(initializeSharedHome(home,new FakeClock())).rejects.toThrow();expect(replaced).toBe(true);expect(readdirSync(home)).toEqual(['loom.db']);expect(readFileSync(join(home,'loom.db/memory.md'),'utf8')).toBe('CONCURRENT PRECIOUS WORDS');
});
function suspend(){
 let entered!:()=>void,reject!:()=>void;const began=new Promise<void>(ok=>{entered=ok;}),held=new Promise<string>((_ok,no)=>{reject=()=>no(Error('Synthetic key failure'));});
 vi.mocked(age.generateX25519Identity).mockImplementationOnce(()=>{entered();return held;});return {began,reject};
}

it('keeps Root admission closed and home owned while the original holder is draining',async()=>{
 const home=fixture(),webRoot=fixture(),clock=new FakeClock();writeFileSync(join(webRoot,'next.html'),'Fiction');
 let entered!:()=>void,release!:()=>void;const draining=new Promise<void>(yes=>{entered=yes;}),held=new Promise<void>(yes=>{release=yes;});
 vi.mocked(startSharedHolder).mockImplementationOnce(async(directory,selectedClock)=>{const original=await inProcessSharedHolder(directory,selectedClock);return {...original,async close(){entered();await held;await original.close();}};});
 const app=await startSharedHome({home,webRoot,port:0,clock,stdout:()=>{}});clean.push(()=>app.close());
 const root=sqlite.opened.find(db=>db.open&&db.name===JSON.parse(readFileSync(join(home,'program.json'),'utf8')).database)!;expect(root).toBeDefined();
 const closing=app.close();await draining;expect(root.open).toBe(true);
 try{expect((await app.http.request('/api/secrets/set',{method:'POST'})).status).toBe(503);await expect(ownHome(home)).rejects.toThrow('already running');}
 finally{release();await closing;}expect(root.open).toBe(false);
 const unlock=await ownHome(home);await unlock();
});

async function receiveGrantedValue(app:Awaited<ReturnType<typeof startSharedHome>>,program:{database:string},clock:FakeClock,cookie:string,secretValue:string){
 // Seed only fictional worker identity; the real Root issues the body proof,
 // then the actual Owner command answers its request and the SDK takes bytes.
 const fixtureDb=new Database(program.database),db=schema.dataDatabase(fixtureDb),at=new Date(clock.now()).toISOString(),runner=randomBytes(32).toString('hex'),body='body_'+randomBytes(32).toString('hex'),hash=(value:string)=>createHash('sha256').update(value).digest('hex');
 try{
  db.insert(rows.boxes).values({id:'worker',name:'Worker',owner:ownerOf(program.database),sameMachineAsLoom:false,hostsAny:false,reportOnly:false,alwaysOn:false,enrolledAt:at}).run();
  db.insert(rows.jobs).values({id:'secret-job',box:'worker',agent:'assistant',state:'starting',title:'Private input',brief:'',model:'fiction',startedByKind:'agent',startedBy:'assistant',houseRepository:'',houseFile:'',houseBranch:'next',queuedAt:at}).run();
  db.insert(rows.tokens).values({fingerprint:hash(runner),label:'Fixture worker',kind:'runner',box:'worker',createdAt:at}).run();
 }finally{fixtureDb.close();}
 const bodyPost=async(path:string,input:unknown,token:string)=>{const response=await fetch(app.url+'/api/'+path,{method:'POST',headers:{authorization:'Bearer '+token,origin:app.url,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),input})});expect(response.status).toBe(200);return response.json();};
 await bodyPost('runtime/enrollBody',{job:'secret-job',fingerprint:hash(body)},runner);await bodyPost('runtime/started',{job:'secret-job',build:'fictitious-build'},runner);
 const requestId=randomUUID();await bodyPost('secrets/request',{id:requestId,secret:'EXAMPLE',why:'Prove the default private input source',minutes:5,scope:'job'},body);
 const allowed=await fetch(app.url+'/api/secrets/command',{method:'POST',headers:{cookie,origin:app.url,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),input:{action:'answer',id:requestId,allow:true,always:false}})});expect(allowed.status).toBe(200);
 const recipient=privateSecretClient({url:app.url,token:body,signal:new AbortController().signal,clock});
 try{const received=await recipient.granted('EXAMPLE',requestId);expect(received.toString()).toBe(secretValue);received.fill(0);}finally{recipient.close();}
 const audit=new Database(program.database,{readonly:true});try{expect(audit.prepare('SELECT secret,agent,job,state FROM secret_uses').get()).toEqual({secret:'EXAMPLE',agent:'assistant',job:'secret-job',state:'released'});}finally{audit.close();}
}
it.each([false,true])('keeps explicit adapter Secret ports and refuses a competing default holder flag=%s',async competing=>{
 const home=fixture(),webRoot=fixture(),clock=new FakeClock();writeFileSync(join(webRoot,'next.html'),'Fiction');await initializeSharedHome(home,clock);
 const file=join(home,'program.json'),program=JSON.parse(readFileSync(file,'utf8'));if(!competing)delete program.secretHolder;
 const selected=await inProcessSharedHolder(join(home,'explicit-holder'),clock);clean.push(()=>selected.close());
 const key='loom-shared-secret-adapter-fixture';const globals=globalThis as unknown as Record<symbol,unknown>;
 globals[Symbol.for(key)]=()=>({secretWrites:{holder:selected.holder,fingerprintKey:selected.fingerprintKey},secretInputs:{source:selected.source},close:()=>selected.close()});
 clean.push(()=>{delete globals[Symbol.for(key)];});program.adapters=join(home,'adapters.mjs');writeFileSync(program.adapters,`export default globalThis[Symbol.for(${JSON.stringify(key)})];`,{mode:0o600});writeFileSync(file,JSON.stringify(program),{mode:0o600});
 if(competing){await expect(startSharedHome({home,webRoot,port:0,clock,stdout:()=>{}})).rejects.toThrow('ports already configured');expect(selected.fingerprintKey.every(byte=>byte===0)).toBe(true);return;}
 let link='';const app=await startSharedHome({home,webRoot,port:0,clock,stdout:()=>{}});link=app.signinLink();clean.push(()=>app.close());const admitted=await fetch(link,{method:'POST',redirect:'manual'}),cookie=admitted.headers.get('set-cookie')!.split(';')[0];
 const value='fictional-explicit-adapter-value';const saved=await fetch(app.url+'/api/secrets/set',{method:'POST',headers:{cookie,origin:app.url,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),input:{id:randomUUID(),name:'EXAMPLE',mode:'add',value}})});expect(saved.status).toBe(200);await receiveGrantedValue(app,program,clock,cookie,value);
 await app.close();expect(selected.fingerprintKey.every(byte=>byte===0)).toBe(true);
});

it('refuses public assets overlapping the default private holder before starting it',async()=>{
 const home=fixture(),before=vi.mocked(startSharedHolder).mock.calls.length;
 await expect(startSharedHome({home,webRoot:join(home,'secret-holder'),port:0,clock:new FakeClock(),stdout:()=>{}})).rejects.toThrow('overlap');expect(vi.mocked(startSharedHolder).mock.calls).toHaveLength(before);
});
