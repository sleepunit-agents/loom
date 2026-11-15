/** Execute the built CLI function against the actual disposable household HTTP. */
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {runSharedTaskClient} from '../dist/cli/shared-task-client.js';

export async function taskstoreClientAction({page,app,home,member='alex'}){
 const directory=mkdtempSync(join(home,'taskstore-client-proof-')),file=join(directory,'token');let fingerprint,raw;
 const fail=message=>{throw Error(message);};
 try{
  // One-time issuance has no retry: an ambiguous answer must not issue again.
  const issued=await page.request.post(app.url+'/api/signin/program',{headers:{origin:app.url},data:{member,label:'Fictitious Tasks CLI '+randomUUID(),records:['tasks'],operations:['tasks.command']}});
  const envelope=await issued.json(),credential=envelope.value;if(issued.status()!==200||envelope.ok!==true||typeof credential?.token!=='string'||typeof credential?.fingerprint!=='string')fail('Fictitious CLI credential issuance failed');
  raw=credential.token;fingerprint=credential.fingerprint;writeFileSync(file,raw,{mode:0o600,flag:'wx'});
  const run=async args=>{
   let stdout='',stderr='';const code=await runSharedTaskClient(args,{stdin:Readable.from([]),stdinIsTTY:false,env:{LOOM_URL:app.url,LOOM_TOKEN_FILE:file},stdout:text=>{stdout+=text;},stderr:text=>{stderr+=text;}});
   if(stdout.includes(raw)||stderr.includes(raw))fail('CLI output contained its credential');
   let value;try{value=JSON.parse(stdout);}catch{fail('CLI output was not structured');}
   return{code,value};
  };
  const input={action:'create',input:{title:'Fictitious canonical CLI task',goal:'Prove the shared Tasks command-line door.',why:'Verify the built client with current programme grants.',owner:{kind:'member',id:member}}};
  const created=await run(['command',JSON.stringify(input)]);if(created.code!==0||!created.value.id)fail('CLI command did not create a task');
  const id=created.value.id,ready=await run(['ready']);if(ready.code!==0||!ready.value.entries?.some(row=>row.id===id&&row.isReady===true))fail('CLI ready did not use current server eligibility');
  const shown=await run(['show',id]);if(shown.code!==0||shown.value.task?.id!==id)fail('CLI show did not return its created task');
  const closed=await run(['command',JSON.stringify({action:'close',id,reason:'Completed the fictional CLI verification'})]);if(closed.code!==0)fail('CLI close was refused');
  const after=await run(['ready']);if(after.code!==0||after.value.entries?.some(row=>row.id===id))fail('CLI ready retained a closed task');
  const revoked=await page.request.post(app.url+'/api/token/revoke',{headers:{origin:app.url},data:{id:randomUUID(),input:{fingerprint}}});
  if(revoked.status()!==200||(await revoked.json()).ok!==true)fail('Fictitious CLI credential revocation failed');
  fingerprint=undefined;const denied=await run(['ready']);if(denied.code===0||denied.value.ok!==false)fail('Revoked CLI retained access');
  return{ok:true,builtClient:true,canonicalRead:true,canonicalWrite:true,closedLeavesQueue:true,revokedRefused:true};
 }catch(error){return{ok:false,error:String(error)};}
 finally{
  if(fingerprint)await page.request.post(app.url+'/api/token/revoke',{headers:{origin:app.url},data:{id:randomUUID(),input:{fingerprint}}}).catch(()=>{});
  raw=undefined;rmSync(directory,{recursive:true,force:true});
 }
}
