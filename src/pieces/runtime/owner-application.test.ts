import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { signin, hash } from '../../core/signin/index.js';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { fixture } from '../../fixture.js';
import { provenanceStore } from './provenance-store.js';
import { SharingDatabase } from '../../core/household/sharing.js';
import { installRuntime } from './index.js';
import type { RuntimeCredentials } from './credentials.js';
import { runtimeStore } from './store.js';
import { owningApprovalCards } from '../approvals/role.js';
const closes:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
const owner:Viewer={kind:'member',id:'jonathan'};
async function setup(custom?: {credentials?:RuntimeCredentials}){
 const home=mkdtempSync(join(tmpdir(),'runtime-owner-'));closes.push(()=>rmSync(home,{recursive:true,force:true}));fixture(home);
 const clock=new FakeClock();
 const open=async()=>{const app=await startLoom({home,clock,next:true,stdout:()=>{},...(custom?{install(app){installRuntime(app.db,app.operations,app.live,()=>new SharingDatabase(app.db,home).sharing(),custom);}}:{})});closes.push(app.close);return app;};
 const app=await open(),store=runtimeStore(app.db);
 app.db.transaction(()=>{
  store.put('box',{id:'r1',name:'remote',owner:'jonathan',local:false,mayHost:'*',lentTo:[],facts:[],labels:[],alwaysOn:false,reportOnly:false,createdAt:1,lastSeen:clock.now()-700_000},1);
  for(const id of ['covered','later','private','done'])store.put('job',{id,agent:'art',box:'r1',runner:'r1',title:id,state:id==='done'?'done':'running',createdAt:1,...(id==='private'?{member:'jonathan'}:{}),...(id==='done'?{endedAt:2}:{})},1);
 })();
 let seq=0;
 const call=(op:string,input:unknown,v=owner,id=`owner-${++seq}`)=>app.operations.call('direct',v,op,input,id);
 const ask=()=>{const r=call('runtime.askWriteOff',{agent:'art',box:'r1'});expect(r,JSON.stringify(r)).toMatchObject({ok:true});return (r as {value:{approval:string}}).value.approval;};
 return {app,store,clock,home,open,call,ask};
}
it('applies only the original covered jobs and leaves box, preferences and later work alone',async()=>{
 const f=await setup(),approval=f.ask();
 f.app.db.transaction(()=>f.store.put('job',{id:'new',agent:'art',box:'r1',runner:'r1',title:'new',state:'running',createdAt:f.clock.now()},f.clock.now()))();
 expect(f.call('approvals.answer',{id:approval,action:'allow'})).toMatchObject({ok:true});
 for(const id of ['covered','later']){expect(f.store.read('job',id)).toMatchObject({state:'lost',endedAt:f.clock.now(),writtenOff:{approval,by:'jonathan'}});expect(f.call('runtime.jobControl',{job:id},{kind:'runner',id:'r1'})).toMatchObject({ok:true,value:{stop:true,history:'discard'}});}
 expect(f.store.read('job','new')?.state).toBe('running');expect(f.store.read('job','private')?.state).toBe('running');expect(f.store.read('job','done')?.state).toBe('done');expect(f.store.read('box','r1')?.revokedAt).toBeUndefined();
 const again=f.call('approvals.answer',{id:approval,action:'allow'});expect(again.ok).toBe(false);
});
it.each(['box','body'])('refuses renewed %s liveness without spending the approval',async(kind)=>{
 const f=await setup(),approval=f.ask();f.clock.advance(1);
 f.app.db.transaction(()=>{if(kind==='body')f.app.db.prepare('INSERT INTO runtime_job_heartbeats VALUES (?,?)').run('covered',f.clock.now());else {const {changedAt:_,...b}=f.store.read('box','r1')!;f.store.put('box',{...b,lastSeen:f.clock.now()},f.clock.now());}})();
 expect(f.call('approvals.answer',{id:approval,action:'allow'}).ok).toBe(false);
 expect(f.store.read('job','covered')?.state).toBe('running');
 expect(owningApprovalCards(f.app.db,'box-write-off',`art:r1@${Math.floor((f.clock.now()-1-700_000)/1000)}`,'art')[0]?.state).toBe('pending');
});
it('rejects body-manufactured application fields, survives restart and applies the durable snapshot',async()=>{
 const f=await setup(),approval=f.ask();
 const target=(f.app.db.prepare('SELECT target FROM runtime_owner_requests').get() as {target:string}).target;
 for(const v of [owner,{kind:'agent',id:'art'},{kind:'member',id:'pollock'}] as Viewer[])expect(f.call('runtime.applyOwnerAnswer',{target,approval},v).ok).toBe(false);
 await f.app.close();const app=await f.open();
 expect(app.operations.call('direct',owner,'approvals.answer',{id:approval,action:'allow'},'after-restart')).toMatchObject({ok:true});
 expect(runtimeStore(app.db).read('job','covered')?.writtenOff?.approval).toBe(approval);
});

