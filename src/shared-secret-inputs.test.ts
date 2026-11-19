import {testProgramPin} from './runtime/pinned-program.fixture.js';
import {DataLive} from './core/data/live.js';
import {httpWorkerControl} from './runtime/worker-http.js';
import {SecretPrivateInputs} from './pieces/secrets/private-inputs.js';
import {privateSecretClient} from './pieces/secrets/private-client.js';
import Database from 'better-sqlite3';
import {createHash,randomUUID} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {createDataSchema} from './core/data/database.js';
import {FakeClock} from './core/clock.js';
import {members,memberAgents,agents,boxes,jobs,programFirings,triggers,secrets,secretChanges,secretUses,secretGrants,tokens,sessions,agentRunSettings,agentHouseSecrets,secretWriteJournal,secretRequests,inbox} from './core/data/schema.js';
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
 const f=fixture();f.grant();let release!:(bytes:Awaited<ReturnType<typeof f.source.read>>)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});f.source.read.mockImplementation(()=>{entered();return new Promise(resolve=>{release=resolve;});});const pending=f.post('read',{kind:'request',id:randomUUID(),secret:'TOKEN'});await started;const use=f.db.select().from(secretUses).get()!.id;expect((await f.post('confirm',{use})).status).toBe(409);expect((await f.post('confirm',{use},raw.other)).status).toBe(403);release(Buffer.from('PRIVATE_SOURCE_VALUE'));const response=await pending;expect(response.status).toBe(200);expect((await f.post('confirm',{use})).status).toBe(200);
});
it('rechecks grants after the holder await, erases rejected bytes and never replays a failed attempt',async()=>{
 const f=fixture();f.grant();let release!:(bytes:Awaited<ReturnType<typeof f.source.read>>)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});f.source.read.mockImplementation(()=>{entered();return new Promise(resolve=>{release=resolve;});});const input={kind:'request',id:randomUUID(),secret:'TOKEN'},pending=f.post('read',input);await started;f.root.writes.run(()=>f.db.delete(secretGrants).run());const bytes=Buffer.from('PRIVATE_SOURCE_VALUE');release(bytes);const response=await pending;expect(response.status).toBe(503);expect(bytes.every(byte=>byte===0)).toBe(true);expect(f.db.select().from(secretUses).get()?.state).toBe('failed');f.grant();expect((await f.post('read',input)).status).toBe(409);expect(f.source.read).toHaveBeenCalledOnce();
});
it('bounds holder acquisition and erases a late value after root close and SQLite close',async()=>{
 const f=fixture();f.grant();let release!:(bytes:Awaited<ReturnType<typeof f.source.read>>)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});f.source.read.mockImplementation(()=>{entered();return new Promise(resolve=>{release=resolve;});});const pending=f.post('read',{kind:'request',id:randomUUID(),secret:'TOKEN'});await started;const closing=f.root.close();f.clock.advance(5000);await closing;await pending;f.client.close();const bytes=Buffer.from('PRIVATE_SOURCE_VALUE');release(bytes);await f.source.read.mock.results[0].value;await Promise.resolve();expect(bytes.every(byte=>byte===0)).toBe(true);
});

