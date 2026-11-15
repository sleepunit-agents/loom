import { DataLive } from './core/data/live.js';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { members, tokens, agents, household, secrets, secretChanges, secretWriteJournal, secretRequests, secretRules, secretRuleAgents, secretGrants, jobs, operationResults, inbox } from './core/data/schema.js';
import { sharedRoot } from './shared-root.js';
const clean:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of clean.splice(0).reverse())await close();});
function fixture(keyByte=7){
 const client=new Database(':memory:');clean.push(()=>{client.close();});const clock=new FakeClock(),at=new Date(clock.now()).toISOString();
 const db=createDataSchema(client),owner='a'.repeat(64),peer='b'.repeat(64);
 for(const [id,token] of [['owner',owner],['peer',peer]]){
  db.insert(members).values({id,role:id==='owner'?'owner':'member',joinedAt:at}).run();
  db.insert(tokens).values({fingerprint:createHash('sha256').update(token).digest('hex'),kind:'owner',member:id,label:id,createdAt:at}).run();
 }
 db.insert(agents).values({id:'art',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();
 const held=new Map<string,string>(),receipts=new Set<string>();
 const holder={hasReceipt:vi.fn(async(who:{writeId:string})=>receipts.has(who.writeId)),
  set:vi.fn(async(who:{writeId:string},name:string,value:Buffer)=>{held.set(name,value.toString());receipts.add(who.writeId);}),
  remove:vi.fn(async(who:{writeId:string},name:string)=>{held.delete(name);receipts.add(who.writeId);}),
  recover:vi.fn(async(who:{writeId:string}):Promise<'committed'|'undone'>=>receipts.has(who.writeId)?'committed':'undone'),};
 const errors:unknown[]=[];
 const root=sharedRoot({db,clock,originAllowed:()=>true,reportError:error=>{errors.push(error);},secretWrites:{holder,fingerprintKey:Buffer.alloc(32,keyByte)}});clean.push(()=>root.close());
 const call=async(op:string,input:unknown,token=owner,id=randomUUID())=>{
  const response=await root.http.request(`http://loom/api/secrets/${op}`,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({input,id})});
  return {status:response.status,body:await response.json()};
 };
 return {db,client,clock,at,owner,peer,holder,held,root,call,errors};
}
it('admits only owners, binds the authenticated actor and stores no raw value in main data or receipts',async()=>{
 const f=fixture(),input={id:randomUUID(),name:'TOKEN',mode:'add',value:'synthetic-private-value'};
 expect((await f.call('set',input,f.peer)).status).toBe(403);expect(f.holder.set).not.toHaveBeenCalled();
 expect((await f.call('set',{...input,member:'owner'})).status).toBe(400);
 expect(await f.call('set',input)).toEqual({status:200,body:{ok:true,value:{saved:true}}});
 expect(f.held.get('TOKEN')).toBe(input.value);
 expect(f.db.select().from(secrets).get()?.changedBy).toBe('owner');
 expect(f.client.serialize().includes(Buffer.from(input.value))).toBe(false);
 const hash=f.db.select().from(secretWriteJournal).get()!.inputHash;expect(hash).not.toBe(createHash('sha256').update(input.value).digest('hex'));
 expect((await f.call('set',input)).status).toBe(200);expect(f.holder.set).toHaveBeenCalledOnce();
 expect((await f.call('set',{...input,value:'changed'})).status).toBe(503);expect(f.holder.set).toHaveBeenCalledOnce();
 expect((await f.call('remove',{id:randomUUID(),name:'TOKEN'})).status).toBe(200);expect(f.held.has('TOKEN')).toBe(false);
 expect(f.db.select().from(secretChanges).all().map(r=>r.action)).toEqual(['add','removed']);
});
it('rechecks owner permission on replay and after asynchronous holder work',async()=>{
 const f=fixture(),input={id:randomUUID(),name:'TOKEN',mode:'add',value:'synthetic-private-value'},receipt=randomUUID();
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),wait=new Promise<void>(resolve=>{release=resolve;});
 const original=f.holder.set.getMockImplementation()!;
 f.holder.set.mockImplementation(async(...args)=>{entered();await wait;return original(...args);});
 const pending=f.call('set',input,f.owner,receipt);await started;
 f.db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run();release();
 expect((await pending).status).toBe(403);
 expect(f.db.select().from(secretWriteJournal).get()?.state).toBe('committed');
 expect((await f.call('set',input,f.owner,receipt)).status).toBe(403);expect(f.holder.set).toHaveBeenCalledOnce();
});
it('owner commands apply validated rules/defaults and answer, cancel or revoke metadata through the shared boundary',async()=>{
 const f=fixture();await f.call('set',{id:randomUUID(),name:'TOKEN',mode:'add',value:'synthetic'});
 const rule={action:'rule',secret:'TOKEN',answer:'auto',minutes:10,agents:[{agent:'art',when:'on_request'}]};
 expect((await f.call('command',rule,f.peer)).status).toBe(403);
 expect((await f.call('command',rule)).status).toBe(200);expect(f.db.select().from(secretRuleAgents).get()?.agent).toBe('art');
 expect((await f.call('command',{action:'default',answer:'never'})).status).toBe(200);expect(f.db.select().from(household).get()?.secretsDefault).toBe('never');
 await f.call('command',{...rule,answer:'ask'});
 f.db.insert(jobs).values({id:'job',agent:'art',title:'',brief:'',model:'test',state:'running',startedByKind:'agent',startedBy:'art',houseRepository:'',houseFile:'',houseBranch:'',queuedAt:f.at}).run();
 f.root.writes.run(()=>f.root.services.secrets.requests.request({id:'request',secret:'TOKEN',agent:'art',job:'job',why:'Use it',minutes:5}));
 expect((await f.call('command',{action:'answer',id:'request',allow:true,always:true})).status).toBe(200);
 const grant=f.db.select().from(secretGrants).get()!;expect(grant.request).toBe('request');
 expect((await f.call('command',{action:'revoke',id:grant.id})).status).toBe(200);expect(f.db.select().from(secretGrants).all()).toEqual([]);expect(f.db.select().from(secretRequests).get()?.state).toBe('revoked');
 expect(f.db.select().from(secretRules).get()?.answer).toBe('auto');
});