async function resetSetup(){
 const f=await setup(),conversation='cv-123456789abc',p=provenanceStore(f.app.db);
 f.app.db.transaction(()=>{
  f.store.put('binding',{id:conversation,agent:'art',venue:'fixture',place:'room',job:'covered',home:{harness:'claude',slot:'old-session'}},1);
  for(const id of ['covered','later']){const {changedAt:_,...j}=f.store.read('job',id)!;f.store.put('job',{...j,conversation},1);}
  p.note(conversation,'art',{key:'shown-relay',sender:{kind:'agent'},at:1},['jonathan']);
  p.note(conversation,'art',{key:'shown-wake',sender:{kind:'schedule',for:'-'},at:2},['jonathan']);
  p.note(conversation,'art',{key:'named-wake',sender:{kind:'schedule',for:'owner'},at:2},['jonathan']);
 })();
 const ask=()=>{const r=f.call('runtime.askPrincipalReset',{agent:'art',conversation});expect(r,JSON.stringify(r)).toMatchObject({ok:true});return (r as {value:{approval:string}}).value.approval;};
 return {...f,conversation,p,ask};
}
it('resets only the shown queue, records the owner attestation and fences old body/session state',async()=>{
 const f=await resetSetup(),approval=f.ask();
 f.app.db.transaction(()=>f.p.note(f.conversation,'art',{key:'late',sender:{kind:'unknown'},at:3},['jonathan']))();
 expect(f.call('approvals.answer',{id:approval,action:'allow'})).toMatchObject({ok:true});
 expect(f.p.read(f.conversation)).toMatchObject({history:{owner:true,unknown:true},reset:{by:'jonathan',approval}});
 expect(f.store.read('binding',f.conversation)).toMatchObject({agent:'art',venue:'fixture',place:'room'});
 expect(f.store.read('binding',f.conversation)?.home).toBeUndefined();expect(f.store.read('binding',f.conversation)?.job).toBeUndefined();
 for(const id of ['covered','later']){expect(f.store.read('job',id)).toMatchObject({state:'stopped',endedAt:f.clock.now(),principalReset:{approval}});expect(f.call('runtime.jobControl',{job:id},{kind:'runner',id:'r1'})).toMatchObject({ok:true,value:{stop:true,history:'discard'}});}
});
it('refuses a reset after another person arrives and never changes private membership',async()=>{
 const f=await resetSetup(),approval=f.ask();
 f.app.db.transaction(()=>f.p.note(f.conversation,'art',{key:'person',sender:{kind:'person',person:'pollock'},at:3},['jonathan']))();
 expect(f.call('approvals.answer',{id:approval,action:'allow'}).ok).toBe(false);
 expect(f.store.read('binding',f.conversation)?.home?.slot).toBe('old-session');expect(f.store.read('job','covered')?.state).toBe('running');
 const g=await resetSetup();
 g.app.db.transaction(()=>{const {changedAt:_,...b}=g.store.read('binding',g.conversation)!;g.store.put('binding',{...b,member:'jonathan'},1);})();
 expect(g.call('runtime.askPrincipalReset',{agent:'art',conversation:g.conversation}).ok).toBe(false);
});
it('retains a denial instead of asking again and rejects another card for the same target',async()=>{
 const f=await resetSetup(),approval=f.ask();
 expect(f.call('approvals.answer',{id:approval,action:'deny'})).toMatchObject({ok:true});expect(f.ask()).toBe(approval);
 expect(f.p.read(f.conversation)?.reset).toBeUndefined();
 const g=await resetSetup(),real=g.ask();
 g.app.db.prepare("UPDATE runtime_owner_requests SET record=json_set(record,'$.card.id','a-deadbeef')").run();
 expect(g.call('approvals.answer',{id:real,action:'allow'}).ok).toBe(false);
 expect(g.store.read('job','covered')?.state).toBe('running');
});

