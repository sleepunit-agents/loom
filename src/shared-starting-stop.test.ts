/** Real Root + worker HTTP + private repository consent loop, fictitious data. */
import {afterEach,expect,it,vi} from 'vitest';
import {eq} from 'drizzle-orm';
import {bodyFixture,bodyCredentials as raw} from '../test/fixtures/conversation-body.js';
import * as s from './core/data/schema.js';
import {httpWorkerControl} from './runtime/worker-http.js';
import {workOnce} from './runtime/worker.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
async function fixture(){
 const f=await bodyFixture(clean,{modelRoles:()=>[{model:'model',provider:'provider',harness:'claude',series:'series'}]}),now=()=>new Date(f.clock.now()).toISOString();
 f.db.update(s.members).set({role:'owner'}).where(eq(s.members.id,'bob')).run();
 f.db.update(s.jobs).set({state:'done',endedAt:now()}).run();f.db.update(s.conversations).set({job:null}).run();
 f.db.update(s.boxes).set({hostsAny:true}).where(eq(s.boxes.id,'box')).run();
 f.db.insert(s.agentBoxes).values({agent:'art',box:'box',position:0}).run();f.db.insert(s.agentModels).values({agent:'art',model:'model',position:0}).run();
 f.db.insert(s.secrets).values({name:'REPO',description:'Synthetic repository key',changedAt:now(),changedBy:'alice'}).run();f.db.insert(s.secretChanges).values({id:'repository-add',secret:'REPO',action:'add',by:'alice',at:now()}).run();
 f.db.insert(s.agentRunSettings).values({agent:'art',houseRepository:'repo',houseFile:'Housefile',houseBranch:'next',repositorySecret:'REPO',nestedContainers:false,gpu:false}).run();
 f.db.insert(s.modelAccounts).values({id:'account',owner:'alice',provider:'provider',label:'Synthetic',hasRoom:true}).run();f.db.insert(s.modelAccountBoxes).values({account:'account',box:'box'}).run();f.db.insert(s.modelAccountWindows).values({account:'account',window:'week',usage:0.1,usageReadAt:now(),resetsAt:new Date(f.clock.now()+86400000).toISOString(),durationMs:86400000}).run();
 expect((await f.send('Private work waiting for repository consent','work')).status).toBe(200);
 expect(f.root.services.runtime.admit({kind:'agent',id:'art'},f.db.select().from(s.inbox).where(eq(s.inbox.toKind,'agent')).all())).toBe(true);
 f.root.writes.run(()=>f.root.services.secrets.requests.setRule({secret:'REPO',answer:'ask',minutes:5,agents:[{agent:'art',when:'at_start'}]}));
 const job=f.db.select().from(s.jobs).all().find(row=>row.state==='queued')!;
 const member=(change:string)=>f.root.http.request('/api/comms/change',{method:'POST',headers:{cookie:'loom_ui='+raw.memberCookie,'content-type':'application/json'},body:JSON.stringify({id:'member-'+change,input:{thread:f.thread.id,change}})});
 return{...f,job,member};
}
it('honors Stop during the real pre-body repository consent wait without building, retrying or running a model',async()=>{
 const f=await fixture(),abort=new AbortController(),build=vi.fn(async()=> 'built'),start=vi.fn(()=>{throw Error('No body before consent');});
 const observed:string[]=[];let pulse=()=>{},asked!:()=>void;const pending=new Promise<void>(resolve=>{asked=resolve;});
 const control=httpWorkerControl({url:'https://loom.example',token:raw.runner,signal:abort.signal,fetch:async(input,init)=>{const response=await f.root.http.fetch(new Request(input,init));observed.push(new URL(String(input)).pathname+':'+response.status);if(String(input).endsWith('/api/secrets/private/read')&&response.status===423)asked();return response;}});
 const running=workOnce({box:'box',control,executor:{build,start},signal:abort.signal,schedule:{every(_ms,callback){pulse=callback;return()=>{};}}});
 try{
  await Promise.race([pending,running.then(result=>{throw Error('Worker ended '+result+' before repository consent wait: '+observed.join(','));})]);expect(f.db.select().from(s.secretRequests).get()?.state).toBe('pending');
  expect(f.db.select().from(s.threads).get()?.working).toBe(true);
  expect((await f.member('stop')).status).toBe(200);expect(f.db.select().from(s.threads).get()?.stopRequested).toBe(true);
  pulse();expect(await running).toBe('abandoned');
  expect(f.db.select().from(s.jobs).where(eq(s.jobs.id,f.job.id)).get()).toMatchObject({state:'stopped',endedBy:'alice',endedReason:'write-off'});
  expect(f.db.select().from(s.jobs).all()).toHaveLength(2);expect(f.db.select().from(s.conversations).get()?.job).toBeNull();
  expect(f.db.select().from(s.threads).get()).toMatchObject({working:false,workingSince:null,workingBeat:null,stopRequested:false});
  expect(f.db.select().from(s.inbox).all().find(row=>row.toKind==='agent')).toMatchObject({state:'waiting',job:f.job.id});
  const request=f.db.select().from(s.secretRequests).get()!;f.root.writes.run(()=>f.root.services.secrets.requests.answer(request.id,'bob',true));
  const late=await f.root.http.request('/api/secrets/private/read',{method:'POST',headers:{authorization:'Bearer '+raw.runner,'content-type':'application/json'},body:JSON.stringify({kind:'repository',job:f.job.id})});expect(late.status).toBe(403);
  expect(build).not.toHaveBeenCalled();expect(start).not.toHaveBeenCalled();expect(f.db.select().from(s.secretUses).all()).toEqual([]);
  expect(f.db.select().from(s.operationResults).all().some(row=>row.operation==='runtime.finish')).toBe(false);expect(f.db.select().from(s.agentStatus).all()).toEqual([]);
 }finally{abort.abort();await running.catch(()=>{});}
});