it('the recipient client receives and confirms real body and pre-build inputs without common value receipts',async()=>{
 const f=fixture();f.grant();f.rule('REPO');const fetch=vi.fn<typeof globalThis.fetch>(async(url,options)=>f.root.http.request(String(url),options));const abort=new AbortController();
 const body=privateSecretClient({url:'https://loom.test',token:raw.body,signal:abort.signal,clock:f.clock,fetch}),worker=privateSecretClient({url:'https://loom.test',token:raw.runner,signal:abort.signal,clock:f.clock,fetch});
 try{const value=await body.granted('TOKEN');expect(value.toString()).toBe('PRIVATE_SOURCE_VALUE');value.fill(0);const repo=await worker.repository('build');expect(repo?.toString()).toBe('PRIVATE_SOURCE_VALUE');repo?.fill(0);expect(f.db.select().from(secretUses).all().map(row=>row.state)).toEqual(['released','released']);expect(f.client.serialize().includes(Buffer.from('PRIVATE_SOURCE_VALUE'))).toBe(false);for(const [,options] of fetch.mock.calls)expect(options?.body).not.toContain('PRIVATE_SOURCE_VALUE');}finally{body.close();worker.close();}
});
it('the startup recipient erases already-confirmed buffers when a later input fails',async()=>{
 const f=fixture();f.rule();f.rule('REPO');f.db.insert(agentHouseSecrets).values({agent:'art',alias:'Z_REPO',secret:'REPO'}).run();const original=f.source.read.getMockImplementation()!;f.source.read.mockImplementation(async name=>{if(name==='REPO')throw Error('PRIVATE source diagnostic');return original(name);});
 const values:Buffer[]=[],concat=Buffer.concat;const spy=vi.spyOn(Buffer,'concat').mockImplementation((list,total)=>{const result=concat(list,total);if(result.toString()==='PRIVATE_SOURCE_VALUE')values.push(result);return result;});const recipient=privateSecretClient({url:'https://loom.test',token:raw.body,signal:new AbortController().signal,clock:f.clock,fetch:async(url,options)=>f.root.http.request(String(url),options)});
 try{await expect(recipient.startup()).rejects.toThrow(/^Private secret input unavailable$/);expect(values.length).toBeGreaterThan(0);expect(values.every(bytes=>bytes.every(byte=>byte===0))).toBe(true);expect(f.db.select().from(secretUses).all().map(row=>row.state)).toEqual(['released','failed']);}finally{recipient.close();spy.mockRestore();}
});
it('recipient close erases bytes waiting for an uncertain metadata confirmation and returns no value',async()=>{
 const f=fixture();f.grant();let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});const values:Buffer[]=[],concat=Buffer.concat;const spy=vi.spyOn(Buffer,'concat').mockImplementation((list,total)=>{const result=concat(list,total);if(result.toString()==='PRIVATE_SOURCE_VALUE')values.push(result);return result;});
 const recipient=privateSecretClient({url:'https://loom.test',token:raw.body,signal:new AbortController().signal,clock:f.clock,fetch:async(url,options)=>{if(String(url).endsWith('/confirm')){entered();return new Promise<Response>(()=>{});}return f.root.http.request(String(url),options);}});
 try{const pending=recipient.granted('TOKEN'),refused=expect(pending).rejects.toThrow(/^Private secret input unavailable$/);await started;expect(values.some(bytes=>bytes.some(byte=>byte!==0))).toBe(true);recipient.close();expect(values.every(bytes=>bytes.every(byte=>byte===0))).toBe(true);await refused;expect(f.db.select().from(secretUses).get()?.state).toBe('started');expect(f.source.read).toHaveBeenCalledOnce();}finally{recipient.close();spy.mockRestore();}
});

it.each(['expiry','prepared','token','job','alias','repository'] as const)('rejects %s drift across the holder await and erases returned bytes',async drift=>{
 const f=fixture();f.grant();f.rule();f.rule('REPO');let release!:(bytes:Awaited<ReturnType<typeof f.source.read>>)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});f.source.read.mockImplementation(()=>{entered();return new Promise(resolve=>{release=resolve;});});
 const input=drift==='alias'?{kind:'startup',alias:'API_TOKEN'}:drift==='repository'?{kind:'repository',job:'build'}:{kind:'request',id:randomUUID(),secret:'TOKEN'};
 const pending=f.post('read',input,drift==='repository'?raw.runner:raw.body);await started;
 f.root.writes.run(()=>{
  if(drift==='expiry')f.db.update(secretGrants).set({expiresAt:new Date(f.clock.now()).toISOString()}).run();
  if(drift==='prepared')f.db.insert(secretWriteJournal).values({id:randomUUID(),secret:'TOKEN',member:'owner',inputHash:'synthetic',operation:'replace',state:'prepared',startedAt:new Date(f.clock.now()).toISOString()}).run();
  if(drift==='token')f.db.update(tokens).set({revokedAt:new Date(f.clock.now()).toISOString()}).where(eq(tokens.fingerprint,hash(raw.body))).run();
  if(drift==='job')f.db.update(jobs).set({state:'done'}).where(eq(jobs.id,'body')).run();
  if(drift==='alias')f.db.update(agentHouseSecrets).set({secret:'REPO'}).run();
  if(drift==='repository')f.db.update(agentRunSettings).set({houseBranch:'changed'}).run();
 });const bytes=Buffer.from('PRIVATE_SOURCE_VALUE');release(bytes);expect((await pending).status).toBe(503);expect(bytes.every(byte=>byte===0)).toBe(true);expect(f.db.select().from(secretUses).get()?.state).toBe('failed');
});
it('an attempt id cannot be reused for a different secret even with both grants',async()=>{
 const f=fixture();f.grant();f.grant('REPO');const id=randomUUID();expect((await f.post('read',{kind:'request',id,secret:'TOKEN'})).status).toBe(200);expect((await f.post('read',{kind:'request',id,secret:'REPO'})).status).toBe(409);expect(f.source.read).toHaveBeenCalledOnce();
});
it('does not confirm a captured handoff after its five minute eligibility expires',async()=>{
 const f=fixture();f.grant();const response=await f.post('read',{kind:'request',id:randomUUID(),secret:'TOKEN'}),use=response.headers.get('x-loom-secret-use');expect(response.status).toBe(200);f.clock.advance(300000);expect(()=>f.root.services.secrets.inputs.confirm('body',use!,()=>true)).toThrow('Private secret input unavailable');expect(f.db.select().from(secretUses).get()?.state).toBe('started');
});

