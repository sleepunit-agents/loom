import Database from 'better-sqlite3';
import {eq} from 'drizzle-orm';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {getRequestListener} from '@hono/node-server';
import {WebSocket} from 'ws';
import {GraphQLString} from 'graphql/index.js';
import {afterEach,expect,it,vi} from 'vitest';
import {z} from 'zod';
import {FakeClock} from './core/clock.js';
import {createDataSchema} from './core/data/database.js';
import {members,agents,tokens,sessions,memberAgents,tasks,boxes,jobs} from './core/data/schema.js';
import {RecoveredWrite,type WriteReceipt} from './core/operations/index.js';
import {sharedRoot} from './shared-root.js';
import type {ProgramGrants} from './shared-program-access.js';
const cleanup:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const raw={program:'p'.repeat(64),other:'q'.repeat(64),sam:'s'.repeat(64),owner:'o'.repeat(64),cookie:'c'.repeat(64)},hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function fixture(hold?:()=>Promise<string>){
 const client=new Database(':memory:');cleanup.push(()=>client.close());const clock=new FakeClock(),at=new Date(clock.now()).toISOString(),db=createDataSchema(client,()=>new Date(clock.now()).toISOString());
 db.insert(members).values([{id:'owner',role:'owner',joinedAt:at},{id:'sam',role:'member',joinedAt:at}]).run();db.insert(agents).values({id:'art',about:'Agent',markBg:'#000',markFg:'#fff',faceShape:'pebble',faceEyes:'dot'}).run();db.insert(memberAgents).values({member:'sam',agent:'art'}).run();
 for(const kind of ['program','other','sam','owner'] as const)db.insert(tokens).values({fingerprint:hash(raw[kind]),label:kind,kind:'owner',member:kind==='owner'?'owner':'sam',createdAt:at}).run();
 db.insert(sessions).values({id:hash(raw.cookie),token:hash(raw.program),device:'Forbidden program browser',via:'link',isAgent:false,issuedAt:at,seenAt:at,provedAt:at}).run();
 const grants=new Map<string,ProgramGrants>([[hash(raw.program),{records:['tasks'],operations:['tasks.command']}]]);
 const root=sharedRoot({db,clock,originAllowed:()=>true,programGrants:fp=>grants.get(fp),fields:{custom:{type:GraphQLString,resolve:hold??(()=> 'Private custom words')}} ,reportError:()=>{}});cleanup.push(()=>root.close());
 root.writes.run(()=>{root.services.tasks.create({title:'Sam work',goal:'Done',why:'Fixture',owner:{kind:'agent',id:'art'}},{kind:'member',id:'owner'});root.services.tasks.create({title:'Owner private words',goal:'Done',why:'Fixture',owner:{kind:'member',id:'owner'}},{kind:'member',id:'owner'});});
 const read=(query:string,who:keyof typeof raw='program')=>root.http.request('http://loom/graphql',{method:'POST',headers:{authorization:'Bearer '+raw[who],'content-type':'application/json'},body:JSON.stringify({query})});
 const call=(operation:string,input:unknown,id='same-id',who:keyof typeof raw='program')=>root.http.request('http://loom/api/'+operation.replace('.','/'),{method:'POST',headers:{authorization:'Bearer '+raw[who],'content-type':'application/json'},body:JSON.stringify({id,input})});
 return{client,db,clock,root,grants,read,call};
}
it('limits generated records and connected/filter types while keeping the current member label policy',async()=>{
 const f=fixture();expect(await(await f.read('{ tasks { title } }')).json()).toEqual({data:{tasks:[{title:'Sam work'}]}});
 for(const query of ['{ members { id } }','{ custom }','{ account { member } }','{ householdSetup { members { id } } }','{ tasks { taskCommentsByTask { text } } }']){const answer=await(await f.read(query)).text();expect(answer).not.toContain('Owner private words');expect(JSON.parse(answer).errors).toBeDefined();}
 expect((await(await f.read('{ tasks { taskCommentsByTask { text } } }','sam')).json()).errors).toBeUndefined();
 const schema=await(await f.read('{ __schema { queryType { fields { name } } } }')).text();expect(schema).toContain('tasks');expect(schema).not.toMatch(/members|custom|account|householdSetup|taskComments/);
 expect(await(await f.read('{ custom }','sam')).json()).toEqual({data:{custom:'Private custom words'}});
});
it('requires explicit operations before effects/receipts and never turns zero grants into an ordinary member',async()=>{
 const f=fixture();const input={action:'comment',id:'t-1',text:'Program comment'};
 expect((await f.call('tasks.command',input)).status).toBe(200);
 f.grants.set(hash(raw.program),{records:[],operations:[]});
 expect((await f.call('tasks.command',input)).status).toBe(403);expect((await f.call('household.setMember',{id:'pat',role:'member',agents:[]})).status).toBe(403);
 const answer=await(await f.read('{ tasks { title } }')).json();expect(answer.errors).toBeDefined();expect(JSON.stringify(answer)).not.toContain('Sam work');
 expect(await(await f.read('{ tasks { title } }','sam')).json()).toEqual({data:{tasks:[{title:'Sam work'}]}});
});
it('denies credential ceremonies, program cookies and alternative private transports even if a grant names them',async()=>{
 const f=fixture();f.grants.set(hash(raw.program),{records:['tasks','tokens','sessions'],operations:['signin.link','signin.token','token.revoke','sessions.revoke','account.revokeSession']});
 for(const path of ['/api/signin/link','/api/signin/token','/api/token/revoke','/api/sessions/revoke','/api/account/revokeSession','/api/conversation/take','/auth/session']){const response=await f.root.http.request('http://loom'+path,{method:'POST',headers:{authorization:'Bearer '+raw.program,'content-type':'application/json'},body:'{}'});expect(response.status).toBe(403);}
 expect(f.root.credentials.authenticate(new Request('http://loom',{headers:{cookie:'loom_ui='+raw.cookie}}))).toBeUndefined();
 const auth=f.root.credentials.authenticate(new Request('http://loom',{headers:{authorization:'Bearer '+raw.program}}))!;
 expect(f.root.operations.call('http',auth.viewer,'token.revoke',{fingerprint:hash(raw.sam)},'forbidden')).toMatchObject({ok:false,code:'denied'});
});
it('isolates program receipts from ordinary tokens belonging to the same member',async()=>{
 const f=fixture();f.root.operations.register({name:'fixture.value',write:true,recheckPolicy:true,input:z.object({}).strict(),output:z.object({value:z.string()}).strict(),may:()=>true,run(ctx){return{value:f.root.credentials.program(ctx.viewer)?'Program result':'Ordinary private result'};}});
 f.grants.set(hash(raw.program),{records:[],operations:['fixture.value']});
 expect(await(await f.call('fixture.value',{},'shared','sam')).json()).toMatchObject({value:{value:'Ordinary private result'}});
 expect(await(await f.call('fixture.value',{},'shared')).json()).toMatchObject({ok:false,code:'conflict'});
 expect(await(await f.call('fixture.value',{},'program-id')).json()).toMatchObject({value:{value:'Program result'}});
 f.grants.set(hash(raw.other),{records:[],operations:['fixture.value']});
 expect(await(await f.call('fixture.value',{},'program-id','other')).json()).toMatchObject({ok:false,code:'conflict'});
 expect(await(await f.call('fixture.value',{},'program-id')).json()).toMatchObject({value:{value:'Program result'}});
});
it('rechecks grants before prepared effects and keeps trusted installed calls free of outside grants',async()=>{
 let began!:()=>void,release!:()=>void;const started=new Promise<void>(r=>began=r),held=new Promise<void>(r=>release=r);const f=fixture();let effects=0,prepares=0;
 f.root.operations.register({name:'fixture.held',write:true,recheckPolicy:true,input:z.object({}).strict(),output:z.object({saved:z.literal(true)}),may:()=>true,prepare:async()=>{prepares++;began();await held;},run(){effects++;return{saved:true};}});
 expect((await f.call('fixture.held',{})).status).toBe(403);expect(prepares).toBe(0);
 f.grants.set(hash(raw.program),{records:[],operations:['fixture.held']});const pending=f.call('fixture.held',{});await started;f.grants.set(hash(raw.program),{records:[],operations:[]});release();expect((await pending).status).toBe(403);expect(effects).toBe(0);
 expect(await f.root.operations.internal('fixture').callAsync('fixture.held',{},'trusted')).toMatchObject({ok:true});expect(effects).toBe(1);
});
it('withdraws a retained live selection on grant change without waiting for a data epoch',async()=>{
 const f=fixture(),server=createServer(getRequestListener(request=>f.root.http.fetch(request))),detach=f.root.attach(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));cleanup.push(async()=>{detach();await f.root.close();await new Promise<void>(r=>server.close(()=>r()));});const address=server.address();if(!address||typeof address==='string')throw Error('No port');
 const ws=new WebSocket('ws://127.0.0.1:'+address.port+'/graphql','graphql-transport-ws',{headers:{authorization:'Bearer '+raw.program}});cleanup.push(()=>ws.terminate());await once(ws,'open');let next=once(ws,'message');ws.send(JSON.stringify({type:'connection_init'}));await next;
 next=once(ws,'message');ws.send(JSON.stringify({type:'subscribe',id:'tasks',payload:{query:'subscription { observe(query:"{ tasks { title } }") { patches { path value } } }'}}));expect(String((await next)[0])).toContain('Sam work');
 const pushed:string[]=[];ws.on('message',frame=>pushed.push(String(frame)));
 const closed=once(ws,'close');f.grants.set(hash(raw.program),{records:[],operations:[]});f.root.writes.run(()=>f.db.update(tasks).set({title:'Withdrawn words'}).run());expect((await closed)[0]).toBe(4403);expect(pushed.join(' ')).not.toContain('Withdrawn words');
});

