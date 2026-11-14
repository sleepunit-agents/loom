import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fixture} from '../../fixture.js';
import {startLoom} from '../../foundation.js';
import {FakeClock,type Viewer} from '../../core/index.js';
import {HouseholdDatabase} from '../../core/household/document.js';
import {SharingDatabase} from '../../core/household/sharing.js';
import {signin,hash} from '../../core/signin/index.js';
import {runtimeStore} from './store.js';
import {runtimeHouseDestination} from './role.js';
import type {RuntimeRecords} from './records.js';
const closes:Array<()=>unknown>=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
async function setup(service?:string) {
 const home=mkdtempSync(join(tmpdir(),'runtime-secret-destination-'));closes.push(()=>rmSync(home,{recursive:true,force:true}));fixture(home);
 const clock=new FakeClock(),app=await startLoom({home,next:true,staging:true,clock,stdout(){}});closes.push(app.close);
 const auth=signin(app),store=runtimeStore(app.db),id=randomUUID(),house={repo:'/synthetic/art',houseFile:'house/house.json'};
 app.db.transaction(()=>{
  auth.tokens.replace({v:1,tokens:[]},{});
  for(const box of ['worker','other'])store.put('box',{id:box,name:box,owner:'jonathan',local:false,mayHost:'*',lentTo:[],facts:[],labels:[],alwaysOn:false,reportOnly:false,createdAt:clock.now()},clock.now());
  store.put('settings',{id:'art',agent:'art',boxes:['worker'],house},clock.now());
  store.put('job',{id,agent:'art',box:'worker',runner:'worker',title:'fixture',state:'running',createdAt:clock.now(),claimedAt:clock.now(),made:house,...(service?{service}:{})},clock.now());
 })();
 const token=service?'synthetic-service-body':app.db.transaction(()=>auth.issueBody('art',id))();
 if(service)auth.tokens.change(tokens=>tokens.push({role:`agent:art/${service}@${id}`,sha256:hash(token),label:'synthetic',created:new Date(clock.now()).toISOString()}));
 const viewer=auth.token(hash(token))!.viewer,sharing=()=>new SharingDatabase(app.db,home).sharing();
 const job=(set:Partial<RuntimeRecords['job']>)=>app.db.transaction(()=>{const {changedAt:_,...before}=store.read('job',id)!;store.put('job',{...before,...set},clock.now());})();
 const box=(set:Partial<RuntimeRecords['box']>)=>app.db.transaction(()=>{const {changedAt:_,...before}=store.read('box','worker')!;store.put('box',{...before,...set},clock.now());})();
 return {app,clock,store,auth,id,viewer,token,job,box,sharing,read:()=>runtimeHouseDestination(app,sharing,viewer)};
}
it.each([undefined,'slack'])('pins exact authenticated job/runner/box/claim and service %s without exposing a destination path',async service=>{
 const f=await setup(service),bound=f.read()!;
 expect(bound).toEqual({agent:'art',job:f.id,runner:'worker',box:'worker',claimedAt:f.clock.now(),...(service?{service}:{}),current:expect.any(Function)});
 expect(Object.isFrozen(bound)).toBe(true);expect(bound.current()).toBe(true);
 for(const viewer of [{...f.viewer},{kind:'agent',id:'art'},{kind:'runner',id:'worker'},{kind:'member',id:'jonathan'},{kind:'service',id:'secrets'}] as Viewer[])
  expect(runtimeHouseDestination(f.app,f.sharing,viewer)).toBeUndefined();
 f.job({runner:'other'});expect(bound.current()).toBe(false);expect(f.read()).toBeUndefined();
 f.job({runner:'other',box:'other'});expect(bound.current()).toBe(false);
 expect(f.read()).toMatchObject({runner:'other',box:'other'});
});
it.each([
 {state:'done' as const},{endedAt:1},{imported:{history:'unknown' as const}},
 {claimedAt:undefined},{claimedAt:123},{made:{repo:'/changed',houseFile:'house/house.json'}},
 {service:'other'},{principalReset:{approval:'synthetic',by:'jonathan',at:1}},{writtenOff:{approval:'synthetic',by:'jonathan',at:1}},
])('rechecks the original body and destination after job mutation %j',async mutation=>{
 const f=await setup(),bound=f.read()!;expect(bound.current()).toBe(true);
 f.job(mutation);expect(bound.current()).toBe(false);
 // A different claim is eligible only as a new binding, never the old one.
 if(mutation.claimedAt===123)expect(f.read()).toMatchObject({claimedAt:123});else expect(f.read()).toBeUndefined();
});
it.each([{revokedAt:1},{mayHost:[]},{reportOnly:true},{owner:'pollock',lentTo:[]}])('rechecks current box eligibility %j',async change=>{
 const f=await setup(),bound=f.read()!;f.box(change);expect(bound.current()).toBe(false);expect(f.read()).toBeUndefined();
});
it('refuses missing/current-house drift, revoked central proof, and policy-held execution',async()=>{
 const f=await setup(),bound=f.read()!;
 f.app.db.transaction(()=>{const {changedAt:_,...before}=f.store.read('settings','art')!;f.store.put('settings',{...before,house:{repo:'/new',houseFile:'house/house.json'}},f.clock.now());})();
 expect(bound.current()).toBe(false);expect(f.read()).toBeUndefined();
 f.app.db.transaction(()=>{const {changedAt:_,...before}=f.store.read('settings','art')!;f.store.put('settings',{...before,house:{repo:'/synthetic/art',houseFile:'house/house.json'}},f.clock.now());})();
 expect(bound.current()).toBe(true);
 f.auth.tokens.change(tokens=>{tokens.find(t=>t.sha256===hash(f.token))!.revoked=new Date(f.clock.now()).toISOString();});
 expect(bound.current()).toBe(false);expect(f.read()).toBeUndefined();
 const g=await setup(),other=g.read()!;
 expect(g.app.operations.call('direct',{kind:'member',id:'jonathan'},'runtime.configureBodyPolicy',{agent:'art',revision:0,gates:{people:{},agents:{}},policy:{}},'policy').ok).toBe(true);
 expect(other.current()).toBe(false);expect(g.read()).toBeUndefined();
});
it('never caches body proof across expiry or database shutdown',async()=>{
 const f=await setup(),bound=f.read()!;f.clock.advance(24*3600_000);expect(bound.current()).toBe(false);expect(f.read()).toBeUndefined();
 const g=await setup(),other=g.read()!;await g.app.close();expect(other.current()).toBe(false);expect(g.read()).toBeUndefined();
});
it('keeps the original destination through ordinary running/waiting metadata reports',async()=>{
 const f=await setup(),bound=f.read()!;f.job({state:'waiting',title:'new status'});expect(bound.current()).toBe(true);
 f.job({state:'running'});expect(bound.current()).toBe(true);
});