it('refuses dispatch inside an outer transaction before reading or writing an audit',async()=>{
 const f=fixture();f.grant();let pending!:Promise<unknown>;
 f.db.transaction(()=>{pending=f.root.services.secrets.inputs.dispatch({job:'body',secret:'TOKEN',attempt:'synthetic',standing:()=>true},()=>true,()=>undefined);});
 await expect(pending).rejects.toThrow('Private secret input unavailable');expect(f.source.read).not.toHaveBeenCalled();expect(f.db.select().from(secretUses).all()).toEqual([]);
});
it('a restarted engine cannot confirm or redispatch an earlier unconfirmed handoff',async()=>{
 const f=fixture();f.grant();const id=randomUUID(),response=await f.post('read',{kind:'request',id,secret:'TOKEN'}),use=response.headers.get('x-loom-secret-use')!;expect(response.status).toBe(200);
 const restarted=new SecretPrivateInputs(f.db,f.clock,f.source,write=>f.root.writes.run(write).value);
 try{expect(()=>restarted.confirm('body',use,()=>true)).toThrow('Private secret input unavailable');await expect(restarted.dispatch({job:'body',secret:'TOKEN',attempt:'request:'+id,standing:()=>true},()=>true,()=>undefined)).rejects.toThrow('Private secret input unavailable');expect(f.source.read).toHaveBeenCalledOnce();expect(f.db.select().from(secretUses).get()?.state).toBe('started');}finally{await restarted.close();}
});
it('a configured repository and house alias alone never grant its credential',async()=>{
 const f=fixture();expect((await f.post('read',{kind:'repository',job:'build'},raw.runner)).status).toBe(403);expect(f.source.read).not.toHaveBeenCalled();expect(f.db.select().from(secretUses).all()).toEqual([]);
});

it('the actual HTTP worker control receives and acknowledges the configured pre-build credential',async()=>{
 const f=fixture();f.rule('REPO');const fetch=vi.fn<typeof globalThis.fetch>(async(url,options)=>f.root.http.request(String(url),options));const signal=new AbortController().signal;
 const control=httpWorkerControl({url:'https://loom.test',token:raw.runner,signal,timeoutMs:30000,fetch});
 const bytes=await control.repositoryInput!('build',signal);expect(Buffer.from(bytes!).toString()).toBe('PRIVATE_SOURCE_VALUE');bytes!.fill(0);expect(f.db.select().from(secretUses).get()).toMatchObject({job:'build',secret:'REPO',state:'released'});expect(fetch.mock.calls.map(([url])=>String(url))).toEqual(['https://loom.test/api/secrets/private/read','https://loom.test/api/secrets/private/confirm']);
});

it('a general grant cannot substitute for repository startup permission or undo its revocation',async()=>{
 const f=fixture();f.grant('REPO','build');expect((await f.post('read',{kind:'repository',job:'build'},raw.runner)).status).toBe(403);f.rule('REPO');const [grant]=f.root.services.secrets.inputs.repositoryGrant('build','REPO');f.root.writes.run(()=>f.root.services.secrets.requests.revoke(grant.request!));expect((await f.post('read',{kind:'repository',job:'build'},raw.runner)).status).toBe(403);expect(f.source.read).not.toHaveBeenCalled();
});

it.each([true,false])('the repository recipient waits on one real Inbox answer before build (allow=%s)',async allow=>{
 const f=fixture();f.root.writes.run(()=>f.root.services.secrets.requests.setRule({secret:'REPO',answer:'ask',minutes:5,agents:[{agent:'art',when:'at_start'}]}));
 let entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;});
 const fetch=vi.fn<typeof globalThis.fetch>(async(url,options)=>{const response=await f.root.http.request(String(url),options);if(response.status===423)entered();return response;});
 const recipient=privateSecretClient({url:'https://loom.test',token:raw.runner,signal:new AbortController().signal,clock:f.clock,fetch});
 try{const pending=recipient.repository('build');const outcome=pending.then(value=>({value,error:false}),()=>({value:undefined,error:true}));await waiting;for(let i=0;i<12;i++)await Promise.resolve();expect(f.source.read).not.toHaveBeenCalled();expect(f.db.select().from(secretUses).all()).toEqual([]);
 const request=f.root.services.secrets.inputs.requests.grantAtStart('build',undefined,true,'repository');expect(request).toEqual([]);
 const id='q-repo-'+createHash('sha256').update(JSON.stringify(['build','REPO'])).digest('hex');f.root.writes.run(()=>f.root.services.secrets.requests.answer(id,'owner',allow));f.clock.advance(1000);
 const result=await outcome;expect(result.error).toBe(!allow);if(allow){expect(result.value?.toString()).toBe('PRIVATE_SOURCE_VALUE');result.value?.fill(0);expect(f.source.read).toHaveBeenCalledOnce();}else expect(f.source.read).not.toHaveBeenCalled();expect(fetch.mock.calls.filter(([url])=>String(url).endsWith('/read'))).toHaveLength(2);
 }finally{recipient.close();}
});

