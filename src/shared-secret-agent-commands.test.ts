import { DataLive } from './core/data/live.js';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { members, agents, jobs, boxes, tokens, sessions, secrets, secretChanges, secretRequests, secretGrants, secretUses, agentHouseSecrets } from './core/data/schema.js';
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
 const handTo=vi.fn(async(_secret:string,_destination:{agent:string;job:string})=>{expect(client.inTransaction).toBe(false);expect(db.select().from(secretUses).where(and(eq(secretUses.secret,_secret),eq(secretUses.job,_destination.job),eq(secretUses.state,'started'))).all().length).toBeGreaterThan(0);});
 const root=sharedRoot({db,clock,originAllowed:()=>true,reportError:()=>{},secretDelivery:{handTo}});clean.push(()=>root.close());
 const call=async(operation:string,input:unknown,credential=raw.body,id=randomUUID(),cookie=false)=>{
  const response=await root.http.request('http://loom/api/secrets/'+operation,{method:'POST',headers:{'content-type':'application/json',...(cookie?{cookie:'loom_ui='+credential}:{authorization:'Bearer '+credential})},body:JSON.stringify({input,id})});return {status:response.status,body:await response.json()};
 };
 const request=async(scope:'agent'|'job'='job',secret='TOKEN')=>{const id=randomUUID();expect((await call('request',{id,secret,why:'Use it',minutes:5,scope})).status).toBe(200);return id;};
 const allow=async(id:string)=>{expect((await call('command',{action:'answer',id,allow:true,always:false},raw.owner)).status).toBe(200);};
 return {client,db,clock,at,root,call,request,allow,handTo};
}
it('binds job-scoped requests and handoffs to the actual authenticated body, rejecting scope claims',async()=>{
 const f=fixture(),input={id:randomUUID(),secret:'TOKEN',why:'Use it',minutes:5};
 for(const credential of [raw.owner,raw.runner,raw.agent])expect((await f.call('request',input,credential)).status).toBe(403);
 expect((await f.call('request',input,raw.cookie,randomUUID(),true)).status).toBe(403);
 for(const claim of [{job:'other'},{agent:'another'},{conversation:'forged'}])expect((await f.call('request',{...input,...claim})).status).toBe(400);
 const id=await f.request();expect(f.db.select().from(secretRequests).get()).toMatchObject({id,agent:'art',job:'job'});await f.allow(id);
 const use={id:randomUUID(),secret:'TOKEN'};expect((await f.call('use',use,raw.other)).status).toBe(503);
 const result=await f.call('use',use);expect(result).toMatchObject({status:200,body:{ok:true,value:{state:'released'}}});expect(f.handTo).toHaveBeenCalledExactlyOnceWith('TOKEN',{agent:'art',job:'job'});
 expect((await f.call('useStatus',{id:result.body.value.id})).body).toEqual({ok:true,value:{id:result.body.value.id,state:'released'}});
 expect((await f.call('useStatus',{id:result.body.value.id},raw.other)).status).toBe(403);
 expect(await f.root.operations.callAsync('http',{kind:'agent',id:'art'},'secrets.use',use,randomUUID())).toMatchObject({ok:false,code:'denied'});
});
it('lets an authenticated agent ask for an agent-wide grant and reads current answer status without a body claim',async()=>{
 const f=fixture(),id=randomUUID();expect((await f.call('request',{id,secret:'TOKEN',why:'Use it',minutes:5,scope:'agent'},raw.agent)).status).toBe(200);
 expect(f.db.select().from(secretRequests).get()?.job).toBeNull();await f.allow(id);
 expect((await f.call('requestStatus',{id},raw.agent)).body).toEqual({ok:true,value:{id,state:'allowed'}});
 expect((await f.call('requestStatus',{id},raw.runner)).status).toBe(403);
 expect((await f.call('use',{id:randomUUID(),secret:'TOKEN'},raw.other)).status).toBe(200);
 expect(f.db.select().from(secretGrants).get()?.job).toBeNull();expect(f.db.select().from(secretUses).get()?.job).toBe('other');
});
it('replays a stable use identity as metadata, never automatically handing a released/failed/started attempt out again',async()=>{
 const f=fixture(),request=await f.request();await f.allow(request);const input={id:randomUUID(),secret:'TOKEN'};
 const first=await f.call('use',input);expect(first.status).toBe(200);
 expect((await f.call('use',input)).body).toEqual(first.body);expect(f.handTo).toHaveBeenCalledOnce();
 f.handTo.mockRejectedValueOnce(Error('synthetic-private-value'));const failed={id:randomUUID(),secret:'TOKEN'};
 expect((await f.call('use',failed)).body.value.state).toBe('failed');expect((await f.call('use',failed)).body.value.state).toBe('failed');expect(f.handTo).toHaveBeenCalledTimes(2);
 const other=await f.request('job','OTHER');await f.allow(other);
 expect((await f.call('use',{...input,secret:'OTHER'})).status).toBe(503);expect(f.handTo).toHaveBeenCalledTimes(2);
 expect(JSON.stringify(f.db.select().from(secretUses).all())).not.toContain('synthetic-private-value');
});
it('fences a stopped job during handoff and denies subsequent calls even if its agent token remains',async()=>{
 const f=fixture(),request=await f.request();await f.allow(request);let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
 f.handTo.mockImplementationOnce(async()=>{entered();await new Promise<void>(resolve=>{release=resolve;});});
 const pending=f.call('use',{id:randomUUID(),secret:'TOKEN'});await started;
 f.root.writes.run(()=>f.db.update(jobs).set({state:'done'}).where(eq(jobs.id,'job')).run());release();expect((await pending).status).toBe(403);
 expect((await f.call('use',{id:randomUUID(),secret:'TOKEN'})).status).toBe(401);expect(f.handTo).toHaveBeenCalledOnce();
});
it('startup aliases alone and household defaults do not grant; explicit startup rules deliver configured names once',async()=>{
 const f=fixture();f.root.writes.run(()=>f.db.insert(agentHouseSecrets).values({agent:'art',alias:'TOKEN',secret:'TOKEN'}).run());
 expect(await f.root.services.secrets.startup!.handTo('job')).toEqual([]);expect(f.handTo).not.toHaveBeenCalled();
 f.root.writes.run(()=>f.root.services.secrets.requests.setRule({secret:'OTHER',answer:'auto',minutes:5,agents:[{agent:'art',when:'at_start'}]}));
 expect(await f.root.services.secrets.startup!.handTo('job')).toEqual([]);expect(f.handTo).not.toHaveBeenCalled();
 f.root.writes.run(()=>f.root.services.secrets.requests.setRule({secret:'TOKEN',answer:'ask',minutes:5,agents:[{agent:'art',when:'at_start'}]}));
 const first=await f.root.services.secrets.startup!.handTo('job');expect(first).toMatchObject([{state:'released'}]);expect(await f.root.services.secrets.startup!.handTo('job')).toEqual(first);expect(f.handTo).toHaveBeenCalledOnce();
});
it('root close drains trusted startup delivery and leaves an unconfirmed audit that will not be replayed',async()=>{
 const f=fixture();f.root.writes.run(()=>{f.db.insert(agentHouseSecrets).values({agent:'art',alias:'TOKEN',secret:'TOKEN'}).run();f.root.services.secrets.requests.setRule({secret:'TOKEN',answer:'auto',minutes:5,agents:[{agent:'art',when:'at_start'}]});});
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});f.handTo.mockImplementationOnce(async()=>{entered();await new Promise<void>(resolve=>{release=resolve;});});
 const pending=f.root.services.secrets.startup!.handTo('job');await started;let closed=false;const closing=f.root.close().then(()=>{closed=true;});
 expect((await f.call('requestStatus',{id:'unused'})).status).toBe(503);expect(closed).toBe(false);release();await expect(pending).rejects.toThrow('completion could not be recorded');await closing;
 expect(f.db.select().from(secretUses).get()?.state).toBe('started');
 const next=sharedRoot({db:f.db,clock:f.clock,originAllowed:()=>true,reportError:()=>{},secretDelivery:{handTo:f.handTo}});clean.push(()=>next.close());
 expect(await next.services.secrets.startup!.handTo('job')).toMatchObject([{state:'started'}]);expect(f.handTo).toHaveBeenCalledOnce();
});

