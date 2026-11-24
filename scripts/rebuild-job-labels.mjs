import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exampleHome } from '../dist/example-home.js';
import { startSharedHome } from '../dist/shared-startup.js';
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
   assert.equal(data.moss.some(row=>row.id===rows[1].id),member==='robin');
   write(()=>s.signin.revoke(credential.fingerprint));
  }
  return {ok:true,reason:'Queued private Comms and shared project jobs retained their agent, project and member labels. Both signed-in members saw the project job. Only the private message sender saw its job.'};
 } finally {try{await app?.close();}finally{await rm(dir,{recursive:true,force:true});}}
}