it('an unrelated grant cannot substitute for revoked alias startup permission across holder IO',async()=>{
 const f=fixture();f.grant();f.rule();const [grant]=f.root.writes.run(()=>f.root.services.secrets.requests.grantAtStart('body')).value;let entered!:()=>void,release!:(bytes:Awaited<ReturnType<typeof f.source.read>>)=>void;const started=new Promise<void>(resolve=>{entered=resolve;});f.source.read.mockImplementation(()=>{entered();return new Promise(resolve=>{release=resolve;});});const pending=f.post('read',{kind:'startup',alias:'API_TOKEN'});await started;f.root.writes.run(()=>f.root.services.secrets.requests.revoke(grant.request!));const bytes=Buffer.from('PRIVATE_SOURCE_VALUE');release(bytes);expect((await pending).status).toBe(503);expect(bytes.every(byte=>byte===0)).toBe(true);expect(f.root.services.secrets.requests.grantFor('TOKEN','art','body')).toBeDefined();
});
it('an empty repository never reads a configured secret or issues startup consent',async()=>{
 const f=fixture();f.db.update(jobs).set({houseRepository:''}).where(eq(jobs.id,'build')).run();f.db.update(agentRunSettings).set({houseRepository:''}).run();f.rule('REPO');expect((await f.post('read',{kind:'repository',job:'build'},raw.runner)).status).toBe(204);expect(f.source.read).not.toHaveBeenCalled();expect(f.db.select().from(secretGrants).all()).toEqual([]);
});
it('bounds unconfirmed handoffs and frees capacity only after confirmation or expiry',async()=>{
 const f=fixture();f.grant();f.source.read.mockImplementation(async()=>Buffer.from('X'));const engine=f.root.services.secrets.inputs;let first='';
 for(let i=0;i<4096;i++){const id=await engine.dispatch({job:'body',secret:'TOKEN',attempt:'capacity-'+i,standing:()=>true},()=>true,id=>id);if(!i)first=id;}
 await expect(engine.dispatch({job:'body',secret:'TOKEN',attempt:'over-cap',standing:()=>true},()=>true,id=>id)).rejects.toThrow('Private secret input unavailable');expect(f.source.read).toHaveBeenCalledTimes(4096);
 engine.confirm('body',first,()=>true);await expect(engine.dispatch({job:'body',secret:'TOKEN',attempt:'freed',standing:()=>true},()=>true,id=>id)).resolves.toMatch(/^use-input-/);
});

it.each([true,false])('startup waits for its configured pending consent before any value read (allow=%s)',async allow=>{
 const f=fixture();f.rule();f.db.insert(agentHouseSecrets).values({agent:'art',alias:'REPO_ALIAS',secret:'REPO'}).run();f.root.writes.run(()=>f.root.services.secrets.requests.setRule({secret:'REPO',answer:'ask',minutes:5,agents:[{agent:'art',when:'at_start'}]}));
 expect(await(await f.post('startup',{})).json()).toEqual({aliases:[{alias:'API_TOKEN'}],pending:true});
 let entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;});const fetch=vi.fn<typeof globalThis.fetch>(async(url,options)=>{const response=await f.root.http.request(String(url),options);if(String(url).endsWith('/startup')&&(await response.clone().json()).pending)entered();return response;});const recipient=privateSecretClient({url:'https://loom.test',token:raw.body,signal:new AbortController().signal,clock:f.clock,fetch});
 try{const pending=recipient.startup();await waiting;for(let i=0;i<32;i++)await Promise.resolve();expect(f.source.read).not.toHaveBeenCalled();expect(f.db.select().from(secretUses).all()).toEqual([]);f.clock.advance(999);expect(fetch).toHaveBeenCalledOnce();
 const id='q-start-'+createHash('sha256').update(JSON.stringify(['body','REPO'])).digest('hex');f.root.writes.run(()=>f.root.services.secrets.requests.answer(id,'owner',allow));f.clock.advance(1);const result=await pending;expect([...result.keys()].sort()).toEqual(allow?['API_TOKEN','REPO_ALIAS']:['API_TOKEN']);for(const bytes of result.values()){expect(bytes.toString()).toBe('PRIVATE_SOURCE_VALUE');bytes.fill(0);}expect(f.source.read).toHaveBeenCalledTimes(allow?2:1);
 }finally{recipient.close();}
});

