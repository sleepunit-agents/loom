import {createServer} from 'node:http';
import {once} from 'node:events';
import {getRequestListener} from '@hono/node-server';
import {WebSocket} from 'ws';
import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {FakeClock} from './core/clock.js';
import {createDataSchema} from './core/data/database.js';
import * as s from './core/data/schema.js';
import {sharedRoot} from './shared-root.js';
const cleanup:(()=>Promise<void>)[]=[];afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.unstubAllGlobals();});
const hash=(text:string)=>createHash('sha256').update(text).digest('hex'),head='a'.repeat(40),change='github:acme/app#1',cookie='c'.repeat(64);
function fixture(install=true){
 const client=new Database(':memory:'),clock=new FakeClock(),at=new Date(clock.now()).toISOString();cleanup.push(async()=>{client.close();});const db=createDataSchema(client,()=>new Date(clock.now()).toISOString());
 db.insert(s.members).values(['pat','sam'].map(id=>({id,role:id==='pat'?'owner' as const:'member' as const,joinedAt:at}))).run();
 db.insert(s.agents).values({id:'art',about:'',markBg:'#000000',markFg:'#ffffff',faceShape:'pebble',faceEyes:'dot'}).run();
 db.insert(s.projects).values(['pond','other'].map(id=>({id,name:id}))).run();db.insert(s.projectMembers).values({project:'pond',member:'sam'}).run();db.insert(s.memberAgents).values({member:'sam',agent:'art'}).run();
 for(const [value,member,agent] of [['a'.repeat(64),'pat',null],['b'.repeat(64),'sam',null],['e'.repeat(64),null,'art']] as const)db.insert(s.tokens).values({fingerprint:hash(value),label:value,kind:agent?'agent':'owner',member,agent,createdAt:at}).run();
 db.insert(s.sessions).values({id:hash(cookie),token:hash('a'.repeat(64)),device:'Fixture',via:'token',isAgent:false,issuedAt:at,seenAt:at,provedAt:at}).run();
 db.insert(s.changes).values({id:change,repository:'acme/app',number:1,title:'Fixture',body:'',url:'https://github.com/acme/app/pull/1',state:'open',draft:false,authorLogin:'art',project:'pond',agent:'art',branch:'work',headCommit:head,baseBranch:'next',checks:'passing',review:'approved',mergeable:'yes',waitingOn:'you',openedAt:at,updatedAt:at}).run();
 const restrictions={approval:true,change:true},execute=vi.fn();
 const root=sharedRoot({db,clock,originAllowed:()=>true,reportError:()=>{},approvedOperations:new Map([['fixture.change',execute]])});
 cleanup.push(async()=>{await root.close();});
 const ask=(actingFor='pat',operation:string|null=null)=>root.writes.run(()=>root.services.approvals.request({kind:'merge',target:`${change}@${head}`,agent:'art',project:'pond',what:'Merge fixture',why:'Ready',askedFrom:'fixture',actingFor,ask:'Merge this exact head?',ifYes:'Agent merges',ifNo:'Wait',operation})).value;
 const input=(approval:string,person='')=>({approval,change,head,project:'pond',person});
 const post=(input:unknown,id='always',bearer?:string)=>root.http.request('http://loom/api/approvals/always',{method:'POST',headers:{'content-type':'application/json',...(bearer?{authorization:'Bearer '+bearer}:{cookie:'loom_ui='+cookie})},body:JSON.stringify({input,id})});
 const snapshot=()=>({rules:db.select().from(s.approvalRules).all(),approvals:db.select().from(s.approvals).all(),audit:db.select().from(s.approvalRecord).all(),inbox:db.select().from(s.inbox).all(),changes:db.select().from(s.changes).all(),receipts:db.select().from(s.operationResults).all()});
 return {db,root,clock,restrictions,execute,ask,input,post,snapshot};
}
it('atomically grants the project rule and exact-head allowance once without merging or executing',async()=>{
 const f=fixture(false),card=f.ask(),request=vi.fn();vi.stubGlobal('fetch',request);
 for(let n=0;n<2;n++)expect(await (await f.post(f.input(card.id))).json()).toEqual({ok:true,value:{id:card.id}});
 expect(f.root.services.approvalRules.list()).toEqual([expect.objectContaining({kind:'merge',scope:'project:pond',person:'',tier:'do',setBy:'pat'})]);
 expect(f.root.services.approvals.get(card.id)).toMatchObject({state:'allowed',decidedBy:'pat'});expect(f.db.select().from(s.changes).get()).toMatchObject({state:'open',headCommit:head,waitingOn:'agent'});
 expect(f.db.select().from(s.approvalRecord).all().map(row=>row.event)).toEqual(['request','allow','grant']);expect(f.db.select().from(s.operationResults).all()).toHaveLength(1);
 expect(f.db.select().from(s.inbox).all().filter(row=>row.toKind==='agent')).toHaveLength(1);expect(f.execute).not.toHaveBeenCalled();expect(request).not.toHaveBeenCalled();
});
it('binds named-person grants and rechecks the concrete principal on replay',async()=>{
 const f=fixture(),card=f.ask('sam');expect((await f.post(f.input(card.id))).status).toBe(409);
 expect((await f.post(f.input(card.id,'sam'))).status).toBe(200);expect(f.root.services.approvalRules.list()).toEqual([expect.objectContaining({person:'sam'})]);
 expect(f.root.services.approvalRules.resolve({kind:'merge',target:`${change}@${head}`,project:'pond',actingFor:'pat'})).toBeUndefined();
 f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'sam')).run();const before=f.snapshot();expect((await f.post(f.input(card.id,'sam'))).status).toBe(409);expect(f.snapshot()).toEqual(before);
});
it('denies unknown/absent principals, forged binding fields, prepared operations and actor input without grants',async()=>{
 for(const principal of ['unknown','?','missing','owner']){const f=fixture(),card=f.ask(principal),before=f.snapshot();expect((await f.post(f.input(card.id))).status).toBe(409);expect(f.snapshot()).toEqual(before);}
 const f=fixture(),card=f.ask();
 for(const input of [{...f.input(card.id),head:'b'.repeat(40)},{...f.input(card.id),project:'other'},{...f.input(card.id),person:'sam'}]){const before=f.snapshot();expect((await f.post(input)).status).toBe(409);expect(f.snapshot()).toEqual(before);}
 expect((await f.post({...f.input(card.id),actor:'pat'})).status).toBe(400);
 const prepared=f.ask('pat','fixture.change'),before=f.snapshot();expect((await f.post(f.input(prepared.id),'prepared')).status).toBe(409);expect(f.snapshot()).toEqual(before);expect(f.execute).not.toHaveBeenCalled();
});
it('denies visible ordinary members and agents despite permissive callbacks/grants; demotion denies cached replay',async()=>{
 const f=fixture(),card=f.ask();f.root.services.approvalRules.set({kind:'merge',scope:'project:pond',person:'sam',tier:'do'},'pat');const before=f.snapshot();
 for(const token of ['b'.repeat(64),'e'.repeat(64)])expect((await f.post(f.input(card.id),'outside',token)).status).toBe(403);expect(f.snapshot()).toEqual(before);
 expect((await f.post(f.input(card.id))).status).toBe(200);f.db.update(s.members).set({role:'member'}).where(eq(s.members.id,'pat')).run();const committed=f.snapshot();
 expect((await f.post(f.input(card.id))).status).toBe(403);expect((await f.post(f.input(card.id),'fresh')).status).toBe(403);expect(f.snapshot()).toEqual(committed);
});
it('rejects moved heads on replay and preserves a newer rule when a fresh ID repeats an already answered request',async()=>{
 const f=fixture(),card=f.ask();expect((await f.post(f.input(card.id))).status).toBe(200);
 f.root.services.approvalRules.set({kind:'merge',scope:'project:pond',tier:'ask'},'pat');const newer=f.snapshot();expect((await f.post(f.input(card.id),'fresh')).status).toBe(409);expect(f.snapshot()).toEqual(newer);
 f.db.update(s.changes).set({headCommit:'b'.repeat(40)}).where(eq(s.changes.id,change)).run();const moved=f.snapshot();expect((await f.post(f.input(card.id))).status).toBe(409);expect(f.snapshot()).toEqual(moved);
});
it('rolls back rules, allowance, audit, Inbox and change along with a failed receipt',async()=>{
 const f=fixture(),card=f.ask(),before=f.snapshot();f.db.$client.exec("CREATE TRIGGER failed_always_receipt BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT,'private receipt failure'); END");
 const response=await f.post(f.input(card.id));expect(response.status).toBe(503);expect(await response.text()).not.toContain('private receipt failure');expect(f.snapshot()).toEqual(before);
});

