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
import {runtimeStore} from '../runtime/store.js';
import type {RuntimeRecords} from '../runtime/records.js';
import {secretTickets} from './tickets.js';
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
 const owner:Viewer={kind:'member',id:'jonathan'}; let seq=0;
 const call=(op:string,input:unknown)=>{const result=app.operations.call('direct',owner,op,input,`ticket-test-${++seq}`);expect(result.ok,JSON.stringify(result)).toBe(true);return result;};
 call('secrets.describe',{name:'API',description:''});
 const scope={house:id,...(service?{service}:{})};
 const grant={agent:'art',kind:'secret',target:'API',scope,expiresAt:clock.now()+60_000};
 call('secrets.grant',grant);
 const tickets=secretTickets(app,sharing,app.effects!);
 const admit=()=>tickets.admit(viewer,'API');
 const release=(ticket:string)=>call('core.releaseEffect',{id:`secrets:handoff:${ticket}`});
 const claim=()=>{const ticket=admit();expect(tickets.claim(ticket.id)).toBeNull();release(ticket.id);const c=tickets.claim(ticket.id);expect(c).not.toBeNull();return {ticket,c:c!};};
 return {home,app,clock,store,auth,id,viewer,token,job,box,sharing,call,tickets,admit,release,claim,grant};
}
it.each([undefined,'slack'])('holds before claim and consumes once for exact current service %s',async service=>{
 const f=await setup(service),{ticket,c}=f.claim();
 expect(ticket).toEqual({id:expect.any(String),expiresAt:f.clock.now()+30_000});
 expect(c.name).toBe('API');expect(c.destination).toMatchObject({job:f.id,runner:'worker',box:'worker',...(service?{service}:{})});
 expect(c.current()).toBe(true);expect(f.tickets.claim(ticket.id)).toBeNull();
 c.finish(true);expect(c.current()).toBe(false);expect(f.tickets.claim(ticket.id)).toBeNull();
 expect(f.app.db.prepare('SELECT state FROM secrets_tickets').get()).toEqual({state:'released'});
 expect(f.app.effects!.status(`secrets:handoff:${ticket.id}`)).toBe('done');
});
it('rejects unauthenticated/copy viewers, missing names and wrong-scope grants',async()=>{
 const f=await setup();
 for(const viewer of [{...f.viewer},{kind:'member',id:'jonathan'},{kind:'runner',id:'worker'},{kind:'agent',id:'art'}] as Viewer[])
  expect(()=>f.tickets.admit(viewer,'API')).toThrow('Secret handoff unavailable');
 expect(()=>f.tickets.admit(f.viewer,'MISSING')).toThrow();
 const {expiresAt:_,...revoke}=f.grant;f.call('secrets.revoke',revoke);
 f.call('secrets.grant',{...f.grant,scope:{house:randomUUID()}});
 expect(f.admit).toThrow();
 expect(f.app.db.prepare('SELECT * FROM secrets_tickets').all()).toEqual([]);
});
it.each(['grant','policy','name'] as const)('permanently revokes tickets on %s removal/change even after exact restoration',async subject=>{
 const f=await setup(),{ticket,c}=f.claim();
 if(subject==='grant') {
  const row=f.app.db.prepare('SELECT * FROM secrets_grants').get() as {id:string;agent:string;kind:string;target:string;record:string};
  f.app.db.prepare('DELETE FROM secrets_grants WHERE id=?').run(row.id);
  f.app.db.prepare('INSERT INTO secrets_grants VALUES (?,?,?,?,?)').run(row.id,row.agent,row.kind,row.target,row.record);
 } else if(subject==='name') {
  const row=f.app.db.prepare('SELECT * FROM secrets_names').get() as {id:string;record:string};
  f.app.db.prepare('DELETE FROM secrets_names WHERE id=?').run(row.id);
  f.app.db.prepare('INSERT INTO secrets_names VALUES (?,?)').run(row.id,row.record);
 } else {
  f.call('secrets.policy',{default:'never',secrets:{}});
  f.app.db.prepare("DELETE FROM secrets_meta WHERE key='policy'").run();
 }
 expect(c.current()).toBe(false);c.finish(true);
 expect(f.app.db.prepare('SELECT state FROM secrets_tickets WHERE id=?').get(ticket.id)).toEqual({state:'revoked'});
 expect(f.app.effects!.status(`secrets:handoff:${ticket.id}`)).toBe('uncertain');
});
it.each(['admitted','claimed'] as const)('expires %s tickets at the exact grant deadline',async state=>{
 const f=await setup();f.call('secrets.grant',{...f.grant,expiresAt:f.clock.now()+1000});
 const ticket=f.admit();expect(ticket.expiresAt).toBe(f.clock.now()+1000);
 expect(f.tickets.claim(ticket.id)).toBeNull();f.release(ticket.id);
 const c=state==='claimed'?f.tickets.claim(ticket.id):null;
 f.clock.advance(1000);
 expect(f.tickets.claim(ticket.id)).toBeNull();if(c)expect(c.current()).toBe(false);
});
it.each([{state:'done' as const},{claimedAt:123},{runner:'other',box:'other'},{service:'other'}])('fences release on Runtime mutation %j',async mutation=>{
 const f=await setup(),{c}=f.claim();f.job(mutation);expect(c.current()).toBe(false);c.finish(true);
 expect(f.app.db.prepare('SELECT state FROM secrets_tickets').get()).toEqual({state:'uncertain'});
});
it('requires current policy even with a valid surviving grant and cannot replace a revoked grant',async()=>{
 const f=await setup();f.call('secrets.policy',{default:'never',secrets:{}});expect(f.admit).toThrow();
 f.app.db.prepare("DELETE FROM secrets_meta WHERE key='policy'").run();
 const {c}=f.claim();f.call('secrets.grant',f.grant);expect(c.current()).toBe(false);
});
it('never reconstructs authority from persisted metadata or retries an uncertain claim',async()=>{
 const f=await setup(),ticket=f.admit();expect(f.tickets.claim(ticket.id)).toBeNull();f.release(ticket.id);
 const restarted=secretTickets(f.app,f.sharing,f.app.effects!);expect(restarted.claim(ticket.id)).toBeNull();
 const c=f.tickets.claim(ticket.id)!;expect(c.current()).toBe(true);c.finish(false);
 expect(f.tickets.claim(ticket.id)).toBeNull();expect(restarted.claim(ticket.id)).toBeNull();
 expect(f.app.db.prepare('SELECT state FROM secrets_tickets').get()).toEqual({state:'uncertain'});
});
it('fences at shutdown before SQLite closes, and keeps every public operation unregistered',async()=>{
 const f=await setup(),{c}=f.claim();
 for(const name of ['secrets.get','secrets.ticket','secrets.claimTicket'])expect(f.app.operations.has(name)).toBe(false);
 const pending=f.app.close();expect(f.app.db.open).toBe(true);expect(c.current()).toBe(false);await pending;
 expect(c.current()).toBe(false);expect(()=>f.admit()).toThrow('Secret handoff unavailable');
});
it('rolls back admission and fails closed on claim persistence failure',async()=>{
 const f=await setup();
 f.app.db.exec("CREATE TRIGGER fail_ticket BEFORE INSERT ON secrets_tickets BEGIN SELECT RAISE(ABORT,'synthetic'); END");
 expect(f.admit).toThrow('Secret handoff unavailable');expect(f.app.db.prepare('SELECT * FROM secrets_tickets').all()).toEqual([]);
 f.app.db.exec('DROP TRIGGER fail_ticket');const ticket=f.admit();
 expect(f.tickets.claim(ticket.id)).toBeNull();f.release(ticket.id);
 f.app.db.exec("CREATE TRIGGER fail_ticket_claim BEFORE UPDATE ON secrets_tickets BEGIN SELECT RAISE(ABORT,'synthetic'); END");
 expect(f.tickets.claim(ticket.id)).toBeNull();f.app.db.exec('DROP TRIGGER fail_ticket_claim');
 expect(f.tickets.claim(ticket.id)).toBeNull();expect(f.app.effects!.status(`secrets:handoff:${ticket.id}`)).toBe('started');
});
it.each(['admitted','claimed'] as const)('retains %s one-use state across an actual daemon restart without recreating proof',async state=>{
 const f=await setup(),ticket=f.admit();
 expect(f.tickets.claim(ticket.id)).toBeNull();f.release(ticket.id);
 if(state==='claimed')expect(f.tickets.claim(ticket.id)?.current()).toBe(true);
 const before=f.app.db.prepare('SELECT * FROM secrets_tickets').all();
 await f.app.close();
 const app=await startLoom({home:f.home,next:true,staging:true,clock:f.clock,stdout(){}});closes.push(app.close);
 const sharing=()=>new SharingDatabase(app.db,f.home).sharing();
 expect(app.db.prepare('SELECT * FROM secrets_tickets').all()).toEqual(before);
 expect(secretTickets(app,sharing,app.effects!).claim(ticket.id)).toBeNull();
 expect(app.effects!.status(`secrets:handoff:${ticket.id}`)).toBe(state==='claimed'?'uncertain':'released');
});
it('rejects claiming and settling inside a rollbackable metadata transaction',async()=>{
 const f=await setup(),{ticket,c}=f.claim();
 f.app.db.transaction(()=>{expect(f.tickets.claim(ticket.id)).toBeNull();expect(()=>c.finish(true)).toThrow('Secret handoff unavailable');})();
 expect(c.current()).toBe(true);c.finish(false);
 expect(f.app.db.prepare('SELECT state FROM secrets_tickets').get()).toEqual({state:'uncertain'});
});
it('refuses a moved grant and a retained grant whose secret name no longer exists',async()=>{
 const f=await setup();
 const row=f.app.db.prepare('SELECT id,record FROM secrets_grants').get() as {id:string;record:string};
 f.app.db.prepare('UPDATE secrets_grants SET record=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.record),movedTo:'q-synthetic'}),row.id);
 expect(f.admit).toThrow('Secret handoff unavailable');
 f.app.db.prepare('UPDATE secrets_grants SET record=? WHERE id=?').run(row.record,row.id);
 expect(f.admit()).toMatchObject({id:expect.any(String)});
 f.app.db.prepare("DELETE FROM secrets_names WHERE id='API'").run();
 expect(f.app.db.prepare('SELECT record FROM secrets_grants').get()).toEqual({record:row.record});
 expect(f.admit).toThrow('Secret handoff unavailable');
});
it('fences a retained claim and its final acknowledgement when its outside effect becomes uncertain',async()=>{
 const f=await setup(),{ticket,c}=f.claim();
 f.app.effects!.finish(`secrets:handoff:${ticket.id}`,false);
 expect(c.destination.current()).toBe(true);expect(c.current()).toBe(false);c.finish(true);
 expect(f.app.db.prepare('SELECT state FROM secrets_tickets').get()).toEqual({state:'uncertain'});
 expect(f.app.effects!.status(`secrets:handoff:${ticket.id}`)).toBe('uncertain');
});
it('requires exact grant service even when the house and agent match',async()=>{
 const f=await setup('slack'),{expiresAt:_,...revoke}=f.grant;
 f.call('secrets.revoke',revoke);
 f.call('secrets.grant',{...f.grant,scope:{house:f.id,service:'discord'}});
 expect(f.admit).toThrow('Secret handoff unavailable');
 f.call('secrets.grant',f.grant);expect(f.admit()).toMatchObject({id:expect.any(String)});
});

it('binds an original worker request once, snapshots it and retains it only in the original claim',async()=>{
 const f=await setup('slack');
 const request={id:randomUUID(),binding:{agent:'art',job:f.id,runner:'worker',box:'worker',claimedAt:f.clock.now(),service:'slack'}};
 const original=request.id,t=f.tickets.admit(f.viewer,'API',request);
 request.id=randomUUID();request.binding.runner='other';
 expect(f.tickets.claim(t.id)).toBeNull();f.release(t.id);const c=f.tickets.claim(t.id)!;expect(c.pendingId).toBe(original);expect(c.current()).toBe(true);
 expect(secretTickets(f.app,f.sharing,f.app.effects!).claim(t.id)).toBeNull();
 c.finish(false);
 expect(()=>f.tickets.admit(f.viewer,'API',{id:original,binding:{...request.binding,runner:'worker'}})).toThrow();
 expect(f.tickets.claim(t.id)).toBeNull();
});
it.each(['agent','job','runner','box','claimedAt','service','id'])('rejects mismatched pending %s before admission or outside IO',async field=>{
 const f=await setup('slack');
 const request={id:randomUUID(),binding:{agent:'art',job:f.id,runner:'worker',box:'worker',claimedAt:f.clock.now(),service:'slack'}};
 if(field==='id')request.id='not-a-request';
 else Object.assign(request.binding,{[field]:field==='claimedAt'?123:field==='job'?randomUUID():'other'});
 expect(()=>f.tickets.admit(f.viewer,'API',request)).toThrow(/^Secret handoff unavailable$/);
 expect(f.app.db.prepare('SELECT * FROM secrets_tickets').all()).toEqual([]);
});
it('burns the pending binding across two admissions before claim and after failed acknowledgement',async()=>{
 const f=await setup(),request={id:randomUUID(),binding:{agent:'art',job:f.id,runner:'worker',box:'worker',claimedAt:f.clock.now()}};
 const t=f.tickets.admit(f.viewer,'API',request);
 expect(()=>f.tickets.admit(f.viewer,'API',request)).toThrow();
 expect(f.tickets.claim(t.id)).toBeNull();f.release(t.id);f.tickets.claim(t.id)!.finish(false);
 expect(()=>f.tickets.admit(f.viewer,'API',request)).toThrow();
});
it('does not burn the pending binding when admission itself rolls back',async()=>{
 const f=await setup(),request={id:randomUUID(),binding:{agent:'art',job:f.id,runner:'worker',box:'worker',claimedAt:f.clock.now()}};
 f.app.db.exec("CREATE TRIGGER fail_pending BEFORE INSERT ON secrets_tickets BEGIN SELECT RAISE(ABORT,'synthetic'); END");
 expect(()=>f.tickets.admit(f.viewer,'API',request)).toThrow();
 f.app.db.exec('DROP TRIGGER fail_pending');const t=f.tickets.admit(f.viewer,'API',request);
 expect(f.tickets.claim(t.id)).toBeNull();f.release(t.id);expect(f.tickets.claim(t.id)?.pendingId).toBe(request.id);
});