it('uses real next HTTP owner authority, revokes only covered body credentials, and rolls back a late receipt failure',async()=>{
 const f=await setup(),auth=signin(f.app);
 f.app.db.transaction(()=>{
  auth.tokens.replace({v:1,tokens:[]},{});
  f.store.put('job',{id:'service',agent:'art',service:'bridge',box:'r1',runner:'r1',title:'service',state:'running',createdAt:1},1);
 })();
 const token=(role:string,member?:string)=>{const secret=randomBytes(32).toString('hex');auth.tokens.change(ts=>ts.push({role,...(member?{member}:{}),sha256:hash(secret),label:role,created:new Date(f.clock.now()).toISOString()}));return secret;};
 const ownerToken=token('owner'),member=token('owner','pollock'),body=token('agent:art@covered'),other=token('agent:art@private'),service=token('agent:art/bridge@service');
 let seq=0;
 const post=async(secret:string,op:string,input:unknown,id=`real-http-${++seq}`)=>{const [piece,verb]=op.split('.');return (await fetch(`${f.app.url}/api/${piece}/${verb}`,{method:'POST',headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},body:JSON.stringify({input,id})})).json();};
 for(const secret of [member,body])expect(await post(secret,'runtime.askWriteOff',{agent:'art',box:'r1'})).toMatchObject({ok:false});
 const request=await post(ownerToken,'runtime.askWriteOff',{agent:'art',box:'r1'});expect(request).toMatchObject({ok:true});const approval=request.value.approval;
 for(const secret of [member,body])expect(await post(secret,'approvals.answer',{id:approval,action:'allow'})).toMatchObject({ok:false});
 const notices=vi.spyOn(f.app.live,'changed');
 f.app.db.exec("CREATE TRIGGER fail_answer_receipt BEFORE INSERT ON core_operations WHEN NEW.id='late-failure' BEGIN SELECT RAISE(ABORT,'late receipt failure'); END");
 notices.mockClear();
 expect(await post(ownerToken,'approvals.answer',{id:approval,action:'allow'},'late-failure')).toMatchObject({ok:false});
 expect(f.store.read('job','covered')?.state).toBe('running');expect(auth.tokens.document()!.tokens.find(t=>t.sha256===hash(body))?.revoked).toBeUndefined();
 expect(notices).not.toHaveBeenCalled();
 const row=f.app.db.prepare('SELECT record FROM runtime_owner_requests').get() as {record:string};expect(JSON.parse(row.record).applied).toBeUndefined();
 f.app.db.exec('DROP TRIGGER fail_answer_receipt');
 const allowed=await post(ownerToken,'approvals.answer',{id:approval,action:'allow'},'real-answer');expect(allowed).toMatchObject({ok:true});
 expect(await post(ownerToken,'approvals.answer',{id:approval,action:'allow'},'real-answer')).toEqual(allowed);
 expect(await post(ownerToken,'approvals.answer',{id:approval,action:'allow'})).toMatchObject({ok:false});
 expect(auth.tokens.document()!.tokens.find(t=>t.sha256===hash(body))?.revoked).toBeDefined();
 for(const secret of [other,service])expect(auth.tokens.document()!.tokens.find(t=>t.sha256===hash(secret))?.revoked).toBeUndefined();
 expect(f.store.read('job','service')?.state).toBe('running');
 expect(await post(body,'runtime.reply',{id:'late',text:'cannot resurrect'})).toMatchObject({ok:false});
});

it('a centrally authenticated body heartbeat fences a pending write-off even while its runner stays silent',async()=>{
 const f=await setup(),auth=signin(f.app),house={repo:'/fixture/art',houseFile:'house/house.json'};
 f.app.db.transaction(()=>{auth.tokens.replace({v:1,tokens:[]},{});f.store.put('settings',{id:'art',agent:'art',boxes:['r1'],house},1);const {changedAt:_,...j}=f.store.read('job','covered')!;f.store.put('job',{...j,made:house},1);})();
 const approval=f.ask(),body=randomBytes(32).toString('hex');
 auth.tokens.change(ts=>ts.push({role:'agent:art@covered',sha256:hash(body),label:'body',created:new Date(f.clock.now()).toISOString()}));
 const reply=await fetch(`${f.app.url}/api/runtime/bodyHeartbeat`,{method:'POST',headers:{authorization:`Bearer ${body}`,'content-type':'application/json'},body:JSON.stringify({input:{}})});
 expect(await reply.json()).toMatchObject({ok:true,value:{heard:true}});
 expect(f.call('approvals.answer',{id:approval,action:'allow'}).ok).toBe(false);
 expect(f.store.read('job','covered')?.writtenOff).toBeUndefined();
});