it('ignores pending startup rules for secrets absent from this house inputs',async()=>{
 const f=fixture();f.rule();f.root.writes.run(()=>f.root.services.secrets.requests.setRule({secret:'REPO',answer:'ask',minutes:5,agents:[{agent:'art',when:'at_start'}]}));expect(await(await f.post('startup',{})).json()).toEqual({aliases:[{alias:'API_TOKEN'}]});expect(f.db.select().from(secretRequests).all()).toHaveLength(1);expect(f.db.select().from(inbox).all()).toEqual([]);expect(f.source.read).not.toHaveBeenCalled();
});
it('refuses over128 configured startup aliases without issuing consent or reading values',async()=>{
 const f=fixture();f.rule();for(let i=0;i<128;i++)f.db.insert(agentHouseSecrets).values({agent:'art',alias:'ALIAS_'+i,secret:'TOKEN'}).run();expect((await f.post('startup',{})).status).toBe(503);expect(f.db.select().from(secretRequests).all()).toEqual([]);expect(f.db.select().from(secretGrants).all()).toEqual([]);expect(f.source.read).not.toHaveBeenCalled();
});
it.each(['ask','auto'] as const)('repository startup does not issue an unrelated %s rule',async answer=>{
 const f=fixture();f.rule('REPO');f.root.writes.run(()=>f.root.services.secrets.requests.setRule({secret:'TOKEN',answer,minutes:5,agents:[{agent:'art',when:'at_start'}]}));expect((await f.post('read',{kind:'repository',job:'build'},raw.runner)).status).toBe(200);expect(f.db.select().from(secretRequests).all().map(row=>row.secret)).toEqual(['REPO']);expect(f.db.select().from(secretGrants).all().map(row=>row.secret)).toEqual(['REPO']);expect(f.db.select().from(inbox).all()).toEqual([]);expect(f.source.read).toHaveBeenCalledExactlyOnceWith('REPO');
});
it.each(['revoke','expiry'] as const)('refreshes grants after pending startup consent and omits %s before any read',async change=>{
 const f=fixture();f.rule();f.db.insert(agentHouseSecrets).values({agent:'art',alias:'REPO_ALIAS',secret:'REPO'}).run();f.root.writes.run(()=>f.root.services.secrets.requests.setRule({secret:'REPO',answer:'ask',minutes:5,agents:[{agent:'art',when:'at_start'}]}));let entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;});const fetch=vi.fn<typeof globalThis.fetch>(async(url,options)=>{const response=await f.root.http.request(String(url),options);if(String(url).endsWith('/startup')&&(await response.clone().json()).pending)entered();return response;});const recipient=privateSecretClient({url:'https://loom.test',token:raw.body,signal:new AbortController().signal,clock:f.clock,fetch});
 try{const pending=recipient.startup();await waiting;for(let i=0;i<32;i++)await Promise.resolve();const grant=f.db.select().from(secretGrants).where(eq(secretGrants.secret,'TOKEN')).get()!;
 f.root.writes.run(()=>{if(change==='revoke')f.root.services.secrets.requests.revoke(grant.request!);else f.db.update(secretGrants).set({expiresAt:new Date(f.clock.now()).toISOString()}).where(eq(secretGrants.id,grant.id)).run();const id='q-start-'+createHash('sha256').update(JSON.stringify(['body','REPO'])).digest('hex');f.root.services.secrets.requests.answer(id,'owner',true);});f.clock.advance(1000);const result=await pending;expect([...result.keys()]).toEqual(['REPO_ALIAS']);for(const bytes of result.values())bytes.fill(0);expect(f.source.read).toHaveBeenCalledExactlyOnceWith('REPO');expect(f.db.select().from(secretUses).all().map(row=>row.secret)).toEqual(['REPO']);
 }finally{recipient.close();}
});
it('reads private-handoff status only for its current body through the real metadata door',async()=>{
 const f=fixture();f.grant();const response=await f.post('read',{kind:'request',id:randomUUID(),secret:'TOKEN'}),use=response.headers.get('x-loom-secret-use')!;expect(response.status).toBe(200);
 const status=async(token:string)=>f.root.http.request('http://loom/api/secrets/useStatus',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),input:{id:use}})});
 expect(await(await status(raw.body)).json()).toEqual({ok:true,value:{id:use,state:'started'}});for(const token of [raw.other,raw.agent,raw.runner,raw.owner])expect((await status(token)).status).toBe(403);
 await f.post('confirm',{use});expect(await(await status(raw.body)).json()).toEqual({ok:true,value:{id:use,state:'released'}});
});
it('publishes the private audit before source IO and never publishes an aborted insert',async()=>{
 const f=fixture();f.grant();const events:{transaction:boolean;states:string[]}[]=[],original=DataLive.prototype.changed;
 const spy=vi.spyOn(DataLive.prototype,'changed').mockImplementation(function(this:DataLive){events.push({transaction:f.client.inTransaction,states:f.db.select().from(secretUses).all().map(row=>row.state)});return original.call(this);});
 try{f.source.read.mockImplementationOnce(async()=>{expect(events).toContainEqual({transaction:false,states:['started']});return Buffer.from('PRIVATE_SOURCE_VALUE');});const response=await f.post('read',{kind:'request',id:randomUUID(),secret:'TOKEN'}),use=response.headers.get('x-loom-secret-use')!;expect(response.status).toBe(200);await f.post('confirm',{use});expect(events.some(event=>event.states.includes('released'))).toBe(true);expect(events.every(event=>!event.transaction)).toBe(true);
 events.length=0;f.client.exec("CREATE TRIGGER fail_private_audit BEFORE INSERT ON secret_uses BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");expect((await f.post('read',{kind:'request',id:randomUUID(),secret:'TOKEN'})).status).toBe(503);expect(f.source.read).toHaveBeenCalledOnce();expect(f.db.select().from(secretUses).all()).toHaveLength(1);expect(events.every(event=>event.states.every(state=>state==='released'))).toBe(true);
 }finally{spy.mockRestore();}
});

