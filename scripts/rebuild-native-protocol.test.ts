import {it,expect} from 'vitest';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {exampleHome} from '../dist/example-home.js';
import {startSharedHome} from '../dist/shared-startup.js';
import {FakeClock} from '../dist/core/clock.js';
import {prepareAcceptanceHome} from './rebuild-acceptance-adapter.mjs';
import {exampleSettleMs} from '../dist/example-runtime.js';
import {nativeProtocolSmoke} from './rebuild-native-protocol.mjs';
async function household(run){
 const parent=mkdtempSync(join(tmpdir(),'loom-native-protocol-')),home=join(parent,'home');let app;
 try{
  const example=await exampleHome(home);await prepareAcceptanceHome(home);const clock=new FakeClock(Date.parse(example.createdAt));
  app=await startSharedHome({home,port:0,clock,stdout:()=>{}});
  await run({app,example,clock,home,db:app.services.comms.db.$client});
 }finally{await app?.close();rmSync(parent,{recursive:true,force:true});}
}
function restored(db,box){
 expect(db.prepare('SELECT agent FROM box_agents WHERE box=? ORDER BY agent').all(box)).toEqual([{agent:'fern'},{agent:'moss'}]);
 const acquired=db.prepare("SELECT revoked_at FROM tokens WHERE label LIKE 'Native protocol fixture %'").all();
 expect(acquired).toHaveLength(2);expect(acquired.every(row=>!!row.revoked_at)).toBe(true);
}
it('runs both actual queued venues through normal worker/body factories, then retires its authority',{timeout:20_000},()=>household(async context=>{
 const result=await nativeProtocolSmoke(context);expect(result.runs).toHaveLength(2);
 expect(result.runs.every(row=>row.running&&row.hadInput&&row.state==='done'&&row.bootstrapErased)).toBe(true);
 restored(context.db,context.example.runtime.box);
}));
it('preserves an existing private configuration and restores fixture settings after exclusive creation fails',{timeout:20_000},()=>household(async context=>{
 const path=join(context.home,'walkthrough-native-body.json');writeFileSync(path,'Existing fixture bytes',{mode:0o600});
 await expect(nativeProtocolSmoke(context)).rejects.toThrow();expect(readFileSync(path,'utf8')).toBe('Existing fixture bytes');
 restored(context.db,context.example.runtime.box);
}));
it('restores a committed settings change even when the caller loses its response',{timeout:20_000},()=>household(async context=>{
 const controller=new AbortController();let observed=false;
 const off=context.app.writes.observe(()=>{const rows=context.db.prepare('SELECT agent FROM box_agents WHERE box=?').all(context.example.runtime.box);if(!observed&&rows.length===1&&rows[0].agent==='moss'){observed=true;controller.abort();}});
 try{await expect(nativeProtocolSmoke({...context,signal:controller.signal})).rejects.toThrow();}finally{off();}
 expect(observed).toBe(true);restored(context.db,context.example.runtime.box);
}));
it('provides only live scoped conversation commands to the scripted native provider',{timeout:20_000},()=>household(async context=>{
 const retired:((name:string,input:unknown)=>Promise<unknown>)[]=[];
 const result=await nativeProtocolSmoke({...context,native:async({job,call})=>{
  retired.push(call);await expect(call('token.revoke',{})).rejects.toThrow('unavailable');
  await call('digest',{summary:'Authored fictional protocol digest',items:[{kind:'decision',text:'Keep the fictional inspection plan'}]});
  return{text:'Fictional native response',model:'fixture-actually-used-model',actions:[]};
 }});
 for(const row of result.runs){
  expect(context.db.prepare('SELECT model FROM turns WHERE run=? AND kind=\'reply\'').all(row.job)).toEqual([{model:'fixture-actually-used-model'}]);
  expect(context.db.prepare('SELECT summary FROM digests WHERE run=?').all(row.job)).toEqual([{summary:'Authored fictional protocol digest'}]);
 }
 for(const call of retired)await expect(call('digest',{summary:'Late write'})).rejects.toThrow('unavailable');
 restored(context.db,context.example.runtime.box);
}));
it('bounds a pending asynchronous scripted provider, closes its command capability and retires the active lease',{timeout:20_000},()=>household(async context=>{
 const controller=new AbortController();let reached=false,retired;
 await expect(nativeProtocolSmoke({...context,signal:controller.signal,native:async({call})=>{reached=true;retired=call;controller.abort();return new Promise(()=>{});}})).rejects.toThrow();
 expect(reached).toBe(true);await expect(retired('digest',{summary:'Late write'})).rejects.toThrow('unavailable');
 expect(context.db.prepare("SELECT id FROM jobs WHERE state IN ('starting','running','waiting')").all()).toEqual([]);
 restored(context.db,context.example.runtime.box);
}));

it('retires an enrolled job and its scoped capability when the trusted scripted provider rejects',{timeout:20_000},()=>household(async context=>{
 let retired,assigned;
 await expect(nativeProtocolSmoke({...context,native:async({job,call})=>{retired=call;assigned=job.id;throw Error('Fictional provider rejected');}})).rejects.toThrow();
 expect(assigned).toBeTruthy();await expect(retired('digest',{summary:'Late write'})).rejects.toThrow('unavailable');
 expect(context.db.prepare('SELECT state FROM jobs WHERE id=?').get(assigned).state).toBe('failed');
 expect(context.db.prepare("SELECT id FROM jobs WHERE state IN ('starting','running','waiting')").all()).toEqual([]);
 restored(context.db,context.example.runtime.box);
}));
it('bounds a pending asynchronous provider without a caller abort',{timeout:20_000},()=>household(async context=>{
 let reached=false;
 await expect(nativeProtocolSmoke({...context,native:async()=>{reached=true;return new Promise(()=>{});}})).rejects.toThrow();
 expect(reached).toBe(true);expect(context.db.prepare("SELECT id FROM jobs WHERE state IN ('starting','running','waiting')").all()).toEqual([]);
 restored(context.db,context.example.runtime.box);
}));