it('publishes rule, allowance, grant audit and change in one live frame, with no frame after failed receipt',async()=>{
 const f=fixture(),card=f.ask();await f.root.ready;
 const http=createServer(getRequestListener(request=>f.root.http.fetch(request))),detach=f.root.attach(http);
 await new Promise<void>(done=>http.listen(0,'127.0.0.1',done));cleanup.push(async()=>{detach();await new Promise<void>(done=>http.close(()=>done()));});
 const address=http.address();if(!address||typeof address==='string')throw new Error('No address');
 const ws=new WebSocket(`ws://127.0.0.1:${address.port}/graphql`,'graphql-transport-ws',{headers:{cookie:'loom_ui='+cookie,origin:'http://loom'}});cleanup.push(async()=>{ws.terminate();});await once(ws,'open');
 let next=once(ws,'message');ws.send(JSON.stringify({type:'connection_init'}));await next;
 const frames:unknown[]=[];ws.on('message',data=>frames.push(JSON.parse(String(data))));next=once(ws,'message');
 const query='{ approvalRules { scope person tier } approvals { id state } changes { id waitingOn } approvalRecord { approval event } }';
 ws.send(JSON.stringify({type:'subscribe',id:'always',payload:{query:`subscription { observe(query:${JSON.stringify(query)}) { revision patches { path value removed } } }`}}));await next;const count=frames.length;
 f.db.$client.exec("CREATE TRIGGER failed_live_receipt BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT,'receipt failure'); END");expect((await f.post(f.input(card.id))).status).toBe(503);await new Promise<void>(done=>setImmediate(done));expect(frames).toHaveLength(count);
 f.db.$client.exec('DROP TRIGGER failed_live_receipt');next=once(ws,'message');expect((await f.post(f.input(card.id))).status).toBe(200);const patches=JSON.parse(String((await next)[0])).payload.data.observe.patches;
 expect(patches).toContainEqual({path:['approvalRules',0],value:{scope:'project:pond',person:'',tier:'do'},removed:false});
 expect(patches).toContainEqual({path:['approvals',0,'state'],value:'allowed',removed:false});expect(patches).toContainEqual({path:['changes',0,'waitingOn'],value:'agent',removed:false});
 expect(patches).toContainEqual({path:['approvalRecord',2],value:{approval:card.id,event:'grant'},removed:false});await new Promise<void>(done=>setImmediate(done));expect(frames).toHaveLength(count+1);
});

