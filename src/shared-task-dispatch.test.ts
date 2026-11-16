/** Headless queue -> Inbox -> normal worker/body; fictional provider/artifact IO. */
import {expect,it} from 'vitest';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {z} from 'zod';
import {FakeClock} from './core/clock.js';
import {exampleHome} from './example-home.js';
import {exampleSettleMs} from './example-runtime.js';
import {startSharedHome} from './shared-startup.js';
import {runSharedTaskClient} from './cli/shared-task-client.js';
// Shared measurement ports execute built worker/body code against this actual Root.
// @ts-expect-error measurement scripts do not ship declarations
import {prepareAcceptanceHome} from '../scripts/rebuild-acceptance-adapter.mjs';
// @ts-expect-error measurement scripts do not ship declarations
import {nativeProtocolSmoke} from '../scripts/rebuild-native-protocol.mjs';

type Context={app:Awaited<ReturnType<typeof startSharedHome>>;home:string;clock:FakeClock;example:Awaited<ReturnType<typeof exampleHome>>};
type Capability=(name:string,input:unknown)=>Promise<unknown>;
const identifier=z.object({id:z.string()});
const cliReply=z.object({ok:z.boolean(),id:z.string().optional(),task:identifier.optional(),entries:z.array(identifier).optional(),tasks:z.array(identifier).optional(),errors:z.array(z.string()).optional()});
async function rootCommand(app:Context['app'],token:string,name:string,input:unknown){
 const response=await fetch(app.url+'/api/'+name,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),input})});
 expect(response.status).toBe(200);return z.object({ok:z.literal(true),value:z.unknown()}).parse(await response.json()).value;
}
async function withTemporaryRoot(run:(context:Context)=>Promise<void>){
 const parent=mkdtempSync(join(tmpdir(),'loom-task-dispatch-')),home=join(parent,'home'),webRoot=join(parent,'web');
 let app:Context['app']|undefined;
 try{
  mkdirSync(webRoot);writeFileSync(join(webRoot,'next.html'),'<main>Fictitious household</main>');
  const example=await exampleHome(home,webRoot);await prepareAcceptanceHome(home);
  const clock=new FakeClock(Date.parse(example.createdAt));app=await startSharedHome({home,webRoot,clock,port:0,stdout:()=>{}});
  await run({app,home,example,clock});
 }finally{await app?.close();rmSync(parent,{recursive:true,force:true});}
}