it('close drains an admitted holder call and a new root recovers its committed receipt without retaining caller input',async()=>{
 const f=fixture(),input={id:randomUUID(),name:'TOKEN',mode:'add',value:'synthetic-late-secret'};
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),wait=new Promise<void>(resolve=>{release=resolve;});
 const original=f.holder.set.getMockImplementation()!;
 f.holder.set.mockImplementation(async(...args)=>{entered();await wait;return original(...args);});
 const pending=f.call('set',input);await started;
 const closing=f.root.close();let closed=false;void closing.then(()=>{closed=true;});
 expect(closed).toBe(false);release();expect((await pending).status).toBe(403);await closing;
 expect(f.db.select().from(secretWriteJournal).get()?.state).toBe('prepared');
 expect(f.db.select().from(secretChanges).all()).toEqual([]);
 const next=sharedRoot({db:f.db,clock:f.clock,originAllowed:()=>true,reportError:()=>{},secretWrites:{holder:f.holder,fingerprintKey:Buffer.alloc(32,7)}});clean.push(()=>next.close());
 await next.services.secrets.reconcile();
 expect(f.db.select().from(secretWriteJournal).get()?.state).toBe('committed');
 expect(f.db.select().from(secretChanges).all()).toMatchObject([{action:'add',secret:'TOKEN'}]);
 expect(f.holder.set).toHaveBeenCalledOnce();expect(f.client.serialize().includes(Buffer.from(input.value))).toBe(false);
});
it('the mounted recovery caller releases definitively undone writes, while holder errors remain fixed and retryable',async()=>{
 const f=fixture(),input={id:randomUUID(),name:'TOKEN',mode:'add',value:'synthetic-never-saved'};
 f.holder.set.mockRejectedValue(new Error(input.value));
 const failed=await f.call('set',input);expect(failed.status).toBe(503);expect(JSON.stringify(failed.body)).not.toContain(input.value);
 expect(f.db.select().from(secretWriteJournal).get()?.state).toBe('prepared');
 await f.root.services.secrets.reconcile();
 expect(f.db.select().from(secretWriteJournal).get()?.state).toBe('undone');expect(f.db.select().from(secretChanges).all()).toEqual([]);
 expect((await f.call('set',input)).status).toBe(503);
 f.holder.set.mockImplementation(async(who,name,value)=>{f.held.set(name,value.toString());});
 expect((await f.call('set',{...input,id:randomUUID()})).status).toBe(200);
});

