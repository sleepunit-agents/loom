import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {exampleHome} from '../dist/example-home.js';
import {startSharedHome} from '../dist/shared-startup.js';
import {FakeClock} from '../dist/core/clock.js';
import {bridgeConnections,secrets} from '../dist/core/data/schema.js';
import {BridgeIncoming} from '../dist/pieces/bridges/incoming.js';
import {claudeBody} from '../dist/runtime/claude-body.js';
import {SILENCE_MS} from '../dist/runtime/silence.js';
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
  async function command(path,input,token=owner){
   const response=await fetch(app.url+'/api/'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({id:crypto.randomUUID(),input})});
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
  const now=()=>new Date(clock.now()).toISOString();
  const ingress=new BridgeIncoming(services.comms.db,now);
  const contact={platform:'discord',workspace:'example-guild',user:'fixture-gardener',tier:2};
  const connection='fixture-placement-bridge', bot='fixture-placement-bot';
  assert.equal(services.bridges.daemon,undefined);
  write(()=>{
   services.comms.db.insert(secrets).values({name:connection,description:'Fixture metadata',changedAt:now(),changedBy:'alex'}).run();
   services.comms.db.insert(bridgeConnections).values({id:connection,workspace:contact.workspace,platform:contact.platform,agent:'moss',botUser:bot,tokenSecret:connection,enabled:true,state:'connected',stateAt:now()}).run();
  });
  const receive=id=>write(()=>ingress.receive({connection,id,channel:'fixture-room-'+id,isDm:false,user:contact.user,
   mentions:[bot],text:'Check the fictional garden.',postedAt:now()}));
  const always='mcp__loom__knowledge_read',guestOnly='mcp__loom__knowledge_recall';
  const restrictions=[{pattern:always,guestsOnly:false},{pattern:guestOnly,guestsOnly:true}];
  const proposer=issue({kind:'agent',agent:'moss',label:'Fictional run settings proposer'});
  const proposal=await command('household/propose',{change:'bodyPolicy',input:{agent:'moss',people:[contact],deniedTools:restrictions},why:'Configure the fictional gardener.'},proposer);
  assert.equal(receive('before-approval').state,'dropped');
  await command('approvals/answer',{id:proposal.id,answer:'allow'});
  // The example contains other queued conversations as well as its named job.
  const openingJobs=new Set(db.prepare("select id from jobs where state='queued'").all().map(row=>row.id));
  assert(openingJobs.has(runtime.job.id));
  const claimed=new Set();
  let ownerJob;
  for(let next; (next=await poll(local,'gpu:4090'));){
   assert(openingJobs.has(next.id));assert(!claimed.has(next.id));assert.equal(next.box,runtime.box);
   claimed.add(next.id);
   if(next.id===runtime.job.id)ownerJob=next;
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
  const queueOutside=id=>{
   const incoming=receive(id);
   assert.equal(incoming.state,'delivered');
   clock.advance(services.tempo.volume.timings({kind:'agent',id:'moss'}).settleSeconds*1000);
   const row=db.prepare("select id from jobs where conversation=? and state='queued'").get(incoming.conversation);
   assert.ok(row);return row.id;
  };
  const first=queueOutside('both-up');
  assert.equal(await poll(remote,'gpu:5090'),undefined);
  const preferred=await poll(local,'gpu:4090');
  assert.equal(preferred?.id,first);
  assert.equal(preferred.box,runtime.box);
  const policy=preferred.run.policy;
  assert.deepEqual(policy.people,[{kind:'outside',person:JSON.stringify(['discord',contact.workspace,contact.user]),tier:2}]);
  assert.equal(policy.word,'others');
  // The fixture executable reports the adapter's actual argument list without contacting a model.
  const commandPath=join(dir,'fixture-claude.mjs');
  await writeFile(commandPath, '#!'+process.execPath+'\n'+fixtureClaude,{mode:0o700});
  async function withheld(job){
   const run=claudeBody({command:commandPath,cwd:dir,env:{},reach:'all'});
   const result=await run(job,'Read the fictional garden report.',AbortSignal.timeout(10000));
   const args=JSON.parse(result.text), index=args.indexOf('--disallowedTools');
   assert.ok(index>=0);
   return args.slice(index+1);
  }
  assert.equal(ownerJob.run.policy.word,'owners');
  const ownerDenied=await withheld(ownerJob);
  assert.ok(ownerDenied.includes(always));
  assert.ok(!ownerDenied.includes(guestOnly));
  const guestDenied=await withheld(preferred);
  assert.ok(guestDenied.includes(always)&&guestDenied.includes(guestOnly));
  // The preferred worker stops reporting. A fresh poll keeps the spare available.
  clock.advance(SILENCE_MS+1);
  const second=queueOutside('preferred-offline');
  // Other example jobs can return to the queue when their worker goes quiet.
  let fallback;
  for(let slot=0;slot<12;slot++){
   const next=await poll(remote,'gpu:5090');
   if(!next)break;
   if(next.id===second){fallback=next;break;}
  }
  assert.equal(fallback?.box,spare,'Live spare did not claim the outside job');
  assert.deepEqual(fallback.run.policy.people,policy.people);
  assert.deepEqual(await withheld(fallback),guestDenied);
  const decisions=JSON.parse(db.prepare('select placement_decision from jobs where id=?').pluck().get(second));
  assert.ok(decisions.some(row=>row.box===runtime.box&&row.outcome==='passed'&&row.reason==='Machine is not live.'));
  return {ok:true,reason:'Two member-owned workers claimed jobs by preference, availability and required GPU. An outside sender was admitted after owner approval. The adapter passed the configured restrictions to a fixture executable for owner and guest jobs, including after the preferred worker went quiet.'};
 }finally{try{await app?.close();}finally{await rm(dir,{recursive:true,force:true});}}
}

const fixtureClaude = `
const args=process.argv.slice(2),session_id=args[args.indexOf('--session-id')+1],text=JSON.stringify(args);
for await(const chunk of process.stdin) {}
console.log(JSON.stringify({type:'assistant',session_id,parent_tool_use_id:null,message:{model:'example-model',content:[{type:'text',text}]}}));
console.log(JSON.stringify({type:'result',session_id,is_error:false,subtype:'success',result:text}));`;
