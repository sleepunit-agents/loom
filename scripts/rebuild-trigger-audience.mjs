import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {exampleHome} from '../dist/example-home.js';
import {startSharedHome} from '../dist/shared-startup.js';
import {FakeClock} from '../dist/core/clock.js';

export async function triggerAudience(){
 const directory=await mkdtemp(join(tmpdir(),'loom-trigger-audience-'));
 let app;
 try{
  const home=join(directory,'home'),sample=await exampleHome(home);
  assert(sample.fictional);
  const clock=new FakeClock(Date.parse(sample.createdAt));
  app=await startSharedHome({home,clock,port:0,stdout(){}});
  const {services}=app,write=fn=>app.writes.run(fn).value;
  const set=(note,ownerKind,owner,toKind,to,project=null)=>{
   const labels={ownerKind,owner,toKind,to,project};
   const row=write(()=>services.tempo.triggers.set({...labels,sourceKind:'time',lifespan:'once',times:new Date(clock.now()+86400000).toISOString(),...(toKind?{targetKind:'inbox',instructions:note}:{targetKind:'operation',target:'tempo.sweep'}),note}));
   return {id:row.id,...labels};
  };
  const project=set('Inspect the shared garden','household',null,'agent','fern','garden');
  const owned=set('Inspect the shed','agent','moss','agent','moss');
  const personal=set('Remember the watering can','member','robin','person','robin');
  const addressed=set('Collect the garden tools','household',null,'person','robin');
  const unrelated=set('Inspect the spare pump','member','alex','agent','fern');
  const operation=set('Maintain the shed','agent','moss',null,null);
  const rows=[project,owned,personal,addressed,unrelated,operation];
  const sorted=items=>items.slice().sort((a,b)=>a.id.localeCompare(b.id));
  const credential=(input,label)=>write(()=>services.signin.issue({...input,label})).token;
  const owner=credential({kind:'owner',member:'alex'},'Fictional trigger owner');
  const member=credential({kind:'owner',member:'robin'},'Fictional trigger member');
  const agent=credential({kind:'agent',agent:'moss'},'Fictional trigger agent');
  async function expectRows(token,expected){
   const response=await fetch(app.url+'/graphql',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({
    query:'query TriggerAudience($ids:[String!]!){triggers(where:{id:{inArray:$ids}}){id ownerKind owner toKind to project}}',variables:{ids:rows.map(row=>row.id)},
   })});
   assert.equal(response.status,200);
   const result=await response.json();assert.equal(result.errors,undefined);
   assert.deepEqual(sorted(result.data.triggers),sorted(expected));
  }
  await expectRows(owner,rows);
  await expectRows(member,[project,owned,personal,addressed,operation]);
  await expectRows(agent,[project,owned,operation]);
  write(()=>services.projects.save({id:'garden',name:'Example garden',members:['alex'],agents:['fern'],repositories:['github:example-house/garden']}));
  await expectRows(owner,rows);
  await expectRows(member,[owned,personal,addressed,operation]);
  await expectRows(agent,[owned,operation]);
  return {ok:true,reason:'Three authenticated readers queried six actual triggers by ID. Setter, recipient and project labels matched. Removing project access hid only the project trigger from the member and agent. Personal, directly addressed and owned-agent work remained visible to its readers.'};
 }finally{try{await app?.close();}finally{await rm(directory,{recursive:true,force:true});}}
}