function control(f:Awaited<ReturnType<typeof fixture>>){return httpWorkerControl({url:'https://loom.example',token:raw.runner,signal:new AbortController().signal,fetch:async(input,init)=>f.root.http.fetch(new Request(input,init))});}
function heartbeat(f:Awaited<ReturnType<typeof fixture>>,id:string){return f.root.http.request('/api/runtime/heartbeat',{method:'POST',headers:{authorization:'Bearer '+raw.runner,'content-type':'application/json'},body:JSON.stringify({id,input:{job:f.job.id,state:'starting'}})});}
it('leaves running-body Stop with the receiving body rather than consuming it in the parent',async()=>{
 const f=await fixture(),worker=control(f);expect(await worker.next()).toMatchObject({id:f.job.id});await worker.started(f.job.id,'built');expect((await f.member('stop')).status).toBe(200);
 expect(await worker.heartbeat(f.job.id,'running')).toBe(true);expect(f.db.select().from(s.jobs).where(eq(s.jobs.id,f.job.id)).get()?.state).toBe('running');expect(f.db.select().from(s.threads).get()?.stopRequested).toBe(true);
});
it('does not consume another conversation Stop while the same agent prepares this job',async()=>{
 const f=await fixture(),worker=control(f);expect(await worker.next()).toMatchObject({id:f.job.id});
 const other=f.root.services.comms!.threads.open({member:'alice',agent:'art',title:'Other work'});f.root.writes.run(()=>{f.root.services.comms!.threads.working(other.id,true);f.root.services.comms!.threads.requestStop(other.id);});
 expect(await worker.heartbeat(f.job.id,'starting')).toBe(true);expect(f.db.select().from(s.threads).where(eq(s.threads.id,other.id)).get()?.stopRequested).toBe(true);expect(f.db.select().from(s.jobs).where(eq(s.jobs.id,f.job.id)).get()?.state).toBe('starting');
});
it('commits stopped state and observed Stop with its heartbeat receipt before notifying Tempo; rollback and replay do not notify',async()=>{
 const f=await fixture(),worker=control(f);await worker.next();await f.member('stop');
 const observed:{id:string;transaction:boolean;receipt:boolean}[]=[],notify=f.root.services.tempo.sources.job.bind(f.root.services.tempo.sources),ended=vi.spyOn(f.root.services.tempo.sources,'job').mockImplementation(id=>{observed.push({id,transaction:f.db.$client.inTransaction,receipt:f.db.select().from(s.operationResults).all().some(row=>row.id==='heartbeat-stop'&&row.operation==='runtime.heartbeat')});notify(id);});
 f.db.$client.exec("CREATE TEMP TRIGGER fail_stop_receipt BEFORE INSERT ON operation_results WHEN NEW.id='heartbeat-rollback' BEGIN SELECT RAISE(ABORT,'fixture'); END");
 expect((await heartbeat(f,'heartbeat-rollback')).status).toBe(503);expect(f.db.select().from(s.jobs).where(eq(s.jobs.id,f.job.id)).get()?.state).toBe('starting');expect(f.db.select().from(s.conversations).get()?.job).toBe(f.job.id);expect(f.db.select().from(s.threads).get()).toMatchObject({working:true,stopRequested:true});expect(ended).not.toHaveBeenCalled();
 expect(await(await heartbeat(f,'heartbeat-stop')).json()).toMatchObject({value:{active:false}});expect(ended).toHaveBeenCalledExactlyOnceWith(f.job.id);expect(observed).toEqual([{id:f.job.id,transaction:false,receipt:true}]);expect(f.db.select().from(s.threads).get()).toMatchObject({working:false,stopRequested:false});
 expect((await heartbeat(f,'heartbeat-stop')).status).toBe(409);expect(await(await heartbeat(f,'terminal-heartbeat')).json()).toMatchObject({value:{active:false}});expect(ended).toHaveBeenCalledTimes(1);
});
it('refreshes preparation beats without resetting the original working-since time',async()=>{
 const f=await fixture(),worker=control(f);await worker.next();const before=f.db.select().from(s.threads).get()!;
 f.clock.advance(1000);expect(await worker.heartbeat(f.job.id,'starting')).toBe(true);
 expect(f.db.select().from(s.threads).get()).toMatchObject({working:true,workingSince:before.workingSince,workingBeat:new Date(f.clock.now()).toISOString()});expect(f.db.select().from(s.threads).get()?.workingBeat).not.toBe(before.workingBeat);
});