it('a scheduled work sweep wakes one body that claims, comments on and closes its ready task without a desk',()=>withTemporaryRoot(async context=>{
 const {app,clock}=context;expect((await nativeProtocolSmoke(context)).runs).toHaveLength(2);
 const setup=app.writes.run(()=>app.services.signin.issue({kind:'owner',member:'alex',label:'Fictitious headless dispatch setup',expiresAt:new Date(clock.now()+60_000).toISOString()})).value;
 const command=(name:string,input:unknown)=>rootCommand(app,setup.token,name,input);
 const setSweep=async(note:string)=>identifier.parse(await command('tempo/set',{ownerKind:'household',sourceKind:'time',times:new Date(clock.now()+1000).toISOString(),lifespan:'once',targetKind:'operation',target:'tempo.sweep',toKind:'agent',to:'moss',note}));
 try{
  const title='Inspect the fictional pump valve';
  const task=identifier.parse(await command('tasks/command',{action:'create',input:{title,goal:'Record a fictional valve inspection.',why:'Exercise headless dispatch.',owner:{kind:'agent',id:'moss'}}}));
  const hidden=identifier.parse(await command('tasks/command',{action:'create',input:{title:'Fictitious private Fern work',goal:'Private goal',why:'Test current body policy',owner:{kind:'agent',id:'fern'}}}));
  const ready=await fetch(app.url+'/graphql',{method:'POST',headers:{authorization:'Bearer '+setup.token,'content-type':'application/json'},body:JSON.stringify({query:'{readyTasks{id}}'})});
  expect(ready.status).toBe(200);expect(z.object({data:z.object({readyTasks:z.array(identifier)})}).parse(await ready.json()).data.readyTasks).toContainEqual(task);
  await command('tempo/pause',{agent:'moss'});const trigger=await setSweep('Fictitious ready work sweep');
  const comms=app.services.comms;if(!comms)throw Error('Fictitious dispatch needs Conversations');
  const db=comms.db.$client,queued=()=>db.prepare("SELECT id FROM jobs WHERE agent='moss' AND state='queued'").all();
  expect(queued()).toEqual([]);clock.advance(1000+exampleSettleMs);expect(queued()).toEqual([]);
  expect(db.prepare('SELECT state FROM triggers WHERE id=?').get(trigger.id)).toMatchObject({state:'held'});
  await command('tempo/resume',{agent:'moss'});
  const settleMs=app.services.tempo.volume.timings({kind:'agent',id:'moss'}).settleSeconds*1000;
  expect(settleMs).toBeGreaterThan(0);expect(queued()).toEqual([]);
  clock.advance(settleMs-1);expect(queued()).toEqual([]);clock.advance(1);
  const pending=db.prepare("SELECT id,conversation FROM jobs WHERE agent='moss' AND state='queued'").all() as Array<{id:string;conversation:string}>;
  expect(pending).toHaveLength(1);
  expect(db.prepare('SELECT venue FROM conversations WHERE id=?').get(pending[0].conversation)).toMatchObject({venue:'wake'});
  const mail=db.prepare('SELECT words FROM inbox WHERE conversation=?').get(pending[0].conversation) as {words:string};expect(mail.words).toContain(title);expect(mail.words).not.toContain('Fictitious private Fern work');
  let bodyCapability:Capability|undefined;
  const result=await nativeProtocolSmoke({...context,targets:[{id:pending[0].id,words:title}],native:async({call}:{call:Capability})=>{
   bodyCapability=call;await expect(call('tasks.other',{})).rejects.toThrow('unavailable');
   await expect(call('tasks.command',{action:'close',id:hidden.id,reason:'Forbidden private peer mutation'})).rejects.toThrow('Native fixture command was refused');
   expect(await call('tasks.command',{action:'claim',id:task.id})).toEqual({id:task.id});
   expect(await call('tasks.command',{action:'comment',id:task.id,text:'Inspected the fictional valve; no outside action.'})).toEqual({id:task.id});
   expect(await call('tasks.command',{action:'close',id:task.id,reason:'Fictional valve inspection complete'})).toEqual({id:task.id});
   await call('digest',{summary:'Finished the ready valve inspection.',items:[{kind:'task',text:task.id+' completed'}]});
   return{text:'Fictional valve inspection complete.',model:'fixture-dispatch-observed-model',actions:[]};
  }});
  expect(result.runs).toEqual([expect.objectContaining({job:pending[0].id,state:'done',running:true,hadInput:true,bootstrapErased:true})]);
  if(!bodyCapability)throw Error('No actual enrolled task capability');
  // This checks observable retirement. It does not isolate each unchanged guard predicate.
  await expect(bodyCapability('tasks.command',{action:'comment',id:task.id,text:'Forbidden late action'})).rejects.toThrow('unavailable');
  expect(app.services.tasks.get(hidden.id).status).toBe('open');
  expect(app.services.tasks.get(task.id)).toMatchObject({status:'closed',assigneeKind:'agent',assignee:'moss',closeReason:'Fictional valve inspection complete',comments:[expect.objectContaining({actorKind:'agent',actor:'moss',text:'Inspected the fictional valve; no outside action.'})]});
  expect(db.prepare('SELECT summary FROM digests WHERE run=?').get(pending[0].id)).toMatchObject({summary:'Finished the ready valve inspection.'});
  expect(db.prepare('SELECT state FROM triggers WHERE id=?').get(trigger.id)).toMatchObject({state:'fired'});
  const empty=await setSweep('Fictitious sweep after closed work');clock.advance(1000+exampleSettleMs);
  expect(db.prepare('SELECT state FROM triggers WHERE id=?').get(empty.id)).toMatchObject({state:'fired'});expect(queued()).toEqual([]);
  // Positive control: the reused sweep conversation still admits later ready work.
  const nextTitle='Inspect the fictitious return valve';
  const nextTask=identifier.parse(await command('tasks/command',{action:'create',input:{title:nextTitle,goal:'Record the next fictional inspection',why:'Prove dispatch continues after completion',owner:{kind:'agent',id:'moss'}}}));
  await setSweep('Fictitious sweep with subsequent work');clock.advance(1000+exampleSettleMs);
  const following=db.prepare("SELECT id,conversation FROM jobs WHERE agent='moss' AND state='queued'").all() as Array<{id:string;conversation:string}>;
  expect(following).toHaveLength(1);expect(following[0].conversation).toBe(pending[0].conversation);
  const continued=await nativeProtocolSmoke({...context,targets:[{id:following[0].id,words:nextTitle}],native:async({call}:{call:Capability})=>{
   await call('tasks.command',{action:'claim',id:nextTask.id});await call('tasks.command',{action:'close',id:nextTask.id,reason:'Finished the next fictional inspection'});
   return{text:'Next fictitious inspection complete.',model:'fixture-dispatch-observed-model',actions:[]};
  }});
  expect(continued.runs).toEqual([expect.objectContaining({job:following[0].id,state:'done'})]);expect(app.services.tasks.get(nextTask.id).status).toBe('closed');

 }finally{app.writes.run(()=>app.services.signin.revoke(setup.fingerprint));}
}));