it('withdraws both lazy HTTP response branches after a direct grant edit',async()=>{
 const f=fixture(),response=await f.read('{ tasks { title } }'),copy=response.clone();
 f.grants.set(hash(raw.program),{records:[],operations:[]});
 await expect(response.text()).rejects.toThrow('Data access ended');await expect(copy.text()).rejects.toThrow('Data access ended');
});
it('withdraws an ordinary in-flight token when an owner first marks it as a restricted program',async()=>{
 const f=fixture(),response=await f.read('{ custom }','sam');
 f.grants.set(hash(raw.sam),{records:[],operations:[]});
 await expect(response.text()).rejects.toThrow('Data access ended');
 expect((await(await f.read('{ custom }','sam')).json()).errors).toBeDefined();
});

it('refuses valid agent/body/runner credentials marked as programs, and rejects forged equal Viewers',()=>{
 const f=fixture(),at=new Date(f.clock.now()).toISOString();
 f.db.insert(boxes).values({id:'box',name:'Box',owner:'sam',sameMachineAsLoom:false,hostsAny:false,reportOnly:false,alwaysOn:false,enrolledAt:at}).run();
 f.db.insert(jobs).values({id:'body',agent:'art',box:'box',title:'Body',state:'running',brief:'',model:'fixture',startedByKind:'member',startedBy:'sam',houseRepository:'fixture',houseFile:'HOUSE.md',houseBranch:'next',queuedAt:at}).run();
 for(const value of [{kind:'agent',agent:'art',box:null,job:null},{kind:'agent',agent:'art',box:null,job:'body'},{kind:'runner',agent:null,box:'box',job:null}]){
  f.client.prepare('UPDATE tokens SET kind=?,member=NULL,agent=?,box=?,job=? WHERE fingerprint=?').run(value.kind,value.agent,value.box,value.job,hash(raw.program));
  f.grants.delete(hash(raw.program));expect(f.root.credentials.authenticate(new Request('http://loom',{headers:{authorization:'Bearer '+raw.program}}))?.viewer.kind).toBe(value.kind);
  f.grants.set(hash(raw.program),{records:[],operations:[]});expect(f.root.credentials.authenticate(new Request('http://loom',{headers:{authorization:'Bearer '+raw.program}}))).toBeUndefined();
 }
 f.client.prepare("UPDATE tokens SET kind='owner',member='sam',agent=NULL,box=NULL,job=NULL WHERE fingerprint=?").run(hash(raw.program));f.grants.set(hash(raw.program),{records:['tasks'],operations:['tasks.command']});
 const auth=f.root.credentials.authenticate(new Request('http://loom',{headers:{authorization:'Bearer '+raw.program}}))!;expect(f.root.credentials.allows(auth.viewer,'tasks.command')).toBe(true);
 const forged={...auth.viewer};expect(f.root.credentials.allows(forged,'tasks.command')).toBe(false);expect(f.root.credentials.program(forged)).toBeUndefined();
 expect(f.root.operations.call('http',forged,'tasks.command',{action:'comment',id:'t-1',text:'Forged'},'forged')).toMatchObject({ok:false,code:'denied'});
});
it('preserves canonical principal identity for durable prepared-write recovery while binding receipt hashes to the program',async()=>{
 const f=fixture();let journal:Readonly<WriteReceipt>|undefined,recovered=false,prepares=0;
 f.grants.set(hash(raw.program),{records:[],operations:['fixture.journal']});
 f.root.operations.register({name:'fixture.journal',write:true,recheckPolicy:true,input:z.object({}).strict(),output:z.object({saved:z.literal(true)}),inputHash:()=> 'private-input-fingerprint',may:viewer=>viewer.kind==='member',
  admit(ctx){journal=ctx.receipt;},prepare:async()=>{prepares++;throw Error('Fictitious holder committed, reply lost');},run(){throw Error('Must reconcile rather than repeat');},
  recover(ctx){if(!journal||recovered||ctx.receipt?.id!==journal.id||ctx.receipt.inputHash!==journal.inputHash)return;expect(ctx.receipt.viewer).toBe(JSON.stringify({id:'sam',kind:'member'}));recovered=true;return new RecoveredWrite({saved:true},journal.expires);},
 });
 expect((await f.call('fixture.journal',{},'journal')).status).toBe(503);expect(journal?.inputHash).not.toBe('private-input-fingerprint');expect(journal?.viewer).toBe(JSON.stringify({id:'sam',kind:'member'}));
 expect(f.root.operations.recoverWrite({kind:'member',id:'sam'},journal!)).toMatchObject({ok:true,value:{saved:true}});
 expect(await(await f.call('fixture.journal',{},'journal')).json()).toMatchObject({ok:true,value:{saved:true}});expect(prepares).toBe(1);
 expect(await(await f.call('fixture.journal',{},'journal','sam')).json()).toMatchObject({ok:false,code:'conflict'});
});
it('rechecks receipt replay inside its transaction even if a synchronous hashing hook withdraws the grant',async()=>{
 const f=fixture();let withdraw=false,effects=0;
 f.grants.set(hash(raw.program),{records:[],operations:['fixture.replay']});
 f.root.operations.register({name:'fixture.replay',write:true,recheckPolicy:true,input:z.object({}).strict(),output:z.object({saved:z.literal(true)}),may:()=>true,inputHash:()=>{if(withdraw)f.grants.set(hash(raw.program),{records:[],operations:[]});return 'same';},run(){effects++;return{saved:true};}});
 const viewer=f.root.credentials.authenticate(new Request('http://loom',{headers:{authorization:'Bearer '+raw.program}}))!.viewer;
 expect(f.root.operations.call('http',viewer,'fixture.replay',{},'replay')).toMatchObject({ok:true});withdraw=true;
 expect(f.root.operations.call('http',viewer,'fixture.replay',{},'replay')).toMatchObject({ok:false,code:'denied'});expect(effects).toBe(1);
});
it('does not begin prepared IO when post-commit admission observers withdraw its grant',async()=>{
 const f=fixture();let prepares=0;
 f.grants.set(hash(raw.program),{records:[],operations:['fixture.io']});
 f.root.operations.register({name:'fixture.io',write:true,recheckPolicy:true,input:z.object({}).strict(),output:z.object({saved:z.literal(true)}),may:()=>true,prepare:async()=>{prepares++;},run(){return{saved:true};},
  // Observers hear of a commit that wrote something: the admission reserves its work with a row.
  admit(){f.db.update(members).set({joinedAt:new Date().toISOString()}).where(eq(members.id,'sam')).run();},recover:()=>undefined});
 const stop=f.root.writes.observe(()=>f.grants.set(hash(raw.program),{records:[],operations:[]}));
 try{expect((await f.call('fixture.io',{},'io')).status).toBe(403);expect(prepares).toBe(0);}finally{stop();}
});

