import {privateSecretClient} from './pieces/secrets/private-client.js';
import Database from 'better-sqlite3';
import {createHash,randomUUID} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {createDataSchema} from './core/data/database.js';
import {FakeClock} from './core/clock.js';
import {members,agents,boxes,jobs,secrets,secretChanges,secretUses,secretGrants,tokens,sessions,agentRunSettings,agentHouseSecrets} from './core/data/schema.js';
import {sharedRoot} from './shared-root.js';
const clean:(()=>unknown|Promise<unknown>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
const raw={body:'a'.repeat(64),other:'b'.repeat(64),owner:'c'.repeat(64),runner:'d'.repeat(64),foreign:'e'.repeat(64),agent:'f'.repeat(64),cookie:'g'.repeat(64)};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function fixture(){
 const client=new Database(':memory:');clean.push(()=>{if(client.open)client.close();});const db=createDataSchema(client),clock=new FakeClock(),at=new Date(clock.now()).toISOString();
 db.insert(members).values({id:'owner',role:'owner',joinedAt:at}).run();db.insert(agents).values({id:'art',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();
 for(const id of ['box','foreign'])db.insert(boxes).values({id,name:id,owner:'owner',sameMachineAsLoom:false,hostsAny:false,reportOnly:false,alwaysOn:false,enrolledAt:at}).run();
 for(const id of ['body','other','build'])db.insert(jobs).values({id,agent:'art',box:'box',title:'',brief:'',model:'test',state:id==='build'?'starting':'running',startedByKind:'agent',startedBy:'art',houseRepository:'repo',houseFile:'house',houseBranch:'next',queuedAt:at}).run();
 for(const name of ['TOKEN','REPO']){db.insert(secrets).values({name,description:'Synthetic',changedAt:at,changedBy:'owner'}).run();db.insert(secretChanges).values({id:name,secret:name,action:'add',by:'owner',at}).run();}
 db.insert(agentRunSettings).values({agent:'art',houseRepository:'repo',houseFile:'house',houseBranch:'next',repositorySecret:'REPO',nestedContainers:false,gpu:false}).run();db.insert(agentHouseSecrets).values({agent:'art',alias:'API_TOKEN',secret:'TOKEN'}).run();
 db.insert(tokens).values([
  {fingerprint:hash(raw.owner),label:'Owner',kind:'owner',member:'owner',createdAt:at},
  {fingerprint:hash(raw.body),label:'Body',kind:'agent',agent:'art',job:'body',createdAt:at},
  {fingerprint:hash(raw.other),label:'Other',kind:'agent',agent:'art',job:'other',createdAt:at},
  {fingerprint:hash(raw.agent),label:'Agent',kind:'agent',agent:'art',createdAt:at},
  {fingerprint:hash(raw.runner),label:'Worker',kind:'runner',box:'box',createdAt:at},
  {fingerprint:hash(raw.foreign),label:'Foreign',kind:'runner',box:'foreign',createdAt:at},
 ]).run();db.insert(sessions).values({id:hash(raw.cookie),token:hash(raw.body),device:'Browser',via:'token',isAgent:true,issuedAt:at,seenAt:at,provedAt:at}).run();
 const buffers:Buffer[]=[];const source={read:vi.fn(async(_name:string)=>{expect(client.inTransaction).toBe(false);expect(db.select().from(secretUses).all().some(row=>row.state==='started')).toBe(true);const bytes=Buffer.from('PRIVATE_SOURCE_VALUE');buffers.push(bytes);return bytes;})};
 const root=sharedRoot({db,clock,originAllowed:()=>true,reportError:()=>{},secretInputs:{source}});clean.push(()=>root.close());
 const post=(path:string,input:unknown,credential=raw.body,cookie=false)=>root.http.request('http://loom/api/secrets/private/'+path,{method:'POST',headers:{'content-type':'application/json',...(cookie?{cookie:'loom_ui='+credential}:{authorization:'Bearer '+credential})},body:JSON.stringify(input)});
 const grant=(secret='TOKEN',job='body')=>root.writes.run(()=>{const id=randomUUID();root.services.secrets.requests.request({id,secret,agent:'art',job,why:'Synthetic use',minutes:5});root.services.secrets.requests.answer(id,'owner',true);return id;}).value;
 const rule=(secret='TOKEN')=>root.writes.run(()=>root.services.secrets.requests.setRule({secret,answer:'auto',minutes:5,agents:[{agent:'art',when:'at_start'}]}));
 return {client,db,clock,root,source,buffers,post,grant,rule};
}
it('hands private bytes only to the granted body, writes audit first and confirms with metadata only',async()=>{
 const f=fixture();f.grant();const id=randomUUID(),response=await f.post('read',{kind:'request',id,secret:'TOKEN'});expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');const use=response.headers.get('x-loom-secret-use')!;expect(use).toMatch(/^use-input-[a-f0-9]{64}$/);expect(f.db.select().from(secretUses).get()).toMatchObject({id:use,secret:'TOKEN',agent:'art',job:'body',state:'started'});
 expect(await response.text()).toBe('PRIVATE_SOURCE_VALUE');expect(f.buffers[0].every(byte=>byte===0)).toBe(true);expect(f.client.serialize().includes(Buffer.from('PRIVATE_SOURCE_VALUE'))).toBe(false);
 expect((await f.post('confirm',{use})).status).toBe(200);expect(f.db.select().from(secretUses).get()?.state).toBe('released');expect((await f.post('confirm',{use})).status).toBe(200);
 expect((await f.post('read',{kind:'request',id,secret:'TOKEN'})).status).toBe(409);expect(f.source.read).toHaveBeenCalledOnce();
});
it('denies owners, generic agents, runner readback, cookies and extra identity claims',async()=>{
 const f=fixture();f.grant();const input={kind:'request',id:randomUUID(),secret:'TOKEN'};
 for(const credential of [raw.owner,raw.agent,raw.runner,raw.foreign])expect((await f.post('read',input,credential)).status).toBe(403);
 expect((await f.post('read',input,raw.cookie,true)).status).toBe(403);expect((await f.post('read',{...input,job:'other'})).status).toBe(400);expect((await f.post('read',input,raw.other)).status).toBe(403);expect(f.source.read).not.toHaveBeenCalled();
});
it('selects only configured aliases with explicit startup rules and never replays startup bytes',async()=>{
 const f=fixture();expect(await(await f.post('startup',{})).json()).toEqual({aliases:[]});f.rule();expect(await(await f.post('startup',{})).json()).toEqual({aliases:[{alias:'API_TOKEN'}]});expect(f.source.read).not.toHaveBeenCalled();const response=await f.post('read',{kind:'startup',alias:'API_TOKEN'});expect(response.status).toBe(200);expect(await response.text()).toBe('PRIVATE_SOURCE_VALUE');expect((await f.post('read',{kind:'startup',alias:'API_TOKEN'})).status).toBe(409);expect((await f.post('read',{kind:'startup',alias:'OTHER'})).status).toBe(403);
});
it('hands the configured repository secret only to the assigned starting worker before build',async()=>{
 const f=fixture();f.rule('REPO');const input={kind:'repository',job:'build'};for(const credential of [raw.body,raw.owner,raw.foreign,raw.agent])expect((await f.post('read',input,credential)).status).toBe(403);
 expect((await f.post('read',{...input,secret:'TOKEN'},raw.runner)).status).toBe(400);const response=await f.post('read',input,raw.runner);expect(response.status).toBe(200);const use=response.headers.get('x-loom-secret-use')!;expect(f.source.read).toHaveBeenCalledExactlyOnceWith('REPO');expect((await f.post('confirm',{use,job:'build'},raw.runner)).status).toBe(200);expect(f.db.select().from(secretUses).get()).toMatchObject({job:'build',secret:'REPO',state:'released'});
 expect((await f.post('read',input,raw.runner)).status).toBe(409);expect((await f.post('read',{kind:'repository',job:'body'},raw.runner)).status).toBe(403);
});
it('returns no repository input for a public repository and refuses changed claimed house metadata',async()=>{
 const f=fixture();f.db.update(agentRunSettings).set({repositorySecret:null}).run();expect((await f.post('read',{kind:'repository',job:'build'},raw.runner)).status).toBe(204);f.db.update(agentRunSettings).set({repositorySecret:'REPO',houseRepository:'changed'}).run();expect((await f.post('read',{kind:'repository',job:'build'},raw.runner)).status).toBe(403);expect(f.source.read).not.toHaveBeenCalled();
});
it('refuses confirmation before dispatch completes and refuses another body confirmation',async()=>{
 const f=fixture();f.grant();let release!:(bytes:Buffer)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});f.source.read.mockImplementation(()=>{entered();return new Promise(resolve=>{release=resolve;});});const pending=f.post('read',{kind:'request',id:randomUUID(),secret:'TOKEN'});await started;const use=f.db.select().from(secretUses).get()!.id;expect((await f.post('confirm',{use})).status).toBe(409);expect((await f.post('confirm',{use},raw.other)).status).toBe(403);release(Buffer.from('PRIVATE_SOURCE_VALUE'));const response=await pending;expect(response.status).toBe(200);expect((await f.post('confirm',{use})).status).toBe(200);
});
it('rechecks grants after the holder await, erases rejected bytes and never replays a failed attempt',async()=>{
 const f=fixture();f.grant();let release!:(bytes:Buffer)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});f.source.read.mockImplementation(()=>{entered();return new Promise(resolve=>{release=resolve;});});const input={kind:'request',id:randomUUID(),secret:'TOKEN'},pending=f.post('read',input);await started;f.root.writes.run(()=>f.db.delete(secretGrants).run());const bytes=Buffer.from('PRIVATE_SOURCE_VALUE');release(bytes);const response=await pending;expect(response.status).toBe(503);expect(bytes.every(byte=>byte===0)).toBe(true);expect(f.db.select().from(secretUses).get()?.state).toBe('failed');f.grant();expect((await f.post('read',input)).status).toBe(409);expect(f.source.read).toHaveBeenCalledOnce();
});
it('bounds holder acquisition and erases a late value after root close and SQLite close',async()=>{
 const f=fixture();f.grant();let release!:(bytes:Buffer)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});f.source.read.mockImplementation(()=>{entered();return new Promise(resolve=>{release=resolve;});});const pending=f.post('read',{kind:'request',id:randomUUID(),secret:'TOKEN'});await started;const closing=f.root.close();f.clock.advance(5000);await closing;await pending;f.client.close();const bytes=Buffer.from('PRIVATE_SOURCE_VALUE');release(bytes);await f.source.read.mock.results[0].value;await Promise.resolve();expect(bytes.every(byte=>byte===0)).toBe(true);
});

