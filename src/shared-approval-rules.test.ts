import Database from 'better-sqlite3';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {getRequestListener} from '@hono/node-server';
import {WebSocket} from 'ws';
import {createHash} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {createDataSchema} from './core/data/database.js';
import {FakeClock} from './core/clock.js';
import * as s from './core/data/schema.js';
import {sharedRoot} from './shared-root.js';
const cleanup:(()=>Promise<void>)[]=[];afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.unstubAllGlobals();});
function fixture(approvedOperations:Parameters<typeof sharedRoot>[0]['approvedOperations']=new Map()){
 const client=new Database(':memory:'),clock=new FakeClock(),at=new Date(clock.now()).toISOString();
 const db=createDataSchema(client,()=>new Date(clock.now()).toISOString());
 db.insert(s.members).values(['pat','sam','lee'].map(id=>({id,role:id==='pat'?'owner' as const:'member' as const,joinedAt:at}))).run();
 db.insert(s.projects).values({id:'pond',name:'Pond'}).run();
 db.insert(s.agents).values({id:'art',about:'',markBg:'#000000',markFg:'#ffffff',faceShape:'pebble',faceEyes:'dot'}).run();
 const cookie='c'.repeat(64),fingerprint='t'.repeat(64),session=createHash('sha256').update(cookie).digest('hex');
 db.insert(s.tokens).values({fingerprint,label:'Fixture',kind:'owner',member:'pat',createdAt:at}).run();
 db.insert(s.sessions).values({id:session,token:fingerprint,device:'Fixture',via:'token',isAgent:false,issuedAt:at,seenAt:at,provedAt:at}).run();
 const root=sharedRoot({db,clock,approvedOperations,originAllowed:()=>true,reportError:error=>{throw error;}});
 cleanup.push(async()=>{await root.close();client.close();});
 const post=(input:unknown,id='rule-1')=>root.http.request('http://loom/api/approvals/setRule',{method:'POST',headers:{'content-type':'application/json',cookie:'loom_ui='+cookie},body:JSON.stringify({input,id})});
 return {db,root,clock,post};
}
it('edits all four standing kinds through the real current-owner door, with actor-free receipts and demotion replay denial',async()=>{
 const f=fixture();
 for(const kind of ['merge','command','setting','dangerous'] as const){
  const input={kind,scope:kind==='merge'?'github:ACME/*':'*',tier:'tell'};
  for(let n=0;n<2;n++)expect((await f.post(input,kind)).status).toBe(200);
 }
 expect(f.root.services.approvalRules.list()).toHaveLength(4);
 expect(f.root.services.approvalRules.list()).toEqual(expect.arrayContaining([expect.objectContaining({kind:'merge',scope:'github:acme/*',setBy:'pat',person:'',tier:'tell'})]));
 expect(f.db.select().from(s.operationResults).all()).toHaveLength(4);
 expect((await f.post({kind:'merge',scope:'*',tier:'do'},'merge')).status).toBe(409);
 expect((await f.post({kind:'merge',scope:'*',tier:'do',actor:'pat'},'actor')).status).toBe(400);
 expect((await f.post({kind:'merge',scope:'project:missing',tier:'do'},'missing')).status).toBe(400);
 f.db.update(s.members).set({role:'member'}).where(eq(s.members.id,'pat')).run();
 expect((await f.post({kind:'merge',scope:'github:ACME/*',tier:'tell'},'merge')).status).toBe(403);
 expect((await f.post({kind:'merge',scope:'*',tier:'do'},'new')).status).toBe(403);
 expect(f.root.operations.call('direct',{kind:'agent',id:'art'},'approvals.setRule',{kind:'merge',scope:'*',tier:'do'},'agent')).toMatchObject({ok:false,code:'denied'});
 expect(f.db.select().from(s.operationResults).all()).toHaveLength(4);
});
it('resolves exact > project > repository wildcard > global, keeps named grants separate, and unknown or stale authority asks',()=>{
 const f=fixture(),rules=f.root.services.approvalRules,target='github:acme/app#1@'+'a'.repeat(40);
 const resolve=(actingFor='pat')=>rules.resolve({kind:'merge',target,project:'pond',actingFor});
 rules.set({kind:'merge',scope:'*',tier:'do'},'pat');expect(resolve()).toMatchObject({tier:'do',scope:'*',person:''});
 expect(resolve('owner')).toBeUndefined();
 f.db.insert(s.members).values({id:'owner',role:'member',joinedAt:new Date(f.clock.now()).toISOString()}).run();expect(resolve('owner')).toBeUndefined();
 expect(resolve('unknown')).toBeUndefined();expect(resolve('?')).toBeUndefined();expect(resolve('missing')).toBeUndefined();expect(resolve('sam')).toBeUndefined();
 rules.set({kind:'merge',scope:'github:acme/*',tier:'tell'},'pat');expect(resolve()).toMatchObject({tier:'tell'});
 rules.set({kind:'merge',scope:'project:pond',tier:'do'},'pat');expect(resolve()).toMatchObject({tier:'do',scope:'project:pond'});
 rules.set({kind:'merge',scope:'github:acme/app',tier:'ask'},'pat');expect(resolve()).toMatchObject({tier:'ask',scope:'github:acme/app'});
 rules.set({kind:'merge',scope:'github:acme/app',person:'sam',tier:'tell'},'pat');expect(resolve('sam')).toMatchObject({tier:'tell',person:'sam'});expect(resolve('lee')).toBeUndefined();expect(resolve('pat')).toMatchObject({tier:'ask',person:''});
 rules.set({kind:'merge',scope:'github:acme/app',tier:null},'pat');expect(resolve()).toMatchObject({scope:'project:pond'});
 f.db.update(s.members).set({role:'member'}).where(eq(s.members.id,'pat')).run();expect(resolve()).toBeUndefined();expect(resolve('sam')).toBeUndefined();
 expect(()=>rules.set({kind:'merge',scope:'*',tier:'do'},'sam')).toThrow('household owner');
});
it('treats pattern punctuation literally and lets current owners delete orphaned project scopes',()=>{
 const f=fixture(),rules=f.root.services.approvalRules;
 rules.set({kind:'command',scope:'run [a].*',person:'sam',tier:'do'},'pat');
 expect(rules.resolve({kind:'command',target:'run [a].txt',actingFor:'sam'})).toMatchObject({tier:'do'});
 expect(rules.resolve({kind:'command',target:'run a.txt',actingFor:'sam'})).toBeUndefined();
 rules.set({kind:'command',scope:'echo 🦆*',person:'sam',tier:'ask'},'pat');expect(rules.resolve({kind:'command',target:'echo 🦆pond',actingFor:'sam'})).toMatchObject({tier:'ask'});
 rules.set({kind:'command',scope:'echo 🦆*',person:'sam',tier:null},'pat');
 rules.set({kind:'setting',scope:'project:pond',person:'lee',tier:'ask'},'pat');f.db.delete(s.projects).run();
 expect(()=>f.db.delete(s.members).where(eq(s.members.id,'lee')).run()).toThrow('polymorphic foreign key');
 expect(rules.resolve({kind:'setting',target:'timings',project:'pond',actingFor:'lee'})).toBeUndefined();
 rules.set({kind:'setting',scope:'project:pond',person:'lee',tier:null},'pat');expect(rules.list()).toHaveLength(1);
});