it('denies replay of an actually successful value receipt after owner revocation',async()=>{
 const f=fixture(),input={id:randomUUID(),name:'TOKEN',mode:'add',value:'synthetic'},receipt=randomUUID();
 expect((await f.call('set',input,f.owner,receipt)).status).toBe(200);
 expect(f.db.select().from(operationResults).get()?.id).toBe(receipt);
 f.db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run();
 expect((await f.call('set',input,f.owner,receipt)).status).toBe(403);expect(f.holder.set).toHaveBeenCalledOnce();
});
it('binds both persisted fingerprints to the private key and all value-write input fields',async()=>{
 const input={id:randomUUID(),name:'TOKEN',mode:'add',description:'A description',value:'synthetic'};
 const run=async(keyByte:number,change:Partial<typeof input>={})=>{
  const f=fixture(keyByte),value={...input,...change};
  if(value.mode==='replace'){
   await f.call('set',{id:randomUUID(),name:value.name,mode:'add',value:'old'});
  }
  const receipt=randomUUID();expect((await f.call('set',value,f.owner,receipt)).status).toBe(200);
  const journal=f.db.select().from(secretWriteJournal).where(eq(secretWriteJournal.id,value.id)).get()!.inputHash;
  const operation=f.db.select().from(operationResults).where(eq(operationResults.id,receipt)).get()!.inputHash;
  const canonical=JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))));
  expect(operation).toBe(createHmac('sha256',Buffer.alloc(32,keyByte)).update('loom-shared-secret-operation-v1\0').update(canonical).digest('hex'));
  expect(journal).toBe(createHmac('sha256',Buffer.alloc(32,keyByte)).update('loom-shared-secret-write-v1\0').update(JSON.stringify(['owner',value.id,value.name,value.mode,value.description,value.value])).digest('hex'));
  return {journal,operation};
 };
 const baseline=await run(7);expect(await run(9)).not.toEqual(baseline);
 for(const change of [{id:randomUUID()},{name:'OTHER'},{mode:'replace'},{description:'Different'},{value:'another-synthetic'}]){
  const changed=await run(7,change);expect(changed.journal).not.toBe(baseline.journal);expect(changed.operation).not.toBe(baseline.operation);
 }
});
it('the startup and recurring clock callbacks drive abandoned-write recovery without a request',async()=>{
 const f=fixture();
 const seed=()=>{const id=randomUUID();f.db.insert(secretWriteJournal).values({id,member:'owner',secret:'TOKEN',operation:'add',description:'',inputHash:'d'.repeat(64),state:'prepared',startedAt:f.at}).run();return id;};
 const first=seed();f.clock.advance(0);expect(f.holder.recover).toHaveBeenCalledOnce();await f.root.services.secrets.reconcile();
 expect(f.db.select().from(secretWriteJournal).where(eq(secretWriteJournal.id,first)).get()?.state).toBe('undone');
 const second=seed();f.clock.advance(59999);expect(f.holder.recover).toHaveBeenCalledOnce();f.clock.advance(1);
 expect(f.holder.recover).toHaveBeenCalledTimes(2);await f.root.services.secrets.reconcile();
 expect(f.db.select().from(secretWriteJournal).where(eq(secretWriteJournal.id,second)).get()?.state).toBe('undone');
});
it('close waits an active recovery and fences its late metadata completion',async()=>{
 const f=fixture(),id=randomUUID();f.db.insert(secretWriteJournal).values({id,member:'owner',secret:'TOKEN',operation:'add',description:'',inputHash:'d'.repeat(64),state:'prepared',startedAt:f.at}).run();
 let release!:(value:'committed')=>void;f.holder.recover.mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
 f.clock.advance(0);expect(f.holder.recover).toHaveBeenCalledOnce();
 let closed=false;const closing=f.root.close().then(()=>{closed=true;});
 expect((await f.call('command',{action:'default',answer:'ask'})).status).toBe(503);expect(closed).toBe(false);
 release('committed');await closing;
 expect(f.db.select().from(secretWriteJournal).get()?.state).toBe('prepared');expect(f.db.select().from(secretChanges).all()).toEqual([]);
});
it('cancels a pending request and resolves the associated Inbox question',async()=>{
 const f=fixture();await f.call('set',{id:randomUUID(),name:'TOKEN',mode:'add',value:'synthetic'});
 f.root.writes.run(()=>f.root.services.secrets.requests.request({id:'pending',secret:'TOKEN',agent:'art',why:'Use it',minutes:5}));
 expect(f.db.select().from(inbox).get()?.state).toBe('waiting');
 expect((await f.call('command',{action:'cancel',id:'pending'})).status).toBe(200);
 expect(f.db.select().from(secretRequests).get()?.state).toBe('cancelled');expect(f.db.select().from(inbox).get()?.state).toBe('resolved');
});