it.each(['job','agent']as const)('a claim does not touch a thread after its current %s binding changes',async changed=>{
 const f=await fixture();f.root.writes.run(()=>{f.db.update(s.conversations).set(changed==='job'?{job:'job'}:{agent:'mark'}).where(eq(s.conversations.id,f.thread.conversation)).run();f.db.update(s.threads).set({stopRequested:true}).where(eq(s.threads.id,f.thread.id)).run();});
 const before=f.db.select().from(s.threads).get();expect(await control(f).next()).toMatchObject({id:f.job.id,thread:null});expect(f.db.select().from(s.threads).get()).toEqual(before);
});
it.each(['job','agent']as const)('a preparation heartbeat leaves Stop and working metadata untouched after current %s binding changes',async changed=>{
 const f=await fixture(),worker=control(f);await worker.next();await f.member('stop');f.root.writes.run(()=>{f.db.update(s.conversations).set(changed==='job'?{job:'job'}:{agent:'mark'}).where(eq(s.conversations.id,f.thread.conversation)).run();f.root.services.comms!.threads.working(f.thread.id,false);});
 const before=f.db.select().from(s.threads).get();expect(await worker.heartbeat(f.job.id,'starting')).toBe(true);expect(f.db.select().from(s.threads).get()).toEqual(before);expect(f.db.select().from(s.jobs).where(eq(s.jobs.id,f.job.id)).get()?.state).toBe('starting');
});