it('leaves rejected/unrelated ordinary requests untouched and authenticates an ordinary query only once',async()=>{
 const f=fixture(),initial=f.db.select().from(sessions).get()!.seenAt;f.db.update(sessions).set({token:hash(raw.sam)}).run();f.clock.advance(1000);
 const authenticate=vi.spyOn(f.root.credentials,'authenticate');
 try{
  const headers={authorization:'Bearer '+raw.sam,'content-type':'application/json',origin:'https://other.example'};
  expect((await f.root.http.request('http://loom/api/tasks/command',{method:'POST',headers,body:'{}'})).status).toBe(403);
  expect((await f.root.http.request('http://loom/api/tasks/command',{method:'POST',headers:{authorization:'Bearer '+raw.sam,'content-type':'text/plain'},body:'{}'})).status).toBe(415);
  expect((await f.root.http.request('http://loom/not-a-route',{headers:{cookie:'loom_ui='+raw.cookie}})).status).toBe(404);
  expect(authenticate).not.toHaveBeenCalled();expect(f.db.select().from(tokens).where(eq(tokens.fingerprint,hash(raw.sam))).get()?.lastUsedAt).toBeNull();expect(f.db.select().from(sessions).get()?.seenAt).toBe(initial);
  expect((await(await f.read('{ tasks { title } }','sam')).json()).errors).toBeUndefined();expect(authenticate).toHaveBeenCalledOnce();
 }finally{authenticate.mockRestore();}
});
it('cannot enter a credential ceremony if the owner restricts its token while the request body is awaited',async()=>{
 const f=fixture();let began!:()=>void,release!:()=>void;const started=new Promise<void>(r=>began=r),held=new Promise<void>(r=>release=r);
 const body=new ReadableStream<Uint8Array>({async pull(controller){began();await held;controller.enqueue(new TextEncoder().encode(JSON.stringify({kind:'owner',member:'sam',label:'Forbidden new bearer'})));controller.close();}},{highWaterMark:0});
 const pending=f.root.http.request(new Request('http://loom/api/signin/token',{method:'POST',headers:{authorization:'Bearer '+raw.owner,'content-type':'application/json'},body,duplex:'half'} as RequestInit));
 await started;f.grants.set(hash(raw.owner),{records:[],operations:['signin.token']});release();
 expect((await pending).status).toBe(403);expect(f.db.select().from(tokens).all().some(row=>row.label==='Forbidden new bearer')).toBe(false);expect(f.db.select().from(tokens).where(eq(tokens.fingerprint,hash(raw.owner))).get()?.lastUsedAt).toBeNull();
});

