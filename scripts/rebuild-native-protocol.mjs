/** Real loopback Root/worker/body protocol. The native provider and build artifact
 * are fictional ports: this does not prove OCI builds, process isolation or a CLI. */
import {randomUUID} from 'node:crypto';
import {writeFileSync,rmSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {httpWorkerControl,reportWorkerHealth} from '../dist/runtime/worker-http.js';
import {workOnce} from '../dist/runtime/worker.js';
import {bodyProgram} from '../dist/runtime/body-program.js';
export async function nativeProtocolSmoke({app,example,clock,home}){
 if(!example.fictional||!example.runtime)throw Error('Native protocol requires the new fictional household');
 const db=app.services.comms.db.$client,box=example.runtime.box;
 const before=db.prepare('SELECT name,hosts_any,report_only,always_on FROM boxes WHERE id=?').get(box);
 if(!before)throw Error('The example worker is unavailable');
 const settings={box,name:before.name,hostsAny:!!before.hosts_any,reportOnly:!!before.report_only,alwaysOn:!!before.always_on,
  agents:db.prepare('SELECT agent,lent FROM box_agents WHERE box=? ORDER BY agent').all(box).map(row=>({agent:row.agent,lent:!!row.lent})),facts:db.prepare('SELECT fact FROM box_facts WHERE box=? AND from_owner=1 ORDER BY fact').all(box).map(row=>row.fact)};
 const configuration=join(home,'walkthrough-native-body.json');
 const abort=new AbortController(),runs=[];let owner,runner,changed=false;
 const command=async input=>{
  const response=await fetch(app.url+'/api/runtime/boxSettingsSet',{method:'POST',headers:{authorization:'Bearer '+owner.token,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),input}),signal:abort.signal});
  const result=await response.json();if(!response.ok||result.ok!==true)throw Error('Native fixture worker settings were unavailable');
 };
 try{
  owner=app.writes.run(()=>app.services.signin.issue({kind:'owner',member:'alex',label:'Native protocol fixture setup',expiresAt:new Date(clock.now()+60_000).toISOString()})).value;
  runner=app.writes.run(()=>app.services.signin.issue({kind:'runner',box,label:'Native protocol fixture worker',expiresAt:new Date(clock.now()+60_000).toISOString()})).value;
  await command({...settings,agents:settings.agents.filter(row=>row.agent==='moss')});changed=true;
  writeFileSync(configuration,JSON.stringify({command:'/fictional/native-provider',cwd:home}),{mode:0o600,flag:'wx'});
  const responses=[];const access={url:app.url,token:runner.token,signal:abort.signal,timeoutMs:5000,fetch:async(url,init)=>{const response=await fetch(url,init);if(new URL(url).pathname==='/api/runtime/enrollBody'){const body=await response.clone().json();responses.push({status:response.status,ok:body.ok,code:body.error?.code??body.code,message:String(body.error?.message??body.message??'').replace(/(?:body|loom)_[a-zA-Z0-9_-]{32,}/g,'[credential]')});}return response;}};
  await reportWorkerHealth({...access,facts:['arch:example']});const trace=[],rawControl=httpWorkerControl(access),control=Object.fromEntries(Object.entries(rawControl).map(([name,method])=>[name,async(...args)=>{trace.push(name);try{return await method(...args);}catch(error){trace.push(name+': '+String(error));throw error;}}]));
  const expected=new Set([example.runtime.job.id,example.runtime.publicJob.id]);
  for(let n=0;n<2;n++){
   let observed,bodyBytes;
   const executor={build:async job=>{trace.push('build '+job.id);if(!expected.has(job.id))throw Error('A different fixture job was assigned');return'fictional-native-artifact';},start(job,build,parentSignal){
    let settle,execution,released=false;const stopped=new AbortController();
    const exited=new Promise(resolve=>{settle=resolve;});
    return{spawned:Promise.resolve(),acceptsBootstrap:true,exited,
     async release(bootstrap){
      if(released||!bootstrap)throw Error('Native fixture bootstrap was unavailable');released=true;
      bodyBytes=Buffer.from(JSON.stringify({job,build,bootstrap:{origin:bootstrap.origin,job:bootstrap.job,token:bootstrap.token.toString('ascii')}}));
      execution=bodyProgram({args:[configuration],read:path=>readFile(path,'utf8'),stdin:async()=>bodyBytes,env:{},signal:AbortSignal.any([parentSignal,stopped.signal]),clock,
       native:async(assigned,words)=>{observed={job:assigned.id,conversation:assigned.conversation,requestedModel:assigned.model,hadInput:words.length>0,running:db.prepare('SELECT state FROM jobs WHERE id=?').get(job.id)?.state==='running'};return{text:'Fictional native protocol response.',model:'fixture-observed-native-model',actions:[]};},
       error:()=>{}}).then(exitCode=>{settle({exitCode,logTail:''});});
      void execution.catch(()=>settle({exitCode:1,logTail:''}));
     },
     async stop(){stopped.abort();if(execution)await execution;else settle({exitCode:1,logTail:''});},
    };
   }};
   const result=await workOnce({box,control,executor,signal:abort.signal});
   if(result!=='finished'||!observed?.hadInput||!observed.running||!bodyBytes?.every(byte=>byte===0))throw Error('The real native protocol did not complete: '+JSON.stringify({result,observed,expected:[...expected],trace,responses,erased:bodyBytes?.every(byte=>byte===0),jobs:db.prepare('SELECT id,state,conversation FROM jobs WHERE agent=?').all('moss')}));
   const row=db.prepare('SELECT state,model,conversation FROM jobs WHERE id=?').get(observed.job);
   if(row?.state!=='done')throw Error('The native fixture body did not finish successfully');
   runs.push({...observed,state:row.state,bootstrapErased:true});expected.delete(observed.job);
  }
  if(expected.size)throw Error('The example private and public jobs were not both observed');
  return{runs,scope:'Real Root HTTP and normal worker/body code; fictional native provider and artifact only.'};
 }finally{
  // Restore configuration while its normal authority is still current; every
  // acquired credential is retired even if restoration or a protocol step fails.
  try{if(changed)await command(settings);}finally{
   abort.abort();rmSync(configuration,{force:true});
   app.writes.run(()=>{if(runner)app.services.signin.revoke(runner.fingerprint);if(owner)app.services.signin.revoke(owner.fingerprint);});
  }
 }
}
