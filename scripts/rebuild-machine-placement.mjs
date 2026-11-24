import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {exampleHome} from '../dist/example-home.js';
import {startSharedHome} from '../dist/shared-startup.js';
import {FakeClock} from '../dist/core/clock.js';
import {httpWorkerControl} from '../dist/runtime/worker-http.js';

export async function machinePlacementEvidence(){
 const dir=await mkdtemp(join(tmpdir(),'loom-machine-placement-'));
 const home=join(dir,'home');
 let app;
 try{
  const example=await exampleHome(home);
  assert(example.fictional);
  const clock=new FakeClock(Date.parse(example.createdAt));
  app=await startSharedHome({home,clock,port:0,stdout(){}});
  const {runtime}=example,services=app.services,db=services.comms.db.$client;
  const write=fn=>app.writes.run(fn).value;
  const issue=input=>write(()=>services.signin.issue(input)).token;
  const owner=issue({kind:'owner',member:'alex',label:'Fictional machine owner'});
  async function command(path,input){
   const response=await fetch(app.url+'/api/'+path,{method:'POST',headers:{authorization:'Bearer '+owner,'content-type':'application/json'},body:JSON.stringify({id:crypto.randomUUID(),input})});
   assert.equal(response.status,200,path);
   const result=await response.json();assert.equal(result.ok,true);return result.value;
  }
  const name='Second fixture workshop';
  const spare=(await command('runtime/boxCreate',{name,sameMachineAsLoom:false})).id;
  write(()=>{
   services.setup.machine({box:spare,name,hostsAny:false,reportOnly:false,alwaysOn:false,agents:[{agent:'moss',lent:false}],facts:[]});
   services.setup.run('alex',{agent:'moss',houseRepository:'https://example.invalid/house.git',houseFile:'Housefile',houseBranch:'next',nestedContainers:false,gpu:false,boxes:[runtime.box,spare],ports:[]});
  });
  await command('runtime/accountSignedIn',{box:spare,account:runtime.account});
  const machine=id=>db.prepare('select owner,same_machine_as_loom as local from boxes where id=?').get(id);
  assert.deepEqual(machine(runtime.box),{owner:'alex',local:1});
  assert.deepEqual(machine(spare),{owner:'alex',local:0});
  const runner=box=>issue({kind:'runner',box,label:'Fixture worker '+box});
  const local=runner(runtime.box),remote=runner(spare);
  const poll=(token,fact)=>httpWorkerControl({url:app.url,token,facts:[fact],slots:12,signal:AbortSignal.timeout(10_000)}).next();
  // The example contains other queued conversations as well as its named job.
  const openingJobs=new Set(db.prepare("select id from jobs where state='queued'").all().map(row=>row.id));
  assert(openingJobs.has(runtime.job.id));
  const claimed=new Set();
  for(let next; (next=await poll(local,'gpu:4090'));){
   assert(openingJobs.has(next.id));assert(!claimed.has(next.id));assert.equal(next.box,runtime.box);
   claimed.add(next.id);
  }
  assert(claimed.has(runtime.job.id));assert(claimed.size<12);
  const trigger=await command('tempo/set',{ownerKind:'household',sourceKind:'time',times:new Date(clock.now()+1000).toISOString(),lifespan:'once',targetKind:'inbox',toKind:'agent',to:'moss',instructions:'Check the fixture GPU.',note:'GPU check',needs:['gpu:5090']});
  clock.advance(1000);
  clock.advance(services.tempo.volume.timings({kind:'agent',id:'moss'}).settleSeconds*1000);
  const job=()=>db.prepare("select j.id,j.state,j.box from jobs j join conversations c on c.id=j.conversation where c.place=?").get(trigger.id);
  const queued=job();assert.equal(queued?.state,'queued');
  assert.equal(await poll(local,'gpu:4090'),undefined);
  assert.equal(await poll(remote,'gpu:4090'),undefined);
  assert.deepEqual(job(),queued);
  const match=await poll(remote,'gpu:5090');
  assert.equal(match?.id,queued.id);assert.equal(match.box,spare);
  assert.equal(job().box,spare);
  return {ok:true,reason:'Two member-owned boxes reported through their worker credentials. The preferred, co-located box claimed ordinary work. A job requiring gpu:5090 stayed queued until the remote box reported that exact fact and claimed it.'};
 }finally{try{await app?.close();}finally{await rm(dir,{recursive:true,force:true});}}
}
