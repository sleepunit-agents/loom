import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exampleHome } from '../dist/example-home.js';
import { startSharedHome } from '../dist/shared-startup.js';
import { httpWorkerControl } from '../dist/runtime/worker-http.js';
import { FakeClock } from '../dist/core/clock.js';

export async function jobLabelsEvidence() {
 const dir=await mkdtemp(join(tmpdir(),'loom-labels-')),home=join(dir,'household');
 let app;
 try {
  const example=await exampleHome(home);
  assert(example.fictional);
  const clock=new FakeClock(Date.parse(example.createdAt));
  app=await startSharedHome({home,clock,port:0,stdout(){}});
  const s=app.services;
  const write=fn=>app.writes.run(fn).value;
  const project='garden';
  const thread=write(()=>s.comms.threads.open({agent:'moss',member:'robin',project,title:'Fictional private garden repair'}));
  write(await s.comms.prepareSend({thread:thread.id,sender:'robin',kind:'message',clientId:'private-garden',words:'Check the fictional gate.'}));
  const trigger=write(()=>s.tempo.triggers.set({ownerKind:'agent',owner:'fern',project,sourceKind:'time',times:new Date(clock.now()+1000).toISOString(),lifespan:'once',targetKind:'inbox',toKind:'agent',to:'fern',instructions:'Check the fictional path.',note:'Fictional project garden walk'}));
  clock.advance(1000);
  clock.advance(1000+s.tempo.volume.timings({kind:'agent',id:'moss'}).settleSeconds*1000);
  const db=s.comms.db.$client;
  const rows=db.prepare('select j.id,j.agent,j.project,j.member,j.state from jobs j join conversations c on c.id=j.conversation where c.id=? or c.place=? order by j.agent').all(thread.conversation,trigger.id);
  assert.equal(rows.length,2);
  assert.deepEqual(rows.map(({id,...scope})=>scope),[{agent:'fern',project,member:null,state:'queued'},{agent:'moss',project,member:'robin',state:'queued'}]);
  for(const member of ['alex','robin']){
   const credential=write(()=>s.signin.issue({kind:'owner',member,label:'Fictional job labels check'}));
   const query='{ fern:currentJobs(agent:"fern"){id agent} moss:currentJobs(agent:"moss"){id agent} }';
   const response=await fetch(app.url+'/graphql',{method:'POST',headers:{authorization:'Bearer '+credential.token,'content-type':'application/json'},body:JSON.stringify({query})});
   assert.equal(response.status,200);
   const {data,errors}=await response.json(); assert.equal(errors,undefined);
   assert(data.fern.some(row=>row.id===rows[0].id));
   assert(data.moss.some(row=>row.id===example.runtime.publicJob.id));
   assert.equal(data.moss.some(row=>row.id===rows[1].id),member==='robin');
   write(()=>s.signin.revoke(credential.fingerprint));
  }
  const ownBox=example.runtime.box, privateId=rows[1].id;
  const worker=write(()=>s.signin.issue({kind:'runner',box:ownBox,label:'Fictional private job worker'}));
  const control=httpWorkerControl({url:app.url,token:worker.token,facts:['cpu:example'],slots:16,signal:AbortSignal.timeout(10000)});
  let claimed;
  for(let i=0;i<16;i++){
   const next=await control.next();
   if(!next)break;
   if(next.id===privateId){claimed=next;break;}
  }
  assert.equal(claimed?.box,ownBox,'Worker did not claim the private job');
  const summary='The garden gate inspection is underway.';
  write(()=>s.conversations.digest({conversation:thread.conversation,run:privateId,summary,items:[]}));
  write(()=>s.household.setMember({id:'casey',role:'owner',fullOwner:false,agents:[]}));
  const metadata=db.prepare('select id,agent,box,state,queued_at as queuedAt,claimed_at as claimedAt,ended_at as endedAt from jobs where id=?').get(privateId);
  for(const member of ['alex','robin','casey']){
   const credential=write(()=>s.signin.issue({kind:'owner',member,label:'Private job on machine '+member}));
   const query='{privateMachineJobs(agent:"moss"){id agent box state queuedAt claimedAt endedAt summary} jobHistory(agent:"moss"){id title brief logTail} commsThread(id:'+JSON.stringify(thread.id)+'){id}}';
   const response=await fetch(app.url+'/graphql',{method:'POST',headers:{authorization:'Bearer '+credential.token,'content-type':'application/json'},body:JSON.stringify({query})});
   const {data,errors}=await response.json();assert.equal(response.status,200);assert.equal(errors,undefined);
   const selected=data.privateMachineJobs.filter(row=>row.id===privateId);
   assert.deepEqual(selected,member==='alex'?[{...metadata,summary}]:[]);
   assert.equal(data.jobHistory.some(row=>row.id===privateId),member==='robin');
   assert.equal(data.commsThread?.id??null,member==='robin'?thread.id:null);
   write(()=>s.signin.revoke(credential.fingerprint));
  }
  const read=async(credential,query)=>{
   const response=await fetch(app.url+'/graphql',{method:'POST',headers:{authorization:'Bearer '+credential.token,'content-type':'application/json'},body:JSON.stringify({query})});
   return {status:response.status,body:await response.json()};
  };
  const publicJob=example.runtime.publicJob.id;
  const fullJobs='{jobHistory(agent:"moss"){id} privateMachineJobs(agent:"moss"){id}}';
  const agent=write(()=>s.signin.issue({kind:'agent',agent:'moss',label:'Fictional machine reader'}));
  const agentJobs=await read(agent,fullJobs);
  assert.equal(agentJobs.status,200);assert.equal(agentJobs.body.errors,undefined);
  assert(agentJobs.body.data.jobHistory.some(row=>row.id===publicJob));
  assert(!agentJobs.body.data.jobHistory.some(row=>row.id===privateId));
  assert.deepEqual(agentJobs.body.data.privateMachineJobs,[]);
  const workerRead=await read(worker,fullJobs);
  assert.equal(workerRead.status,403);assert.equal(workerRead.body.data,undefined);
  for(const member of ['alex','robin']){
   const program=write(()=>s.programSetup.issue({member,label:'Fictional machine programme '+member,records:['boxes'],operations:[]}));
   const boxRead=await read(program,'{boxes{id}}');
   assert.equal(boxRead.status,200);assert.equal(boxRead.body.errors,undefined);
   assert.equal(boxRead.body.data.boxes.some(row=>row.id===ownBox),member==='alex');
   const other=await read(program,fullJobs);
   assert.equal(other.status,200);assert.equal(other.body.data,undefined);
   for(const field of ['jobHistory','privateMachineJobs'])assert(other.body.errors.some(error=>error.message.includes('Cannot query field "'+field+'"')));
   write(()=>s.signin.revoke(program.fingerprint));
  }
  return {ok:true,reason:'Members saw shared project work and only the sender opened the private thread and full job history. After a real worker claimed that job, the household owner of its machine could read its state, times and exact digest. A second household owner saw none of it. The agent saw its public job, the worker could claim work but could not list it, and two box-scoped programs read only their member’s machines. Neither program could request job details.'};
 } finally {try{await app?.close();}finally{await rm(dir,{recursive:true,force:true});}}
}