it('the recipient client receives and confirms real body and pre-build inputs without common value receipts',async()=>{
 const f=fixture();f.grant();f.rule('REPO');const fetch=vi.fn<typeof globalThis.fetch>((url,options)=>f.root.http.request(String(url),options));const abort=new AbortController();
 const body=privateSecretClient({url:'https://loom.test',token:raw.body,signal:abort.signal,clock:f.clock,fetch}),worker=privateSecretClient({url:'https://loom.test',token:raw.runner,signal:abort.signal,clock:f.clock,fetch});
 try{const value=await body.granted('TOKEN');expect(value.toString()).toBe('PRIVATE_SOURCE_VALUE');value.fill(0);const repo=await worker.repository('build');expect(repo?.toString()).toBe('PRIVATE_SOURCE_VALUE');repo?.fill(0);expect(f.db.select().from(secretUses).all().map(row=>row.state)).toEqual(['released','released']);expect(f.client.serialize().includes(Buffer.from('PRIVATE_SOURCE_VALUE'))).toBe(false);for(const [,options] of fetch.mock.calls)expect(options?.body).not.toContain('PRIVATE_SOURCE_VALUE');}finally{body.close();worker.close();}
});
it('the startup recipient erases already-confirmed buffers when a later input fails',async()=>{
 const f=fixture();f.rule();f.rule('REPO');f.db.insert(agentHouseSecrets).values({agent:'art',alias:'Z_REPO',secret:'REPO'}).run();const original=f.source.read.getMockImplementation()!;f.source.read.mockImplementation(async name=>{if(name==='REPO')throw Error('PRIVATE source diagnostic');return original(name);});
 const values:Buffer[]=[],concat=Buffer.concat;const spy=vi.spyOn(Buffer,'concat').mockImplementation((list,total)=>{const result=concat(list,total);if(result.toString()==='PRIVATE_SOURCE_VALUE')values.push(result);return result;});const recipient=privateSecretClient({url:'https://loom.test',token:raw.body,signal:new AbortController().signal,clock:f.clock,fetch:(url,options)=>f.root.http.request(String(url),options)});
 try{await expect(recipient.startup()).rejects.toThrow(/^Private secret input unavailable$/);expect(values.length).toBeGreaterThan(0);expect(values.every(bytes=>bytes.every(byte=>byte===0))).toBe(true);expect(f.db.select().from(secretUses).all().map(row=>row.state)).toEqual(['released','failed']);}finally{recipient.close();spy.mockRestore();}
});
it('recipient close erases bytes waiting for an uncertain metadata confirmation and returns no value',async()=>{
 const f=fixture();f.grant();let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});const values:Buffer[]=[],concat=Buffer.concat;const spy=vi.spyOn(Buffer,'concat').mockImplementation((list,total)=>{const result=concat(list,total);if(result.toString()==='PRIVATE_SOURCE_VALUE')values.push(result);return result;});
 const recipient=privateSecretClient({url:'https://loom.test',token:raw.body,signal:new AbortController().signal,clock:f.clock,fetch:(url,options)=>{if(String(url).endsWith('/confirm')){entered();return new Promise<Response>(()=>{});}return f.root.http.request(String(url),options);}});
 try{const pending=recipient.granted('TOKEN'),refused=expect(pending).rejects.toThrow(/^Private secret input unavailable$/);await started;expect(values.some(bytes=>bytes.some(byte=>byte!==0))).toBe(true);recipient.close();expect(values.every(bytes=>bytes.every(byte=>byte===0))).toBe(true);await refused;expect(f.db.select().from(secretUses).get()?.state).toBe('started');expect(f.source.read).toHaveBeenCalledOnce();}finally{recipient.close();spy.mockRestore();}
});
