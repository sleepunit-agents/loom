import {it,expect} from 'vitest';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {exampleHome} from '../dist/example-home.js';
import {startSharedHome} from '../dist/shared-startup.js';
import {FakeClock} from '../dist/core/clock.js';
import {prepareAcceptanceHome} from './rebuild-acceptance-adapter.mjs';
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
it('bounds an uncooperative scripted provider, closes its command capability and retires the active lease',{timeout:20_000},()=>household(async context=>{
 const controller=new AbortController();let reached=false,retired;
 await expect(nativeProtocolSmoke({...context,signal:controller.signal,native:async({call})=>{reached=true;retired=call;controller.abort();return new Promise(()=>{});}})).rejects.toThrow();
 expect(reached).toBe(true);await expect(retired('digest',{summary:'Late write'})).rejects.toThrow('unavailable');
 expect(context.db.prepare("SELECT id FROM jobs WHERE state IN ('starting','running','waiting')").all()).toEqual([]);
 restored(context.db,context.example.runtime.box);
}));