it('publishes owner rule edits/deletions through the generated query and hides global rules immediately on demotion',async()=>{
 const f=fixture();
 const query=()=>f.root.http.request('http://loom/graphql',{method:'POST',headers:{'content-type':'application/json',cookie:'loom_ui='+'c'.repeat(64)},body:JSON.stringify({query:'{ approvalRules { kind scope person tier setBy } }'})}).then(response=>response.json());
 const input={kind:'setting',scope:'tempo:*',person:'sam',tier:'ask'};
 expect((await f.post(input,'create')).status).toBe(200);
 expect(await query()).toEqual({data:{approvalRules:[{...input,setBy:'pat'}]}});
 f.root.writes.run(()=>f.db.update(s.members).set({role:'member'}).where(eq(s.members.id,'pat')).run());
 expect(await query()).toEqual({data:{approvalRules:[]}});
 f.root.writes.run(()=>f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'pat')).run());
 expect((await f.post({...input,tier:null},'remove')).status).toBe(200);
 expect(await query()).toEqual({data:{approvalRules:[]}});
 expect(f.db.select().from(s.operationResults).all()).toHaveLength(2);
});

it('chooses literal specificity ahead of star count, then the stricter tier for equal matching specificity',()=>{
 const f=fixture(),rules=f.root.services.approvalRules;
 const resolve=()=>rules.resolve({kind:'merge',target:'github:acme/app#1@'+'a'.repeat(40),actingFor:'pat'});
 rules.set({kind:'merge',scope:'github:acme/*',tier:'do'},'pat');
 rules.set({kind:'merge',scope:'github:acme/a*p*',tier:'ask'},'pat');expect(resolve()).toMatchObject({tier:'ask',scope:'github:acme/a*p*'});
 rules.set({kind:'merge',scope:'github:acme/a*p*',tier:null},'pat');
 rules.set({kind:'merge',scope:'github:acme/a*p',tier:'do'},'pat');rules.set({kind:'merge',scope:'github:acme/ap*',tier:'tell'},'pat');
 expect(resolve()).toMatchObject({tier:'tell',scope:'github:acme/ap*'});
 rules.set({kind:'merge',scope:'github:acme/*pp',tier:'ask'},'pat');expect(resolve()).toMatchObject({tier:'ask',scope:'github:acme/*pp'});
 rules.set({kind:'merge',scope:'github:acme/*pp',tier:null},'pat');expect(resolve()).toMatchObject({tier:'tell'});
 rules.set({kind:'merge',scope:'github:acme/ap*',tier:null},'pat');expect(resolve()).toMatchObject({tier:'do',scope:'github:acme/a*p'});
 rules.set({kind:'merge',scope:'github:acme/a**p',tier:'ask'},'pat');expect(resolve()).toMatchObject({tier:'do',scope:'github:acme/a*p'});
});
it('rolls back receipt failure without a live publication, then publishes successful creation and deletion',async()=>{
 const f=fixture();await f.root.ready;
 const http=createServer(getRequestListener(request=>f.root.http.fetch(request))),detach=f.root.attach(http);
 await new Promise<void>(done=>http.listen(0,'127.0.0.1',done));
 cleanup.push(async()=>{detach();await new Promise<void>(done=>http.close(()=>done()));});
 const address=http.address();if(!address||typeof address==='string')throw new Error('No address');
 const ws=new WebSocket(`ws://127.0.0.1:${address.port}/graphql`,'graphql-transport-ws',{headers:{cookie:'loom_ui='+'c'.repeat(64),origin:'http://loom'}});cleanup.push(async()=>{ws.terminate();});
 await once(ws,'open');let next=once(ws,'message');ws.send(JSON.stringify({type:'connection_init'}));await next;
 const messages:unknown[]=[];ws.on('message',data=>messages.push(JSON.parse(String(data))));
 next=once(ws,'message');ws.send(JSON.stringify({type:'subscribe',id:'rules',payload:{query:'subscription { observe(query:"{ approvalRules { scope tier } }") { revision patches { path value removed } } }'}}));await next;
 const count=messages.length,input={kind:'merge',scope:'github:acme/*',tier:'ask'};
 f.db.$client.exec("CREATE TRIGGER broken_rule_receipt BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT,'private receipt failure'); END");
 expect((await f.post(input,'failed')).status).toBe(503);expect(f.root.services.approvalRules.list()).toEqual([]);expect(f.db.select().from(s.operationResults).all()).toEqual([]);
 await new Promise<void>(done=>setImmediate(done));expect(messages).toHaveLength(count);
 f.db.$client.exec('DROP TRIGGER broken_rule_receipt');next=once(ws,'message');expect((await f.post(input,'success')).status).toBe(200);
 expect(JSON.parse(String((await next)[0])).payload.data.observe.patches).toContainEqual({path:['approvalRules',0],value:{scope:'github:acme/*',tier:'ask'},removed:false});
 next=once(ws,'message');expect((await f.post({...input,tier:null},'remove')).status).toBe(200);
 expect(JSON.parse(String((await next)[0])).payload.data.observe.patches).toContainEqual({path:['approvalRules',0],removed:true,value:null});
 expect(f.db.select().from(s.operationResults).all()).toHaveLength(2);
});

