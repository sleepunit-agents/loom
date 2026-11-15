/** Real loopback Root/worker/body protocol. The native provider and build artifact
 * are trusted in-process fictional ports: this does not prove OCI builds,
 * process isolation or a CLI. Cancellation bounds pending asynchronous providers;
 * it cannot preempt a callback that blocks the JavaScript event loop. */
import {randomUUID} from 'node:crypto';
import {writeFileSync,rmSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {httpWorkerControl,reportWorkerHealth} from '../dist/runtime/worker-http.js';
import {workOnce} from '../dist/runtime/worker.js';
import {bodyProgram} from '../dist/runtime/body-program.js';
import {bodyInput} from '../dist/runtime/body-bootstrap.js';
export async function nativeProtocolSmoke({app,example,clock,home,signal,native}){
 if(!example.fictional||!example.runtime)throw Error('Native protocol requires the new fictional household');
 const db=app.services.comms.db.$client,box=example.runtime.box;
 const before=db.prepare('SELECT name,hosts_any,report_only,always_on FROM boxes WHERE id=?').get(box);
 if(!before)throw Error('The example worker is unavailable');
 const settings={box,name:before.name,hostsAny:!!before.hosts_any,reportOnly:!!before.report_only,alwaysOn:!!before.always_on,
  agents:db.prepare('SELECT agent,lent FROM box_agents WHERE box=? ORDER BY agent').all(box).map(row=>({agent:row.agent,lent:!!row.lent})),facts:db.prepare('SELECT fact FROM box_facts WHERE box=? AND from_owner=1 ORDER BY fact').all(box).map(row=>row.fact)};
 const configuration=join(home,'walkthrough-native-body.json');
 const abort=new AbortController(),runs=[],assigned=new Set();let owner,runner,changed=false,configurationCreated=false;
 const stop=()=>abort.abort();signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
 const deadline=setTimeout(stop,12_000);
 const command=async(input,requestSignal=abort.signal)=>{
  const response=await fetch(app.url+'/api/runtime/boxSettingsSet',{method:'POST',headers:{authorization:'Bearer '+owner.token,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),input}),signal:requestSignal});
  const result=await response.json();if(!response.ok||result.ok!==true)throw Error('Native fixture worker settings were unavailable');
 };
 try{
  if(abort.signal.aborted)throw Error('Native fixture cancelled');
  owner=app.writes.run(()=>app.services.signin.issue({kind:'owner',member:'alex',label:'Native protocol fixture setup',expiresAt:new Date(clock.now()+60_000).toISOString()})).value;
  runner=app.writes.run(()=>app.services.signin.issue({kind:'runner',box,label:'Native protocol fixture worker',expiresAt:new Date(clock.now()+60_000).toISOString()})).value;
  changed=true;await command({...settings,agents:settings.agents.filter(row=>row.agent==='moss')});
  writeFileSync(configuration,JSON.stringify({command:'/fictional/native-provider',cwd:home}),{mode:0o600,flag:'wx'});configurationCreated=true;
  const access={url:app.url,token:runner.token,signal:abort.signal,timeoutMs:5000};
  await reportWorkerHealth({...access,facts:['arch:example']});const trace=[],rawControl=httpWorkerControl(access);
  const control=Object.fromEntries(Object.entries(rawControl).map(([name,method])=>[name,async(...args)=>{
   trace.push(name);try{const result=await method(...args);if(name==='next'&&result)assigned.add(result.id);return result;}catch(error){trace.push(name+'-failed');throw error;}
  }]));
  const expected=new Set([example.runtime.job.id,example.runtime.publicJob.id]);
  for(let n=0;n<2;n++){
   let observed,bodyBytes,commandToken;
   const executor={build:async job=>{trace.push('build '+job.id);if(!expected.has(job.id))throw Error('A different fixture job was assigned');return'fictional-native-artifact';},start(job,build,parentSignal){
    let settle,execution,released=false;const stopped=new AbortController();
    const exited=new Promise(resolve=>{settle=resolve;});
    return{spawned:Promise.resolve(),acceptsBootstrap:true,exited,
     async release(bootstrap){
      if(released||!bootstrap)throw Error('Native fixture bootstrap was unavailable');released=true;
      bodyBytes=Buffer.from(JSON.stringify(bodyInput(job,build,bootstrap,true)));
      commandToken=Buffer.from(bootstrap.token);
      execution=bodyProgram({args:[configuration],read:path=>readFile(path,'utf8'),stdin:async()=>bodyBytes,env:{},signal:AbortSignal.any([parentSignal,stopped.signal]),clock,
       native:async(job,words,bodySignal)=>{
        const expectedWords=job.id===example.runtime.job.id?'Check the shed hinges before the example rain.':'Inspect the shared garden path';
        observed={job:job.id,conversation:job.conversation,requestedModel:job.model,hadInput:words.includes(expectedWords),running:db.prepare('SELECT state FROM jobs WHERE id=?').get(job.id)?.state==='running',currentJob:db.prepare('SELECT job FROM conversations WHERE id=?').get(job.conversation)?.job};
        let finished=false;
        const call=async(name,input)=>{
         if(finished||bodySignal.aborted||!['digest','turn','status'].includes(name))throw Error('Native fixture command is unavailable');
         const token=commandToken.toString('ascii');
         const response=await fetch(app.url+'/api/conversation/'+name,{method:'POST',signal:bodySignal,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),input})});
         const result=await response.json();if(!response.ok||result.ok!==true)throw Error('Native fixture command was refused');return result.value;
        };
        let refuse;const cancelled=new Promise((_,reject)=>{refuse=()=>reject(Error('Native fixture provider stopped'));bodySignal.addEventListener('abort',refuse,{once:true});});
        try{
         if(bodySignal.aborted)throw Error('Native fixture provider stopped');
         return await Promise.race([Promise.resolve().then(()=>native?native({job:structuredClone(job),words,signal:bodySignal,call}):{text:'Fictional native protocol response.',model:'fixture-observed-native-model',actions:[]}),cancelled]);
        }finally{finished=true;commandToken.fill(0);bodySignal.removeEventListener('abort',refuse);}
       },
       error:()=>trace.push('body-unavailable')}).then(exitCode=>{settle({exitCode,logTail:'PRIVATE_NATIVE_FIXTURE_OUTPUT'});});
      void execution.finally(()=>commandToken.fill(0)).catch(()=>settle({exitCode:1,logTail:''}));
     },
     async stop(){stopped.abort();if(execution)await execution.catch(()=>{});else settle({exitCode:1,logTail:''});},
    };
   }};
   const result=await workOnce({box,control,executor,signal:abort.signal});
   if(result!=='finished'||!observed?.hadInput||!observed.running||observed.currentJob!==observed.job||!bodyBytes?.every(byte=>byte===0))throw Error('The real native protocol did not complete: '+JSON.stringify({result,observed,expected:[...expected],trace,erased:bodyBytes?.every(byte=>byte===0),jobs:db.prepare('SELECT id,state,conversation FROM jobs WHERE agent=?').all('moss')}));
   const row=db.prepare('SELECT state,model,conversation,box,log_tail FROM jobs WHERE id=?').get(observed.job);
   if(!commandToken?.every(byte=>byte===0))throw Error('Native fixture capability was not erased');
   if(row?.state!=='done'||row.model!==observed.requestedModel||row.conversation!==observed.conversation||row.box!==box)throw Error('The native fixture body did not finish in its assigned scope: '+JSON.stringify({row,observed}));
   if(db.prepare('SELECT job FROM conversations WHERE id=?').get(observed.conversation)?.job!==null)throw Error('The conversation retained a completed current job');
   if(row.log_tail?.includes('PRIVATE_NATIVE_FIXTURE_OUTPUT'))throw Error('Native worker output escaped into job metadata');
   runs.push({...observed,state:row.state,bootstrapErased:true});expected.delete(observed.job);
  }
  if(expected.size)throw Error('The example private and public jobs were not both observed');
  return{runs,scope:'Real Root HTTP and normal worker/body code; fictional native provider and artifact only.'};
 }finally{
  abort.abort();clearTimeout(deadline);signal?.removeEventListener('abort',stop);
  const failures=[],cleanup=new AbortController(),cleanupDeadline=setTimeout(()=>cleanup.abort(),5000);
  try{
   if(runner){const control=httpWorkerControl({url:app.url,token:runner.token,signal:cleanup.signal,timeoutMs:4000});
    for(const id of assigned){const row=db.prepare('SELECT state FROM jobs WHERE id=?').get(id);if(row&&['starting','running','waiting'].includes(row.state))try{await control.finish(id,1,'');}catch{failures.push('active-body retirement');}}
   }
   if(changed)try{await command(settings,cleanup.signal);}catch{failures.push('worker settings restoration');}
  }finally{
   clearTimeout(cleanupDeadline);
   try{if(configurationCreated)rmSync(configuration);}catch{failures.push('private configuration cleanup');}
   try{app.writes.run(()=>{
    // A refused finish must not leave body authority alive. These fingerprints
    // came from normal SDK enrollment under this helper's unique runner.
    if(runner)for(const row of db.prepare("SELECT fingerprint FROM tokens WHERE made_from=? AND kind='agent' AND job IS NOT NULL").all(runner.fingerprint))app.services.signin.revoke(row.fingerprint);
    if(runner)app.services.signin.revoke(runner.fingerprint);if(owner)app.services.signin.revoke(owner.fingerprint);
   });}catch{failures.push('credential retirement');}
  }
  if(failures.length)throw Error('Native fixture cleanup could not complete: '+failures.join(', '));
 }
}

/** The browser observes the reply produced through the same actual body path. */
export async function nativeProtocolAction(context){
 const {page,open,out}=context,actions={};
 try{actions.nativeProtocol={ok:true,...await nativeProtocolSmoke(context)};}
 catch{actions.nativeProtocol={ok:false,error:'The fictional native protocol could not complete or restore its temporary authority.'};return actions;}
 const screenshot='action-nativeReply.png';
 try{
  const tile=await open('Comms');const back=tile.locator('.loom-split__back:visible');if(await back.count())await back.first().click();
  await tile.getByText('Inspect the example shed',{exact:true}).first().click();
  await tile.getByText('Fictional native protocol response.',{exact:true}).waitFor();
  await page.reload();const current=page.getByRole('region',{name:'Comms tile',exact:true});
  await current.getByText('Fictional native protocol response.',{exact:true}).waitFor();
  actions.nativeReply={ok:true,persistedAfterReload:true,screenshot};
 }catch{actions.nativeReply={ok:false,error:'The native fixture reply was not observed in its browser thread after reload.',screenshot};}
 await page.screenshot({path:join(out,screenshot),fullPage:true});return actions;
}