it('refuses cached and fresh Always intents after the admitted cookie session is deleted',async()=>{
 const f=fixture(),card=f.ask();expect((await f.post(f.input(card.id))).status).toBe(200);
 f.db.delete(s.sessions).run();const before=f.snapshot();expect((await f.post(f.input(card.id))).status).toBe(401);expect((await f.post(f.input(card.id),'fresh')).status).toBe(401);expect(f.snapshot()).toEqual(before);
});

it('rechecks every stored target, project, agent and operation binding before replay',async()=>{
 const mutations:((f:ReturnType<typeof fixture>,id:string)=>void)[]=[
  f=>{f.db.update(s.changes).set({project:'other'}).where(eq(s.changes.id,change)).run();},
  (f,id)=>{f.db.update(s.approvals).set({project:'other'}).where(eq(s.approvals.id,id)).run();},
  f=>{f.db.update(s.changes).set({agent:'other-agent'}).where(eq(s.changes.id,change)).run();},
  (f,id)=>{f.db.update(s.approvals).set({agent:'other-agent'}).where(eq(s.approvals.id,id)).run();},
  (f,id)=>{f.db.update(s.approvals).set({target:`${change}@`+'b'.repeat(40)}).where(eq(s.approvals.id,id)).run();},
  (f,id)=>{f.db.update(s.approvals).set({operation:'fixture.change'}).where(eq(s.approvals.id,id)).run();},
  (f,id)=>{f.db.update(s.approvals).set({kind:'command'}).where(eq(s.approvals.id,id)).run();},
 ];
 for(const mutate of mutations){const f=fixture(),card=f.ask();f.db.insert(s.agents).values({id:'other-agent',about:'',markBg:'#000000',markFg:'#ffffff',faceShape:'pebble',faceEyes:'dot'}).run();expect((await f.post(f.input(card.id))).status).toBe(200);mutate(f,card.id);const before=f.snapshot();expect((await f.post(f.input(card.id))).status).toBe(409);expect(f.snapshot()).toEqual(before);expect(f.execute).not.toHaveBeenCalled();}
});
it('rejects malformed heads and every omitted binding field at the schema boundary without effects',async()=>{
 const f=fixture(),card=f.ask(),base=f.input(card.id),before=f.snapshot();
 const invalid:unknown[]=['a'.repeat(39),'a'.repeat(41),'g'.repeat(40),'A'.repeat(40),null,42].map(head=>({...base,head}));
 for(const key of ['approval','change','head','project','person']){const input:Record<string,unknown>={...base};delete input[key];invalid.push(input);}
 invalid.push({...base,approval:' '},{...base,change:''},{...base,project:''},{...base,person:null});
 for(const [n,input] of invalid.entries()){expect((await f.post(input,'invalid-'+n)).status).toBe(400);expect(f.snapshot()).toEqual(before);}
});
it('refuses a fresh Always grant for closed and merged copies, rolling back the tentative standing rule',async()=>{
 for(const state of ['closed','merged'] as const){const f=fixture(),card=f.ask();f.db.update(s.changes).set({state}).where(eq(s.changes.id,change)).run();const before=f.snapshot();expect((await f.post(f.input(card.id))).status).toBe(409);expect(f.snapshot()).toEqual(before);}
});