it('ignores unsupported private table grants while continuing to serve the supported subset',async()=>{
 const f=fixture();f.grants.set(hash(raw.program),{records:['tasks','tokens','sessions'],operations:[]});
 expect(await(await f.read('{ tasks { title } }')).json()).toEqual({data:{tasks:[{title:'Sam work'}]}});
 for(const query of ['{ tokens { fingerprint } }','{ sessions { id } }'])expect((await(await f.read(query)).json()).errors).toBeDefined();
 const schema=await(await f.read('{ __schema { queryType { fields { name } } } }')).json();expect(schema.errors).toBeUndefined();expect(JSON.stringify(schema)).not.toMatch(/tokens|sessions/);
});
it('inspects program routing without recording usage when transport checks reject the request',async()=>{
 const f=fixture();f.clock.advance(1000);
 const headers={authorization:'Bearer '+raw.program,'content-type':'application/json',origin:'https://other.example'};
 expect((await f.root.http.request('http://loom/api/tasks/command',{method:'POST',headers,body:'{}'})).status).toBe(403);
 expect((await f.root.http.request('http://loom/api/tasks/command',{method:'POST',headers:{authorization:'Bearer '+raw.program,'content-type':'text/plain'},body:'{}'})).status).toBe(415);
 expect(f.db.select().from(tokens).where(eq(tokens.fingerprint,hash(raw.program))).get()?.lastUsedAt).toBeNull();
 expect((await f.call('tasks.command',{action:'comment',id:'t-1',text:'Accepted program use'})).status).toBe(200);
 expect(f.db.select().from(tokens).where(eq(tokens.fingerprint,hash(raw.program))).get()?.lastUsedAt).toBe(new Date(f.clock.now()).toISOString());
});

it('keeps an explicit read-only adapter enforcement-only without a hidden writable setup surface',async()=>{
 const f=fixture();expect(f.root.services.programSetup).toBeUndefined();expect(f.root.operations.has('program.setGrants')).toBe(false);expect(await(await f.read('{ programSetup { owner } }','owner')).json()).toEqual({data:{programSetup:null}});
 const refused=await f.root.http.request('http://loom/api/signin/program',{method:'POST',headers:{authorization:'Bearer '+raw.owner,'content-type':'application/json'},body:JSON.stringify({member:'owner',label:'No writer',records:['tasks'],operations:[]})});expect(refused.status).toBe(503);expect(f.db.select().from(tokens).all().some(token=>token.label==='No writer')).toBe(false);
});
