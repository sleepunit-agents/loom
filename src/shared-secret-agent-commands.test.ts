import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { members, agents, jobs, boxes, tokens, sessions, secrets, secretChanges, secretRequests, secretGrants } from './core/data/schema.js';
import { sharedRoot } from './shared-root.js';
const clean:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of clean.splice(0).reverse())await close();});
const raw={owner:'a'.repeat(64),body:'b'.repeat(64),other:'c'.repeat(64),agent:'d'.repeat(64),runner:'e'.repeat(64),cookie:'f'.repeat(64)};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function fixture(){
 const client=new Database(':memory:');clean.push(()=>{client.close();});const clock=new FakeClock(),at=new Date(clock.now()).toISOString(),db=createDataSchema(client);
 db.insert(members).values({id:'owner',role:'owner',joinedAt:at}).run();
 db.insert(agents).values({id:'art',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();
 db.insert(boxes).values({id:'box',name:'Box',owner:'owner',sameMachineAsLoom:false,hostsAny:false,reportOnly:false,alwaysOn:false,enrolledAt:at}).run();
 for(const id of ['job','other'])db.insert(jobs).values({id,agent:'art',box:'box',title:'',brief:'Do not copy this',model:'test',state:'running',startedByKind:'agent',startedBy:'art',houseRepository:'',houseFile:'',houseBranch:'',queuedAt:at}).run();
 db.insert(tokens).values([
  {fingerprint:hash(raw.owner),label:'Owner',kind:'owner',member:'owner',createdAt:at},
  {fingerprint:hash(raw.body),label:'Body',kind:'agent',agent:'art',job:'job',createdAt:at},
  {fingerprint:hash(raw.other),label:'Other body',kind:'agent',agent:'art',job:'other',createdAt:at},
  {fingerprint:hash(raw.agent),label:'Agent',kind:'agent',agent:'art',createdAt:at},
  {fingerprint:hash(raw.runner),label:'Runner',kind:'runner',box:'box',createdAt:at},
 ]).run();
 db.insert(sessions).values({id:hash(raw.cookie),token:hash(raw.body),device:'Browser',via:'token',isAgent:true,issuedAt:at,seenAt:at,provedAt:at}).run();
 for(const name of ['TOKEN','OTHER']){db.insert(secrets).values({name,description:'',changedAt:at,changedBy:'owner'}).run();db.insert(secretChanges).values({id:name,secret:name,action:'add',by:'owner',at}).run();}
 const root=sharedRoot({db,clock,originAllowed:()=>true,reportError:()=>{}});clean.push(()=>root.close());
 const call=async(operation:string,input:unknown,credential=raw.body,id=randomUUID(),cookie=false)=>{
  const response=await root.http.request('http://loom/api/secrets/'+operation,{method:'POST',headers:{'content-type':'application/json',...(cookie?{cookie:'loom_ui='+credential}:{authorization:'Bearer '+credential})},body:JSON.stringify({input,id})});return {status:response.status,body:await response.json()};
 };
 const request=async(scope:'agent'|'job'='job',secret='TOKEN')=>{const id=randomUUID();expect((await call('request',{id,secret,why:'Use it',minutes:5,scope})).status).toBe(200);return id;};
 const allow=async(id:string)=>{expect((await call('command',{action:'answer',id,allow:true,always:false},raw.owner)).status).toBe(200);};
 return {client,db,clock,at,root,call,request,allow};
}
it('binds job-scoped requests to the actual authenticated body, rejecting scope claims',async()=>{
 const f=fixture(),input={id:randomUUID(),secret:'TOKEN',why:'Use it',minutes:5};
 for(const credential of [raw.owner,raw.runner,raw.agent])expect((await f.call('request',input,credential)).status).toBe(403);
 expect((await f.call('request',input,raw.cookie,randomUUID(),true)).status).toBe(403);
 for(const claim of [{job:'other'},{agent:'another'},{conversation:'forged'}])expect((await f.call('request',{...input,...claim})).status).toBe(400);
 const id=await f.request();expect(f.db.select().from(secretRequests).get()).toMatchObject({id,agent:'art',job:'job'});await f.allow(id);
 expect(f.root.operations.has('secrets.use')).toBe(false);
});

it('lets an authenticated agent ask for an agent-wide grant and reads current answer status without a body claim',async()=>{
 const f=fixture(),id=randomUUID();expect((await f.call('request',{id,secret:'TOKEN',why:'Use it',minutes:5,scope:'agent'},raw.agent)).status).toBe(200);
 expect(f.db.select().from(secretRequests).get()?.job).toBeNull();await f.allow(id);
 expect((await f.call('requestStatus',{id},raw.agent)).body).toEqual({ok:true,value:{id,state:'allowed'}});
 expect((await f.call('requestStatus',{id},raw.runner)).status).toBe(403);
 expect(f.db.select().from(secretGrants).get()?.job).toBeNull();
});

it('isolates another authenticated agent from request status',async()=>{
 const f=fixture(),request=await f.request();
 f.db.insert(agents).values({id:'mark',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();
 const token='1'.repeat(64);f.db.insert(tokens).values({fingerprint:hash(token),label:'Mark',kind:'agent',agent:'mark',createdAt:f.at}).run();
 expect((await f.call('requestStatus',{id:request},token)).status).toBe(403);
});
it('derives the request conversation from the saved bound job',async()=>{
 const f=fixture(),conversation=f.root.services.conversations.open({agent:'art',venue:'loom',place:'saved',label:'Saved private conversation',member:'owner'});
 f.root.writes.run(()=>f.db.update(jobs).set({conversation:conversation.id,member:'owner'}).where(eq(jobs.id,'job')).run());
 const request=await f.request();expect(f.db.select().from(secretRequests).get()).toMatchObject({id:request,job:'job',conversation:conversation.id});
});
it('binds operation receipts to the actual body job before replaying request metadata',async()=>{
 const f=fixture(),input={id:randomUUID(),secret:'TOKEN',why:'Use it',minutes:5},requestReceipt=randomUUID();
 expect((await f.call('request',input,raw.body,requestReceipt)).status).toBe(200);await f.allow(input.id);
 expect((await f.call('request',input,raw.other,requestReceipt)).status).toBe(409);
 expect(f.db.select().from(secretRequests).all()).toHaveLength(1);
});

it('rejects extra identity fields on both metadata status commands',async()=>{
 const f=fixture(),request=await f.request();await f.allow(request);
 expect((await f.call('requestStatus',{id:request,agent:'other'})).status).toBe(400);
 expect((await f.call('useStatus',{id:'unknown',job:'other'})).status).toBe(400);
});

it('binds request receipt replay to the saved conversation even for the same freshly authenticated job',async()=>{
 const f=fixture(),input={id:randomUUID(),secret:'TOKEN',why:'Use it',minutes:5},receipt=randomUUID();
 const first=f.root.services.conversations.open({agent:'art',venue:'loom',place:'first',label:'First',member:'owner'});
 const second=f.root.services.conversations.open({agent:'art',venue:'loom',place:'second',label:'Second',member:'owner'});
 f.root.writes.run(()=>f.db.update(jobs).set({conversation:first.id,member:'owner'}).where(eq(jobs.id,'job')).run());
 expect((await f.call('request',input,raw.body,receipt)).status).toBe(200);
 f.root.writes.run(()=>f.db.update(jobs).set({conversation:second.id}).where(eq(jobs.id,'job')).run());
 expect((await f.call('request',input,raw.body,receipt)).status).toBe(409);
 expect(f.db.select().from(secretRequests).get()?.conversation).toBe(first.id);
});