it('refuses retained proof after household agent removal even while the original token row remains',async()=>{
 const f=await setup(),bound=f.read()!,household=new HouseholdDatabase(f.app.db),before=household.document()!;
 f.app.db.transaction(()=>household.replace('',{...before,agents:before.agents.filter(agent=>agent!=='art')}))();
 expect(f.auth.tokens.records(hash(f.token))).toHaveLength(1);expect(f.auth.token(hash(f.token))).toBeUndefined();
 expect(bound.current()).toBe(false);expect(f.read()).toBeUndefined();
});
it('fences destinations synchronously when async shutdown begins, while SQLite remains open',async()=>{
 const f=await setup(),bound=f.read()!;const pending=f.app.close();
 expect(f.app.db.open).toBe(true);expect(bound.current()).toBe(false);expect(f.read()).toBeUndefined();
 await pending;
});
it.each(['house','settings'])('refuses absent current %s without a fallback destination',async missing=>{
 const f=await setup(),bound=f.read()!;
 f.app.db.transaction(()=>{
  if(missing==='settings')f.app.db.prepare('DELETE FROM runtime_settings WHERE id=?').run('art');
  else {const {changedAt:_,house:__,...before}=f.store.read('settings','art')!;f.store.put('settings',before,f.clock.now());}
 })();
 expect(bound.current()).toBe(false);expect(f.read()).toBeUndefined();
});
it.each(['agent:art','agent:mark@JOB','agent:art/slack@JOB'])('refuses a changed live central role %s on original proof',async role=>{
 const f=await setup(),bound=f.read()!;
 f.auth.tokens.change(tokens=>{tokens.find(t=>t.sha256===hash(f.token))!.role=role.replace('JOB',f.id);});
 expect(f.auth.token(hash(f.token))).toBeDefined();
 expect(bound.current()).toBe(false);expect(f.read()).toBeUndefined();
});