it('refuses non-repository merge scope text and malformed repository patterns without effects or receipts',async()=>{
 const f=fixture();
 for(const [i,scope] of ['acme/app','please allow','github:acme','github:acme/app#1','github:acme/app/extra','github:acme/','github:/app','github:acme/a?'].entries())
  expect((await f.post({kind:'merge',scope,tier:'do'},'invalid-'+i)).status).toBe(400);
 expect(f.root.services.approvalRules.list()).toEqual([]);expect(f.db.select().from(s.operationResults).all()).toEqual([]);
});

it('treats zero-literal patterns uniformly before comparing star count',()=>{
 const f=fixture(),rules=f.root.services.approvalRules;
 rules.set({kind:'command',scope:'*',tier:'ask'},'pat');rules.set({kind:'command',scope:'**',tier:'do'},'pat');
 expect(rules.resolve({kind:'command',target:'run something',actingFor:'pat'})).toMatchObject({tier:'ask',scope:'*'});
});
it('editing and resolving never files or answers an approval, executes a callback or changes a pull request',()=>{
 const execute=vi.fn(),request=vi.fn();vi.stubGlobal('fetch',request);
 const f=fixture(new Map([['fixture.noexec',execute]])),rules=f.root.services.approvalRules;
 const card=f.root.services.approvals.request({kind:'setting',operation:'fixture.noexec',changeSummary:'Before -> after',target:'fixture',agent:'art',what:'Fixture',why:'No effects proof',askedFrom:'fixture',actingFor:'pat',ask:'Apply?',ifYes:'Apply',ifNo:'Keep'});
 const at=new Date(f.clock.now()).toISOString();
 f.root.services.changes.put({id:'github:acme/app#1',repo:'github:acme/app',number:1,page:'',title:'Fixture',url:'https://github.com/acme/app/pull/1',state:'open',draft:false,author:{login:'art'},created:at,updated:at,closed:null,head:{ref:'work',id:'a'.repeat(40)},base:{ref:'next'},body:'',checks:{state:'passing',running:[],failing:[],total:1},review:{state:'approved',by:[]},mergeable:'yes',conflicts:false,people:[]});
 const before={approvals:f.db.select().from(s.approvals).all(),audit:f.db.select().from(s.approvalRecord).all(),inbox:f.db.select().from(s.inbox).all(),changes:f.db.select().from(s.changes).all()};
 for(const kind of ['merge','command','setting','dangerous'] as const){rules.set({kind,scope:'*',tier:'do'},'pat');rules.resolve({kind,target:kind==='merge'?'github:acme/app#1@'+'a'.repeat(40):'fixture',actingFor:'pat'});}
 expect({approvals:f.db.select().from(s.approvals).all(),audit:f.db.select().from(s.approvalRecord).all(),inbox:f.db.select().from(s.inbox).all(),changes:f.db.select().from(s.changes).all()}).toEqual(before);
 expect(f.root.services.approvals.get(card.id).state).toBe('pending');expect(execute).not.toHaveBeenCalled();expect(request).not.toHaveBeenCalled();
});