it('the Tasks client function keeps an ordinary agent identity and current visibility',()=>withTemporaryRoot(async({app,home,clock})=>{
 // The fixture supplies an ordinary agent token; external issuance is DOOR's proof.
 const credential=app.writes.run(()=>app.services.signin.issue({kind:'agent',agent:'moss',label:'Fictitious terminal task client',expiresAt:new Date(clock.now()+60_000).toISOString()})).value;
 const setup=app.writes.run(()=>app.services.signin.issue({kind:'owner',member:'alex',label:'Fictitious terminal peer setup',expiresAt:new Date(clock.now()+60_000).toISOString()})).value;
 const file=join(home,'terminal-task-token');writeFileSync(file,credential.token,{mode:0o600,flag:'wx'});
 try{
  const hiddenTitle='Fictional private Fern work';
  const hidden=identifier.parse(await rootCommand(app,setup.token,'tasks/command',{action:'create',input:{title:hiddenTitle,goal:'Private goal',why:'Test current agent visibility',owner:{kind:'agent',id:'fern'}}}));
  const invoke=async(args:string[])=>{
   let stdout='',stderr='';const code=await runSharedTaskClient(args,{stdin:Readable.from([]),stdinIsTTY:false,env:{LOOM_URL:app.url,LOOM_TOKEN_FILE:file},stdout:text=>{stdout+=text;},stderr:text=>{stderr+=text;}});
   expect(stdout+stderr).not.toContain(credential.token);expect(stdout+stderr).not.toContain(hiddenTitle);
   return{code,value:cliReply.parse(JSON.parse(stdout) as unknown)};
  };
  const created=await invoke(['command',JSON.stringify({action:'create',input:{title:'Fictitious terminal work',goal:'Exercise the agent door',why:'Prove browserless Tasks',owner:{kind:'agent',id:'moss'}}})]);
  expect(created.code).toBe(0);const {id}=identifier.parse(created.value);
  expect((await invoke(['ready'])).value.entries).toEqual(expect.arrayContaining([expect.objectContaining({id})]));
  expect((await invoke(['show',id])).value.task).toEqual({id});
  expect((await invoke(['show',hidden.id])).code).toBe(1);expect((await invoke(['list'])).code).toBe(0);expect((await invoke(['search',hiddenTitle])).value.tasks).toEqual([]);
  for(const input of [{action:'claim',id},{action:'comment',id,text:'An ordinary terminal agent recorded this result.'},{action:'close',id,reason:'Finished fictitious terminal work'}])expect((await invoke(['command',JSON.stringify(input)])).code).toBe(0);
  expect(app.services.tasks.get(id)).toMatchObject({createdByKind:'agent',createdBy:'moss',assigneeKind:'agent',assignee:'moss',status:'closed',comments:[expect.objectContaining({actorKind:'agent',actor:'moss'})]});
  expect((await invoke(['command',JSON.stringify({action:'close',id:hidden.id,reason:'Forbidden cross-agent action'})])).code).toBe(1);
  expect(app.services.tasks.get(hidden.id).status).toBe('open');
  app.writes.run(()=>app.services.signin.revoke(credential.fingerprint));expect(await invoke(['ready'])).toMatchObject({code:1,value:{ok:false,errors:['Request refused']}});
  expect(await invoke(['command',JSON.stringify({action:'comment',id,text:'Forbidden revoked action'})])).toMatchObject({code:1,value:{ok:false,errors:['Request refused']}});
  expect(app.services.tasks.get(id).comments).toHaveLength(1);
 }finally{app.writes.run(()=>{app.services.signin.revoke(credential.fingerprint);app.services.signin.revoke(setup.fingerprint);});rmSync(file,{force:true});}
}));

it('the enrolled task capability refuses calls after cancellation and leaves no live job or task action',()=>withTemporaryRoot(async context=>{
 const controller=new AbortController();let refusal:Promise<string>|undefined;
 await expect(nativeProtocolSmoke({...context,signal:controller.signal,native:async({call}:{call:Capability})=>{
  controller.abort();refusal=call('tasks.command',{action:'create',input:{title:'Forbidden cancelled task',goal:'Must not happen',why:'Cancellation boundary',owner:{kind:'agent',id:'moss'}}}).then(()=> 'Allowed',error=>String(error));
  return{text:'Cancelled fictional work',model:'fixture-cancelled-model',actions:[]};
 }})).rejects.toThrow();
 expect(refusal).toBeDefined();expect(await refusal).toContain('Native fixture command is unavailable');
 expect(context.app.services.tasks.list().some(task=>task.title==='Forbidden cancelled task')).toBe(false);
 const comms=context.app.services.comms;if(!comms)throw Error('Fictitious dispatch needs Conversations');
 expect(comms.db.$client.prepare("SELECT id FROM jobs WHERE state IN ('starting','running','waiting')").all()).toEqual([]);
}));