it('hands a body the agent\'s secrets whoever its work is for, and nothing once its member lost the agent',async()=>{
 const f=fixture(),read=(secret='TOKEN')=>f.post('read',{kind:'request',id:randomUUID(),secret});
 f.db.insert(members).values({id:'lee',role:'member',joinedAt:new Date(f.clock.now()).toISOString()}).run();f.db.insert(memberAgents).values({member:'lee',agent:'art'}).run();
 f.db.update(jobs).set({member:'lee'}).where(eq(jobs.id,'body')).run();
 // A grant for the agent and no one job, which an owner allowed in other work: a standing answer.
 const agentWide=f.root.writes.run(()=>{const id=randomUUID();f.root.services.secrets.requests.request({id,secret:'TOKEN',agent:'art',why:'Other work',minutes:5});f.root.services.secrets.requests.answer(id,'owner',true);return id;}).value;
 // lee is not a household owner. The secret is the agent's to use, so the standing grant serves this work too.
 expect((await read()).status).toBe(200);
 // So does a grant a rule made for this job.
 f.rule('REPO');f.root.writes.run(()=>f.root.services.secrets.requests.grantAtStart('body',['REPO']));expect(f.db.select().from(secretGrants).where(eq(secretGrants.job,'body')).get()).toMatchObject({secret:'REPO',grantedBy:'rule'});
 expect((await read('REPO')).status).toBe(200);
 f.db.delete(secretGrants).where(eq(secretGrants.job,'body')).run();
 // A secret the house is given at start by a rule is handed to the body, and nobody is asked.
 f.rule();expect(await(await f.post('startup',{})).json()).toEqual({aliases:[{alias:'API_TOKEN'}]});expect((await f.post('read',{kind:'startup',alias:'API_TOKEN'})).status).toBe(200);
 expect(f.db.select().from(inbox).where(eq(inbox.source,'secret-request')).all().filter(row=>row.state==='waiting')).toEqual([]);
 f.root.writes.run(()=>f.root.services.secrets.requests.revoke(agentWide));
 // A body whose member no longer has the agent is handed nothing and confirms nothing.
 f.db.update(jobs).set({member:'lee'}).where(eq(jobs.id,'body')).run();const use=f.db.select().from(secretUses).all().find(row=>row.state==='started')!.id;
 f.db.delete(memberAgents).where(eq(memberAgents.member,'lee')).run();
 expect((await f.post('confirm',{use})).status).toBe(403);expect((await f.post('startup',{})).status).toBe(403);expect((await f.post('read',{kind:'startup',alias:'API_TOKEN'})).status).toBe(403);
});