it('publishes a reconciliation audit through the shared live write boundary only after commit',async()=>{
 const f=fixture(),id=randomUUID();
 f.db.insert(secretWriteJournal).values({id,member:'owner',secret:'TOKEN',operation:'add',description:'',inputHash:'d'.repeat(64),state:'prepared',startedAt:f.at}).run();
 f.holder.recover.mockResolvedValue('committed');
 const seen:unknown[]=[],original=DataLive.prototype.changed;
 vi.spyOn(DataLive.prototype,'changed').mockImplementation(function(this:DataLive){
  seen.push({inTransaction:f.client.inTransaction,state:f.db.select().from(secretWriteJournal).get()?.state,changes:f.db.select().from(secretChanges).all().map(row=>row.action)});
  return original.call(this);
 });
 await f.root.services.secrets.reconcile();
 expect(seen.length).toBeGreaterThan(0);
 for(const notification of seen)expect(notification).toEqual({inTransaction:false,state:'committed',changes:['add']});
});

it('reports fixed notification failures without retaining a credential in diagnostics',async()=>{
 const f=fixture(),value='synthetic-private-diagnostic';
 vi.spyOn(DataLive.prototype,'changed').mockImplementation(()=>{throw Error(value);});
 expect((await f.call('set',{id:randomUUID(),name:'TOKEN',mode:'add',value})).status).toBe(200);
 const messages=f.errors.map(error=>(error as Error).message);
 // Memory/Tempo compose more post-commit observers; every diagnostic remains fixed.
 expect(new Set(messages)).toEqual(new Set(['Secret write notification failed','Shared operation notification failed']));
 expect(f.errors.map(String).join(' ')).not.toContain(value);
});
it('trusted installed services use an existing nonowner attribution without outside grants',async()=>{
 const f=fixture();
 expect(await f.root.services.secrets.values!.set({id:randomUUID(),member:'peer',name:'TOKEN',mode:'add',value:'synthetic'})).toEqual({saved:true});
 expect(f.db.select().from(secrets).get()?.changedBy).toBe('peer');
 f.root.writes.run(()=>{
  f.root.services.secrets.requests.request({id:'trusted',secret:'TOKEN',agent:'art',why:'Installed caller',minutes:5});
  f.root.services.secrets.requests.answer('trusted','peer',true);
 });
 expect(f.db.select().from(secretRequests).get()).toMatchObject({state:'allowed',answeredBy:'peer'});
 expect(f.db.select().from(secretGrants).get()?.grantedBy).toBe('peer');
});