it('withdraws enrolled body authority even when normal HTTP job retirement is refused',{timeout:20_000},()=>household(async context=>{
 const http=context.app.http,original=http.fetch;let refused=0;
 http.fetch=(request,...args)=>{if(new URL(request.url).pathname==='/api/runtime/finish'){refused++;return Promise.resolve(new Response(JSON.stringify({ok:false}),{status:503,headers:{'content-type':'application/json'}}));}return Reflect.apply(original,http,[request,...args]);};
 try{await expect(nativeProtocolSmoke({...context,native:async()=>{throw Error('Fictional provider rejected');}})).rejects.toThrow('cleanup could not complete');}finally{http.fetch=original;}
 expect(refused).toBeGreaterThan(0);
 const bodies=context.db.prepare("SELECT b.revoked_at FROM tokens b JOIN tokens r ON b.made_from=r.fingerprint WHERE r.label='Native protocol fixture worker' AND b.job IS NOT NULL").all();
 expect(bodies.length).toBeGreaterThan(0);expect(bodies.every(row=>!!row.revoked_at)).toBe(true);
 restored(context.db,context.example.runtime.box);
}));

it('accepts one requested follow-up job after the default jobs without consuming unrelated targets',{timeout:20_000},()=>household(async context=>{
 await nativeProtocolSmoke(context);
 const commit=await context.app.services.comms.prepareSend({thread:context.example.runtime.thread,sender:'alex',kind:'message',clientId:'native-target-followup',words:'Fictional target-only follow-up'});
 context.app.writes.run(commit);context.clock.advance(exampleSettleMs);
 const id=context.app.services.conversations.conversation(context.example.runtime.conversation).job;expect(id).toBeTruthy();
 const result=await nativeProtocolSmoke({...context,targets:[{id,words:'Fictional target-only follow-up'}]});
 expect(result.runs).toHaveLength(1);expect(result.runs[0]).toMatchObject({job:id,state:'done',hadInput:true,running:true,bootstrapErased:true});
 const acquired=context.db.prepare("SELECT revoked_at FROM tokens WHERE label LIKE 'Native protocol fixture %'").all();
 expect(acquired).toHaveLength(4);expect(acquired.every(row=>!!row.revoked_at)).toBe(true);
}));
it('rejects missing, duplicate or empty target inputs before acquiring any authority',{timeout:20_000},()=>household(async context=>{
 for(const targets of [[],[{id:'same',words:'a'},{id:'same',words:'b'}],[{id:'',words:'a'}],[{id:'one',words:' '}],null])await expect(nativeProtocolSmoke({...context,targets})).rejects.toThrow('targets must');
 expect(context.db.prepare("SELECT fingerprint FROM tokens WHERE label LIKE 'Native protocol fixture %'").all()).toEqual([]);
}));

it('refuses a target subset before leasing or acquiring authority',{timeout:20_000},()=>household(async context=>{
 const id=context.example.runtime.publicJob.id;
 await expect(nativeProtocolSmoke({...context,targets:[{id,words:'Inspect the shared garden path'}]})).rejects.toThrow('all queued Moss jobs');
 expect(context.db.prepare("SELECT state FROM jobs WHERE agent='moss'").all()).toEqual([{state:'queued'},{state:'queued'}]);
 expect(context.db.prepare("SELECT fingerprint FROM tokens WHERE label LIKE 'Native protocol fixture %'").all()).toEqual([]);
}));
it('snapshots target IDs and input words across asynchronous execution without disclosing them',{timeout:20_000},()=>household(async context=>{
 const targets=[{id:context.example.runtime.job.id,words:'Check the shed hinges before the example rain.'},{id:context.example.runtime.publicJob.id,words:'Inspect the shared garden path'}];let changed=false;
 const off=context.app.writes.observe(()=>{if(!changed){changed=true;targets[0].id='mutated';targets[0].words='CHANGED_PRIVATE_WORDS';targets.push({id:'another',words:'OTHER_PRIVATE_WORDS'});}});
 let result;try{result=await nativeProtocolSmoke({...context,targets});}finally{off();}
 expect(changed).toBe(true);expect(result.runs).toHaveLength(2);expect(result.runs.every(row=>row.hadInput)).toBe(true);
 const evidence=JSON.stringify(result);expect(evidence).not.toContain('Check the shed hinges');expect(evidence).not.toContain('PRIVATE_WORDS');expect(evidence).not.toMatch(/(?:body_[a-f0-9]{64}|loom_[A-Za-z0-9_-]{43})/);
}));
it('keeps expected input and generated credentials out of forced failure diagnostics',{timeout:20_000},()=>household(async context=>{
 const marker='DISTINCT_PRIVATE_TARGET_WORDS';let diagnostic='';
 try{await nativeProtocolSmoke({...context,targets:[{id:context.example.runtime.job.id,words:marker},{id:context.example.runtime.publicJob.id,words:marker}]});}catch(error){diagnostic=String(error);}
 expect(diagnostic).toContain('did not complete');expect(diagnostic).not.toContain(marker);expect(diagnostic).not.toMatch(/(?:body_[a-f0-9]{64}|loom_[A-Za-z0-9_-]{43})/);
 restored(context.db,context.example.runtime.box);
}));