it('keeps what a worker was granted to fetch the repository from every body, whoever allowed it',async()=>{
 const f=fixture(),read=()=>f.post('read',{kind:'request',id:randomUUID(),secret:'REPO'});
 f.db.insert(members).values({id:'lee',role:'member',joinedAt:new Date(f.clock.now()).toISOString()}).run();f.db.insert(memberAgents).values({member:'lee',agent:'art'}).run();
 f.db.update(jobs).set({member:'lee',state:'starting'}).where(eq(jobs.id,'body')).run();
 // The rule says ask, so the worker's fetch files a card. It is the worker's and does not name the member.
 f.root.writes.run(()=>f.root.services.secrets.requests.setRule({secret:'REPO',answer:'ask',minutes:5,agents:[{agent:'art',when:'at_start'}]}));
 expect((await f.post('read',{kind:'repository',job:'body'},raw.runner)).status).toBe(423);
 const card=f.db.select().from(secretRequests).where(eq(secretRequests.job,'body')).get()!;
 expect(card.id).toBe('q-repo-'+createHash('sha256').update(JSON.stringify(['body','REPO'])).digest('hex'));
 expect(f.db.select().from(inbox).where(eq(inbox.sourceId,card.id)).get()?.words).toBe('Allow art to use REPO for 5 minutes?');
 // A household owner allows it: a grant for that very job, given by a member.
 f.root.writes.run(()=>f.root.services.secrets.requests.answer(card.id,'owner',true));
 expect(f.db.select().from(secretGrants).where(eq(secretGrants.job,'body')).get()).toMatchObject({secret:'REPO',grantedBy:'owner',request:card.id});
 expect((await f.post('read',{kind:'repository',job:'body'},raw.runner)).status).toBe(200);
 // The body of that job, working for a member who is not an owner, is not handed the secret on it.
 f.db.update(jobs).set({state:'running'}).where(eq(jobs.id,'body')).run();
 expect((await read()).status).toBe(403);
 // Nor is a body in the agent's own work: a rule that lists the agent at start does not answer what a body asks for.
 f.db.update(jobs).set({member:null}).where(eq(jobs.id,'body')).run();
 expect((await read()).status).toBe(403);expect(f.source.read).toHaveBeenCalledOnce();
 // The same secret listed for the house too is asked for apart, on its own card.
 f.db.update(jobs).set({member:'lee'}).where(eq(jobs.id,'body')).run();f.db.insert(agentHouseSecrets).values({agent:'art',alias:'REPO_TOKEN',secret:'REPO'}).run();
 expect(await(await f.post('startup',{})).json()).toEqual({aliases:[],pending:true});
 expect(f.db.select().from(inbox).where(eq(inbox.source,'secret-request')).all().filter(row=>row.state==='waiting').map(row=>row.words)).toEqual(['Allow art to use REPO for 5 minutes?']);
});

it('leaves a stored alias no body could take out of the startup plan, so the others still arrive',async()=>{
 const f=fixture();f.rule();
 for(const alias of ['deploy-key','a.b','PATH','NODE_OPTIONS'])f.db.insert(agentHouseSecrets).values({agent:'art',alias,secret:'TOKEN'}).run();
 expect(await(await f.post('startup',{})).json()).toEqual({aliases:[{alias:'API_TOKEN'}]});
 expect((await f.post('read',{kind:'startup',alias:'deploy-key'})).status).toBe(400);expect((await f.post('read',{kind:'startup',alias:'API_TOKEN'})).status).toBe(200);
});
it('hands a body working on anybody else\'s word no secret: not at start, not a standing one, not one asked for; and its owners\' body everything as before',async()=>{
 const f=fixture(),at=new Date(f.clock.now()).toISOString();
 f.db.insert(members).values({id:'lodger',role:'member',joinedAt:at}).run();
 const cv=f.root.writes.run(()=>f.root.services.conversations.open({agent:'art',venue:'slack',place:JSON.stringify(['TWORK','CROOM',null]),label:'room'})).value.id;
 f.db.update(jobs).set({conversation:cv}).where(eq(jobs.id,'body')).run();
 /** The job's mail is from this sender, and from nobody else. */
 const from=(sender:{fromKind:'person'|'unknown';fromId?:string})=>f.root.writes.run(()=>{f.db.delete(inbox).where(eq(inbox.job,'body')).run();
  const item=f.root.services.conversations.send({conversation:cv,toKind:'agent',to:'art',source:'notice',sourceId:randomUUID(),words:'Please',...sender});f.db.update(inbox).set({job:'body',state:'taken'}).where(eq(inbox.id,item.id)).run();});
 f.rule();const granted=f.grant();
 const ask=(input:unknown)=>f.root.http.request('http://loom/api/secrets/request',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+raw.body},body:JSON.stringify({id:randomUUID(),input})});
 const wanted=(scope:'agent'|'job')=>({id:randomUUID(),secret:'TOKEN',why:'Synthetic use',minutes:5,scope});
 for(const sender of [{fromKind:'unknown' as const},{fromKind:'person' as const,fromId:'lodger'}]){
  from(sender);
  expect((await f.post('startup',{})).status,sender.fromKind).toBe(403);expect((await f.post('read',{kind:'startup',alias:'API_TOKEN'})).status).toBe(403);
  // An owner's own answer for this very job is not handed over either: the job has loom's tools and nothing else.
  expect((await f.post('read',{kind:'request',id:randomUUID(),secret:'TOKEN'})).status).toBe(403);
  for(const scope of ['agent','job'] as const)expect((await ask(wanted(scope))).status,scope).toBe(403);
 }
 expect(f.source.read).not.toHaveBeenCalled();expect(f.db.select().from(secretUses).all()).toEqual([]);expect(f.db.select().from(secretRequests).all().map(row=>row.id)).toEqual([granted]);
 // The worker's own read of the repository secret is no body's, and is as it was.
 f.rule('REPO');expect((await f.post('read',{kind:'repository',job:'build'},raw.runner)).status).toBe(200);
 // The same job on its owner's word: everything it had.
 from({fromKind:'person',fromId:'owner'});
 expect(await(await f.post('startup',{})).json()).toEqual({aliases:[{alias:'API_TOKEN'}]});expect((await f.post('read',{kind:'startup',alias:'API_TOKEN'})).status).toBe(200);
 expect((await f.post('read',{kind:'request',id:randomUUID(),secret:'TOKEN'})).status).toBe(200);expect((await ask(wanted('job'))).status).toBe(200);
});