it('coalesces overlapping stable-use retries into one dispatch and exposes the current durable state',async()=>{
 const f=fixture(),request=await f.request();await f.allow(request);let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
 f.handTo.mockImplementationOnce(async()=>{entered();await new Promise<void>(resolve=>{release=resolve;});});
 const input={id:randomUUID(),secret:'TOKEN'},receipt=randomUUID(),pending=f.call('use',input,raw.body,receipt);await started;
 const again=await f.call('use',input,raw.body,receipt);expect(again.body.value.state).toBe('started');expect(f.handTo).toHaveBeenCalledOnce();
 // A recreated service on the same committed data must also be metadata-only.
 const {SecretDelivery}=await import('./pieces/secrets/delivery.js');
 const replay=new SecretDelivery(f.db,()=>f.at,{handTo:f.handTo});
 expect(await replay.handTo('TOKEN','job',again.body.value.id)).toEqual(again.body.value);expect(f.handTo).toHaveBeenCalledOnce();
 release();expect((await pending).status).toBe(200);
 expect((await f.call('useStatus',{id:again.body.value.id})).body.value.state).toBe('released');
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
it('revalidates a captured body after box reassignment and rejects a newly revoked box',async()=>{
 const f=fixture(),request=await f.request();await f.allow(request);
 const proof=f.root.credentials.authenticate(new Request('http://loom',{headers:{authorization:'Bearer '+raw.body}}))!;
 const original=f.db.select().from(boxes).get()!;f.db.insert(boxes).values({...original,id:'replacement',name:'Replacement'}).run();
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});f.handTo.mockImplementationOnce(async()=>{entered();await new Promise<void>(resolve=>{release=resolve;});});
 const pending=f.call('use',{id:randomUUID(),secret:'TOKEN'});await started;
 f.root.writes.run(()=>f.db.update(jobs).set({box:'replacement'}).where(eq(jobs.id,'job')).run());
 expect(proof.valid()).toBe(false);expect(f.root.credentials.body(proof.viewer)).toBeUndefined();release();expect((await pending).status).toBe(403);
 // Fresh authentication retains the door's existing logical-job policy and
 // resolves the CURRENT box, rather than inventing an immutable-token-box rule.
 const fresh=f.root.credentials.authenticate(new Request('http://loom',{headers:{authorization:'Bearer '+raw.body}}))!;expect(f.root.credentials.body(fresh.viewer)?.box).toBe('replacement');
 f.root.writes.run(()=>f.db.update(boxes).set({revokedAt:f.at}).where(eq(boxes.id,'replacement')).run());
 expect((await f.call('requestStatus',{id:request})).status).toBe(401);expect(f.handTo).toHaveBeenCalledOnce();
});
it('publishes the started audit before dispatch and publishes no rolled-back audit',async()=>{
 const f=fixture(),request=await f.request();await f.allow(request);const events:{transaction:boolean;states:string[]}[]=[],original=DataLive.prototype.changed;
 vi.spyOn(DataLive.prototype,'changed').mockImplementation(function(this:DataLive){events.push({transaction:f.client.inTransaction,states:f.db.select().from(secretUses).all().map(row=>row.state)});return original.call(this);});
 f.handTo.mockImplementationOnce(async()=>{expect(events).toContainEqual({transaction:false,states:['started']});});
 expect((await f.call('use',{id:randomUUID(),secret:'TOKEN'})).status).toBe(200);expect(events.some(event=>event.states.includes('released'))).toBe(true);expect(events.every(event=>!event.transaction)).toBe(true);
 const before=f.db.select().from(secretUses).all().length;events.length=0;
 f.client.exec("CREATE TRIGGER fail_secret_audit BEFORE INSERT ON secret_uses BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
 expect((await f.call('use',{id:randomUUID(),secret:'TOKEN'})).status).toBe(503);expect(f.db.select().from(secretUses).all()).toHaveLength(before);
 expect(events.every(event=>event.states.every(state=>state==='released'))).toBe(true);expect(f.handTo).toHaveBeenCalledOnce();
});
it('drains an admitted HTTP handoff before closing the shared connection',async()=>{
 const f=fixture(),request=await f.request();await f.allow(request);let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});f.handTo.mockImplementationOnce(async()=>{entered();await new Promise<void>(resolve=>{release=resolve;});});
 const pending=f.call('use',{id:randomUUID(),secret:'TOKEN'});await started;let closed=false;const closing=f.root.close().then(()=>{closed=true;});
 expect((await f.call('requestStatus',{id:request})).status).toBe(503);expect(closed).toBe(false);release();expect((await pending).status).toBe(403);await closing;
 expect(f.db.select().from(secretUses).get()?.state).toBe('started');expect(f.client.open).toBe(true);
});

