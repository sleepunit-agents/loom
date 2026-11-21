import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FakeClock} from '../dist/core/clock.js';
import {exampleHome} from '../dist/example-home.js';
import {startSharedHome} from '../dist/shared-startup.js';
import {httpWorkerControl} from '../dist/runtime/worker-http.js';

export async function workerRetryEvidence(){
 const dir=await mkdtemp(join(tmpdir(),'loom-worker-retries-')),home=join(dir,'home');
 let app;
 try{
  const example=await exampleHome(home);
  assert.equal(example.fictional,true);
  const clock=new FakeClock(Date.parse(example.createdAt)),{box,job}=example.runtime;
  const open=()=>startSharedHome({home,port:0,clock,stdout(){}});
  app=await open();
  const issue=key=>app.writes.run(()=>app.services.signin.issue(key)).value.token;
  const runner=issue({kind:'runner',box,label:'Fictional startup failure'});
  const owner=issue({kind:'owner',member:'alex',label:'Fictional history reader'});
  const worker=()=>httpWorkerControl({url:app.url,token:runner,slots:4,signal:AbortSignal.timeout(15000)});
  // Hold the other queued example assignments. Only the job being measured reports a failed start.
  const seen=new Set();
  for(let i=0;i<4;i++){
   const assignment=await worker().next();
   if(!assignment)break;
   seen.add(assignment.id);
  }
  assert.ok(seen.has(job.id),'The worker must claim the original private job');
  let id=job.id;const chain=[];
  for(const delay of [1000,2000,4000,0]){
   chain.push(id);
   await worker().finish(id,1,'Fictional worker could not start the body');
   await app.close();app=await open();
   if(!delay)break;
   clock.advance(delay-1);
   assert.equal(await worker().next(),undefined,'Retry claimed before its deadline');
   clock.advance(1);
   const next=await worker().next();
   assert.equal(next?.conversation,example.runtime.conversation);
   id=next.id;
  }
  assert.equal(new Set(chain).size,4);
  clock.advance(8000);
  assert.equal(await worker().next(),undefined,'A fifth attempt was offered');
  const response=await fetch(app.url+'/graphql',{method:'POST',headers:{authorization:'Bearer '+owner,'content-type':'application/json'},body:JSON.stringify({query:'{jobHistory(agent:"moss",first:40){id state retryOf conversation}}'})});
  assert.equal(response.status,200);
  const result=await response.json();assert.equal(result.errors,undefined);
  const rows=result.data.jobHistory.filter(row=>row.conversation===example.runtime.conversation);
  assert.equal(rows.length,4);
  for(const [i,jobId] of chain.entries()){
   const row=rows.find(item=>item.id===jobId);
   assert.equal(row?.retryOf,chain[i-1]??null);
   assert.equal(row.state,'failed');
  }
  return {ok:true,attempts:chain.length,reason:'The worker reported a failed start four times. Across coordinator restarts each retry waited for its deadline and named the preceding job in history. No fifth attempt was offered.'};
 } finally {try{await app?.close();}finally{await rm(dir,{recursive:true,force:true});}}
}