it('recognizes a worker program alias read but denies it on an ordinary build', async () => {
 const f = fixture();
 f.rule();
 expect((await f.post('read', { kind: 'program', job: 'build', alias: 'API_TOKEN' }, raw.runner)).status).toBe(403);
 expect(f.source.read).not.toHaveBeenCalled();
});

it('hands the assigned worker only the frozen program alias with its current startup grant', async () => {
 const f=fixture(), at=new Date(f.clock.now()).toISOString();
 const program={ ...testProgramPin, name:'watch',args:[],secrets:{KIT_TOKEN:'TOKEN'},timeoutMs:1000};
 f.db.insert(triggers).values({id:'watch',ownerKind:'agent',owner:'art',sourceKind:'time',times:'09:07',lifespan:'until-stopped',
  targetKind:'inbox',toKind:'agent',to:'art',enabled:true,state:'standing',note:'Watch',createdAt:at,changedAt:at,program}).run();
 f.db.update(jobs).set({startedByKind:'program',startedBy:'watch'}).where(eq(jobs.id,'build')).run();
 f.db.insert(programFirings).values({id:'watch:1',trigger:'watch',job:'build',at,program,status:'pending'}).run();
 f.db.update(jobs).set({houseRepository:program.repository}).where(eq(jobs.id,'build')).run();
 f.db.update(agentRunSettings).set({houseRepository:program.repository}).run();
 f.db.insert(agentHouseSecrets).values({agent:'art',alias:'KIT_TOKEN',secret:'REPO'}).run();
 const read=(alias:string,who=raw.runner)=>f.post('read',{kind:'program',job:'build',alias},who);
 expect((await read('KIT_TOKEN')).status).toBe(403);
 f.rule();
 expect((await read('KIT_TOKEN')).status).toBe(403);
 f.db.update(agentHouseSecrets).set({secret:'TOKEN'}).where(eq(agentHouseSecrets.alias,'KIT_TOKEN')).run();
 expect((await read('KIT_TOKEN',raw.foreign)).status).toBe(403);
 expect((await read('KIT_TOKEN',raw.body)).status).toBe(403);
 expect((await read('OTHER')).status).toBe(403);
 expect(f.source.read).not.toHaveBeenCalled();
 const control=httpWorkerControl({url:'https://loom.test',token:raw.runner,signal:new AbortController().signal,
  fetch:async(url,init)=>f.root.http.request(String(url),init)});
 const values=await control.programInputs!('build',['KIT_TOKEN'],new AbortController().signal);
 expect(values.get('KIT_TOKEN')?.toString()).toBe('PRIVATE_SOURCE_VALUE');
 for(const bytes of values.values())bytes.fill(0);
 expect((await read('KIT_TOKEN')).status).toBe(409);
 expect(f.client.serialize().includes(Buffer.from('PRIVATE_SOURCE_VALUE'))).toBe(false);
});