it('binds operation receipts to the actual body job before replaying request or handoff metadata',async()=>{
 const f=fixture(),input={id:randomUUID(),secret:'TOKEN',why:'Use it',minutes:5},requestReceipt=randomUUID();
 expect((await f.call('request',input,raw.body,requestReceipt)).status).toBe(200);await f.allow(input.id);
 expect((await f.call('request',input,raw.other,requestReceipt)).status).toBe(409);
 expect(f.db.select().from(secretRequests).all()).toHaveLength(1);
 const otherRequest={...input,id:randomUUID()};expect((await f.call('request',otherRequest,raw.other)).status).toBe(200);await f.allow(otherRequest.id);
 const use={id:randomUUID(),secret:'TOKEN'},receipt=randomUUID(),first=await f.call('use',use,raw.body,receipt);expect(first.status).toBe(200);
 const crossed=await f.call('use',use,raw.other,receipt);expect(crossed.status).toBe(409);expect(JSON.stringify(crossed.body)).not.toContain(first.body.value.id);expect(f.handTo).toHaveBeenCalledOnce();
 const separate=await f.call('use',use,raw.other);expect(separate.status).toBe(200);expect(separate.body.value.id).not.toBe(first.body.value.id);expect(f.handTo).toHaveBeenLastCalledWith('TOKEN',{agent:'art',job:'other'});
});
it('rejects extra identity fields on use and both status commands',async()=>{
 const f=fixture(),request=await f.request();await f.allow(request);
 expect((await f.call('use',{id:randomUUID(),secret:'TOKEN',job:'other'})).status).toBe(400);
 expect((await f.call('requestStatus',{id:request,agent:'other'})).status).toBe(400);
 const use=await f.call('use',{id:randomUUID(),secret:'TOKEN'});expect(use.status).toBe(200);
 expect((await f.call('useStatus',{id:use.body.value.id,job:'other'})).status).toBe(400);expect(f.handTo).toHaveBeenCalledOnce();
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
