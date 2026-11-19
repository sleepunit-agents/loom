import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { sharedRoot } from './shared-root.js';
import * as s from './core/data/schema.js';
const privateCalls=vi.hoisted(()=>{
 const fail=()=>{throw new Error('Provider execution forbidden in metadata commands');};
 return{spawn:vi.fn(fail),spawnSync:vi.fn(fail),exec:vi.fn(fail),execSync:vi.fn(fail),execFile:vi.fn(fail),execFileSync:vi.fn(fail),fork:vi.fn(fail)};
});
vi.mock('node:child_process',async original=>{const api={...await original<typeof import('node:child_process')>(),...privateCalls};return{...api,default:api};});
const clean:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();vi.unstubAllGlobals();});
const raw={alice:'a'.repeat(64),bob:'b'.repeat(64),admin:'h'.repeat(64),runner:'r'.repeat(64),agent:'g'.repeat(64),runnerTwo:'t'.repeat(64)};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function fixture(){
 const client=new Database(':memory:');clean.push(()=>{client.close();});
 const clock=new FakeClock(Date.parse('2026-11-15T12:00:00Z')),now=()=>new Date(clock.now()).toISOString(),db=createDataSchema(client,now);
 db.insert(s.members).values([{id:'alice',role:'member',joinedAt:now()},{id:'bob',role:'member',joinedAt:now()},{id:'admin',role:'owner',joinedAt:now()}]).run();
 db.insert(s.agents).values({id:'art',about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble',faceEyes:'dot'}).run();
 db.insert(s.memberAgents).values({member:'alice',agent:'art'}).run();
 for(const [id,owner]of[['one','alice'],['two','bob'],['revoked','alice']])db.insert(s.boxes).values({id,name:id,owner,sameMachineAsLoom:false,hostsAny:false,reportOnly:false,alwaysOn:false,enrolledAt:now(),revokedAt:id==='revoked'?now():null}).run();
 db.insert(s.tokens).values([
  ...(['alice','bob','admin']as const).map(id=>({fingerprint:hash(raw[id]),label:'Household owner '+id,kind:'owner' as const,member:id,createdAt:now()})),
  {fingerprint:hash(raw.runner),label:'Owner runner',kind:'runner',box:'one',createdAt:now()},
  {fingerprint:hash(raw.runnerTwo),label:'Owner other runner',kind:'runner',box:'two',createdAt:now()},
  {fingerprint:hash(raw.agent),label:'Owner agent',kind:'agent',agent:'art',createdAt:now()},
 ]).run();
 const errors=vi.fn(),root=sharedRoot({db,clock,originAllowed:()=>true,reportError:errors,modelRoles:()=>[{model:'model',provider:'provider',harness:'configured',series:'series'}]});clean.push(()=>root.close());
 const post=(name:string,input:unknown,who:keyof typeof raw='alice',id:string=randomUUID())=>root.http.request('/api/runtime/'+name,{method:'POST',headers:{authorization:'Bearer '+raw[who],'content-type':'application/json'},body:JSON.stringify({id,input})});
 const create=async(who:keyof typeof raw='alice')=>{const response=await post('accountCreate',{provider:'provider',label:'Subscription'},who);expect(response.status).toBe(200);return(await response.json()).value.id as string;};
 const basis=async(account:string,who:keyof typeof raw='runner')=>{const response=await post('accountUsageBasis',{account,owner:'alice',provider:'provider'},who);expect(response.status).toBe(200);return(await response.json()).value.basis as string;};
 const report=(account:string,basis:string,who:keyof typeof raw='runner')=>post('accountUsage',{account,owner:'alice',provider:'provider',basis,windows:[{name:'week',usage:0.2,readAt:now(),resetsAt:new Date(clock.now()+86400000).toISOString(),durationMs:86400000}]},who);
 return{client,db,root,now,post,create,basis,report,errors};
}
it.each(['alice','bob']as const)('creates metadata owned by %s, closed to admission until a fresh quota report',async who=>{
 const f=fixture(),id=await f.create(who);expect(f.db.select().from(s.modelAccounts).get()).toEqual({id,owner:who,provider:'provider',label:'Subscription',usage:0,usageReadAt:null,resetsAt:null,hasRoom:false});
 expect(f.db.select().from(s.modelAccountBoxes).all()).toEqual([]);expect(f.db.select().from(s.modelAccountWindows).all()).toEqual([]);
 expect((await f.post('accountRename',{account:id,label:'Renamed'},who)).status).toBe(200);expect(f.db.select().from(s.modelAccounts).get()?.label).toBe('Renamed');
});
it('replays creation once without creating another account',async()=>{
 const f=fixture(),input={provider:'provider',label:'Subscription'};
 const first=await(await f.post('accountCreate',input,'alice','create-once')).json(),again=await(await f.post('accountCreate',input,'alice','create-once')).json();
 expect(again).toEqual(first);expect(f.db.select().from(s.modelAccounts).all()).toHaveLength(1);
});
it.each(['bob','runner','agent']as const)('refuses %s account administration despite owner-looking token labels',async who=>{
 const f=fixture(),account=await f.create();
 for(const name of['accountRename','accountSignedIn','accountSignedOut']){
  const input=name==='accountRename'?{account,label:'Changed'}:{account,box:'one'};
  expect((await f.post(name,input,who)).status).toBe(403);
 }
 if(who!=='bob')expect((await f.post('accountCreate',{provider:'provider',label:'Other'},who)).status).toBe(403);
 expect(f.db.select().from(s.modelAccountBoxes).all()).toEqual([]);expect(f.db.select().from(s.modelAccounts).get()?.label).toBe('Subscription');
});
it('requires access to both the account and a live box for a sign-in report',async()=>{
 const f=fixture(),account=await f.create();
 for(const box of['two','revoked','missing'])expect((await f.post('accountSignedIn',{account,box})).status).toBe(403);
 expect((await f.post('accountSignedIn',{account,box:'one'})).status).toBe(200);
 expect((await f.post('accountSignedIn',{account,box:'two'},'admin')).status).toBe(200);
 expect(f.db.select().from(s.modelAccountBoxes).all()).toHaveLength(2);
 expect((await f.post('accountSignedOut',{account,box:'two'})).status).toBe(200);
 expect(f.db.select().from(s.modelAccountBoxes).all()).toEqual([{account,box:'one'}]);
 // What was learned about its sign-ins on that machine goes with the binding, and only that machine's.
 const at='2026-11-19T14:00:00.000Z',login={account,harness:'claude',place:'containers',state:'signed-out',checkedAt:at,since:at,learnedFrom:'check'} as const;
 f.db.insert(s.modelAccountBoxes).values({account,box:'two'}).run();
 f.db.insert(s.modelAccountLogins).values([{...login,box:'one'},{...login,box:'two'}]).run();
 expect((await f.post('accountSignedOut',{account,box:'two'})).status).toBe(200);
 expect(f.db.select().from(s.modelAccountLogins).all().map(row=>row.box)).toEqual(['one']);
});
it('uses the current household role rather than agent ownership or a retained owner label',async()=>{
 const f=fixture(),account=await f.create();
 expect((await f.post('accountRename',{account,label:'Admin label'},'admin')).status).toBe(200);
 f.root.writes.run(()=>f.db.update(s.members).set({role:'member'}).where(eq(s.members.id,'admin')).run());
 expect((await f.post('accountRename',{account,label:'Forbidden'},'admin')).status).toBe(403);
 expect(f.db.select().from(s.modelAccounts).get()?.label).toBe('Admin label');
});
it.each([{provider:'unknown',label:'Name'},{provider:'provider',label:'Name',owner:'bob'},{provider:'provider',label:'PRIVATE\nVALUE'}])('refuses unknown providers and caller-owned identity fields',async input=>{
 const f=fixture(),response=await f.post('accountCreate',input);expect([400,403]).toContain(response.status);expect(await response.text()).not.toContain('PRIVATE\nVALUE');expect(f.db.select().from(s.modelAccounts).all()).toEqual([]);
});
it('invalidates a pre-sign-in observation across a remove/re-add even when every quota value is identical',async()=>{
 const f=fixture(),account=await f.create();await f.post('accountSignedIn',{account,box:'one'});
 const old=await f.basis(account);expect((await f.post('accountSignedOut',{account,box:'one'})).status).toBe(200);expect((await f.post('accountSignedIn',{account,box:'one'})).status).toBe(200);
 expect(await(await f.report(account,old)).json()).toMatchObject({value:{recorded:false}});
 expect(f.db.select().from(s.modelAccountWindows).all()).toEqual([]);expect(f.db.select().from(s.modelAccounts).get()?.hasRoom).toBe(false);
 expect(await(await f.report(account,await f.basis(account))).json()).toMatchObject({value:{recorded:true}});
});
it('treats a fresh repeated sign-in as a new observation boundary but not cached receipt replay',async()=>{
 const f=fixture(),account=await f.create(),input={account,box:'one'};await f.post('accountSignedIn',input,'alice','original-login');
 const old=await f.basis(account);await f.post('accountSignedIn',input,'alice','fresh-login');expect(await(await f.report(account,old)).json()).toMatchObject({value:{recorded:false}});
 const current=await f.basis(account);await f.post('accountSignedIn',input,'alice','fresh-login');expect(await(await f.report(account,current)).json()).toMatchObject({value:{recorded:true}});
});
it('does not publish a membership generation when its receipt rolls back',async()=>{
 const f=fixture(),account=await f.create();await f.post('accountSignedIn',{account,box:'one'});
 const basis=await f.basis(account);
 f.client.exec("CREATE TEMP TRIGGER fail_account_receipt BEFORE INSERT ON operation_results WHEN NEW.id='rollback' BEGIN SELECT RAISE(ABORT,'fixture'); END");
 expect((await f.post('accountSignedOut',{account,box:'one'},'alice','rollback')).status).toBe(503);
 expect(f.db.select().from(s.modelAccountBoxes).where(and(eq(s.modelAccountBoxes.account,account),eq(s.modelAccountBoxes.box,'one'))).get()).toBeDefined();
 expect(await(await f.report(account,basis)).json()).toMatchObject({value:{recorded:true}});
});
it('rejects provider/owner/quota overposting and keeps a current usage read across a label-only edit',async()=>{
 const f=fixture(),account=await f.create();await f.post('accountSignedIn',{account,box:'one'});
 const basis=await f.basis(account);
 expect((await f.post('accountRename',{account,label:'New',provider:'other',owner:'bob',hasRoom:true})).status).toBe(400);
 expect((await f.post('accountRename',{account,label:'New'})).status).toBe(200);
 expect(await(await f.report(account,basis)).json()).toMatchObject({value:{recorded:true}});
 expect(f.db.select().from(s.modelAccounts).get()).toMatchObject({owner:'alice',provider:'provider',label:'New'});
});

it('invalidates a sign-out observation independently while another box remains authorized',async()=>{
 const f=fixture(),account=await f.create();
 expect((await f.post('accountSignedIn',{account,box:'one'})).status).toBe(200);
 expect((await f.post('accountSignedIn',{account,box:'two'},'admin')).status).toBe(200);
 const basis=await f.basis(account,'runnerTwo');
 expect((await f.post('accountSignedOut',{account,box:'one'})).status).toBe(200);
 expect(f.db.select().from(s.modelAccountBoxes).all()).toEqual([{account,box:'two'}]);
 expect(await(await f.report(account,basis,'runnerTwo')).json()).toMatchObject({value:{recorded:false}});
 expect(await(await f.report(account,await f.basis(account,'runnerTwo'),'runnerTwo')).json()).toMatchObject({value:{recorded:true}});
});
it('lets a current household owner remove another member account association',async()=>{
 const f=fixture(),account=await f.create();
 expect((await f.post('accountSignedIn',{account,box:'one'})).status).toBe(200);
 expect((await f.post('accountSignedOut',{account,box:'one'},'admin')).status).toBe(200);
 expect(f.db.select().from(s.modelAccountBoxes).all()).toEqual([]);
});
it('refuses a caller that only says it is a service for every account command',async()=>{
 const f=fixture(),account=await f.create(),service={kind:'service' as const,id:'runtime'};
 for(const [name,input]of [
  ['accountCreate',{provider:'provider',label:'Service account'}],
  ['accountRename',{account,label:'Service edit'}],
  ['accountSignedIn',{account,box:'one'}],
  ['accountSignedOut',{account,box:'one'}],
 ]as const){
  expect(f.root.operations.call('http',service,'runtime.'+name,input,'service-'+name)).toMatchObject({ok:false,code:'denied'});
 }
 expect(f.db.select().from(s.modelAccounts).all()).toHaveLength(1);expect(f.db.select().from(s.modelAccountBoxes).all()).toEqual([]);
});

it('records successful metadata changes without invoking a provider, private sign-in program or child process',async()=>{
 const network=vi.fn(async()=>{throw new Error('Provider network forbidden');});vi.stubGlobal('fetch',network);
 for(const spy of Object.values(privateCalls))spy.mockClear();
 const f=fixture(),account=await f.create();
 expect((await f.post('accountRename',{account,label:'Recorded label'})).status).toBe(200);
 expect((await f.post('accountSignedIn',{account,box:'one'})).status).toBe(200);
 expect((await f.post('accountSignedOut',{account,box:'one'})).status).toBe(200);
 expect(network).not.toHaveBeenCalled();for(const spy of Object.values(privateCalls))expect(spy).not.toHaveBeenCalled();
});