it.each(['missing','async'])('rolls back owner answers with a %s central credential role',async(kind)=>{
 const f=await setup(kind==='missing'?{}:{credentials:{revokeBox(){},revokeJob(){return Promise.resolve();}}});
 const approval=f.ask();expect(f.call('approvals.answer',{id:approval,action:'allow'})).toMatchObject({ok:false,code:'unavailable'});
 expect(f.store.read('job','covered')?.state).toBe('running');
 const request=JSON.parse((f.app.db.prepare('SELECT record FROM runtime_owner_requests').get() as {record:string}).record);
 expect(request.applied).toBeUndefined();expect(owningApprovalCards(f.app.db,'box-write-off',request.target,'art')[0]?.state).toBe('pending');
});

it('applies reset through next HTTP only after a successful atomic receipt and preserves its exact shown rows across restart',async()=>{
 const f=await resetSetup(),approval=f.ask(),auth=signin(f.app),secret=randomBytes(32).toString('hex');
 const request=JSON.parse((f.app.db.prepare('SELECT record FROM runtime_owner_requests').get() as {record:string}).record);
 expect(request.shown.map((r:{key:string})=>r.key)).toEqual(['shown-relay','shown-wake']);
 f.app.db.transaction(()=>auth.tokens.replace({v:1,tokens:[{role:'owner',sha256:hash(secret),label:'owner',created:new Date(f.clock.now()).toISOString()},{role:'agent:art@covered',sha256:hash('fixture-covered-token'),label:'old-body',created:new Date(f.clock.now()).toISOString()}]},{}))();
 await f.app.close();const app=await f.open(),p=provenanceStore(app.db);
 const post=async(id:string)=>(await fetch(`${app.url}/api/approvals/answer`,{method:'POST',headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},body:JSON.stringify({input:{id:approval,action:'allow'},id})})).json();
 app.db.exec("CREATE TRIGGER fail_reset_receipt BEFORE INSERT ON core_operations WHEN NEW.id='reset-failure' BEGIN SELECT RAISE(ABORT,'late receipt failure'); END");
 expect(await post('reset-failure')).toMatchObject({ok:false});
 expect(p.read(f.conversation)?.reset).toBeUndefined();expect(runtimeStore(app.db).read('binding',f.conversation)?.home?.slot).toBe('old-session');
 expect(signin(app).tokens.document()!.tokens.find(t=>t.label==='old-body')?.revoked).toBeUndefined();
 app.db.exec('DROP TRIGGER fail_reset_receipt');
 expect(await post('reset-success')).toMatchObject({ok:true});expect(await post('reset-success')).toMatchObject({ok:true});expect(await post('new-answer')).toMatchObject({ok:false});
 expect(p.read(f.conversation)).toMatchObject({history:{owner:true,unknown:false},reset:{approval}});expect(signin(app).tokens.document()!.tokens.find(t=>t.label==='old-body')?.revoked).toBeDefined();
});

it.each([{local:true},{revokedAt:1},{reportOnly:true},{lastSeen:undefined},{lastSeen:'recent'}])('refuses initial ineligible box %j',async(patch)=>{
 const f=await setup();f.app.db.transaction(()=>{const {changedAt:_,...b}=f.store.read('box','r1')!;f.store.put('box',{...b,...patch,lastSeen:patch.lastSeen==='recent'?f.clock.now():Object.hasOwn(patch,'lastSeen')?patch.lastSeen:b.lastSeen} as typeof b,1);})();
 expect(f.call('runtime.askWriteOff',{agent:'art',box:'r1'}).ok).toBe(false);expect(f.app.db.prepare('SELECT count(*) AS n FROM runtime_owner_requests').get()).toEqual({n:0});
});
it('refuses a recently heard covered body at initial filing',async()=>{
 const f=await setup();f.app.db.prepare('INSERT INTO runtime_job_heartbeats VALUES (?,?)').run('covered',f.clock.now());
 expect(f.call('runtime.askWriteOff',{agent:'art',box:'r1'}).ok).toBe(false);
});
it('retains the full covered set when job ids exceed the card detail budget',async()=>{
 const f=await setup();f.app.db.transaction(()=>{for(let n=0;n<40;n++){const id=`long-job-${String(n).padStart(3,'0')}-`+'a'.repeat(80);f.store.put('job',{id,agent:'art',box:'r1',runner:'r1',title:'work',state:'running',createdAt:1},1);}})();
 const approval=f.ask(),request=JSON.parse((f.app.db.prepare('SELECT record FROM runtime_owner_requests').get() as {record:string}).record);
 expect(request.jobs).toHaveLength(42);expect(request.card.details.length).toBeLessThanOrEqual(1000);expect(request.card.details).toContain('all 42');
 expect(f.call('approvals.answer',{id:approval,action:'allow'})).toMatchObject({ok:true});for(const j of request.jobs)expect(f.store.read('job',j.id)?.writtenOff?.approval).toBe(approval);
});
it.each(['lost','uncertain'] as const)('never turns ordinary %s into discarded history',async(state)=>{
 const f=await setup();f.app.db.transaction(()=>{const {changedAt:_,...j}=f.store.read('job','covered')!;f.store.put('job',{...j,state},1);})();
 expect(f.call('runtime.jobControl',{job:'covered'},{kind:'runner',id:'r1'})).toEqual({ok:true,value:{stop:false,history:'unknown'}});
});
it('binds original card contents and not just its id',async()=>{
 const f=await resetSetup(),approval=f.ask();
 f.app.db.prepare("UPDATE approvals_approvals SET record=json_set(record,'$.details','different covered work') WHERE id=?").run(approval);
 expect(f.call('approvals.answer',{id:approval,action:'allow'}).ok).toBe(false);expect(f.store.read('job','covered')?.state).toBe('running');
});
it('bounds displayed reset source descriptions and adopts only the exact listed keys',async()=>{
 const f=await resetSetup();f.app.db.transaction(()=>{for(let n=0;n<20;n++)f.p.note(f.conversation,'art',{key:`relay-${n}`,sender:{kind:'agent'},at:n+10},['jonathan']);})();
 const approval=f.ask(),request=JSON.parse((f.app.db.prepare('SELECT record FROM runtime_owner_requests').get() as {record:string}).record);
 expect(request.shown.length).toBeGreaterThan(0);expect(request.shown.length).toBeLessThanOrEqual(12);expect(request.shown.reduce((sum:number,r:{words:string})=>sum+r.words.length+2,0)).toBeLessThanOrEqual(650);expect(request.shown.length).toBeLessThan(22);
 expect(f.call('approvals.answer',{id:approval,action:'allow'})).toMatchObject({ok:true});expect(f.p.read(f.conversation)?.history.unknown).toBe(true);
});
it('revokes terminal jobs holding the previous reset transcript too',async()=>{
 const f=await resetSetup(),auth=signin(f.app);
 f.app.db.transaction(()=>{const {changedAt:_,...j}=f.store.read('job','done')!;f.store.put('job',{...j,conversation:f.conversation},1);auth.tokens.replace({v:1,tokens:[{role:'agent:art@done',sha256:hash('terminal-fixture'),label:'old-done',created:new Date(f.clock.now()).toISOString()}]},{});})();
 const approval=f.ask();expect(f.call('approvals.answer',{id:approval,action:'allow'})).toMatchObject({ok:true});expect(auth.tokens.document()!.tokens[0].revoked).toBeDefined();expect(f.store.read('job','done')).toMatchObject({state:'done',endedAt:2});
});
it('enforces the description character budget independently of the twelve-row bound',async()=>{
 const f=await resetSetup();f.app.db.transaction(()=>{f.p.consumed(f.conversation,['shown-relay','shown-wake','named-wake']);for(let n=0;n<20;n++)f.p.note(f.conversation,'art',{key:`wake-${n}`,sender:{kind:'schedule',for:'-'},at:n+10},['jonathan']);})();
 f.ask();const request=JSON.parse((f.app.db.prepare('SELECT record FROM runtime_owner_requests').get() as {record:string}).record);
 expect(request.shown.length).toBeLessThan(12);expect(request.shown.reduce((sum:number,r:{words:string})=>sum+r.words.length+2,0)).toBeLessThanOrEqual(650);
});
