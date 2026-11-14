import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { startLoom } from '../../foundation.js';
import { FakeClock, exportDatabase, type Viewer, type Sharing } from '../../core/index.js';
import type { ClockProvenance } from '../runtime/role.js';
import { installClock } from './index.js';
import { schedules, wakes } from './store.js';
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const body:Viewer={kind:'agent',id:'art'},owner:Viewer={kind:'member',id:'jonathan'};
const input={agent:'art',id:'art/daily',at:'13:17',prompt:'PRIVATE_WORDS',note:'PRIVATE_NOTE'};
async function setup(privateWork=true){
 const home=mkdtempSync(join(tmpdir(),'clock-private-control-'));cleanup.push(()=>rmSync(home,{recursive:true,force:true}));
 let proof:ClockProvenance|undefined={agent:'art',conversation:'cv-original',...(privateWork?{member:'jonathan'}:{}),principal:{for:'pollock',people:['pollock']}};
 const access:Sharing={members:{jonathan:{owner:true,agents:['art']},other:{owner:true,agents:['art']}},projects:{pond:{members:['jonathan'],agents:['art']}},services:{}};
 const app=await startLoom({home,clock:new FakeClock(),install(app){const jobs=installClock(app.db,app.operations,app.live,()=>access,{provenance:v=>v===body?proof:undefined});app.onClose(jobs.close);}});cleanup.push(app.close);
 const call=(name:string,data:object,viewer=body,id=randomUUID())=>app.operations.call('direct',viewer,'clock.'+name,data,id);
 const snapshot=()=>JSON.stringify({s:schedules(app.db),w:wakes(app.db),e:app.db.prepare('SELECT * FROM clock_events').all()});
 return {app,call,snapshot,access,get proof(){return proof;},set proof(p:ClockProvenance|undefined){proof=p;}};
}
it('creates and replaces private schedules without flattening scope or exposing words, including receipts and export',async()=>{
 const f=await setup(),id=randomUUID(),ack=f.call('scheduleSet',input,body,id);
 expect(ack).toMatchObject({ok:true,value:{id:input.id,private:true,due:expect.any(Number)}});
 expect(JSON.stringify(ack)).not.toMatch(/PRIVATE_|authorship|pollock|cv-original/);
 expect(f.call('scheduleSet',input,body,id)).toEqual(ack);
 expect(schedules(f.app.db)[0]).toMatchObject({member:'jonathan',authorship:{origin:'art',conversation:'cv-original',member:'jonathan',principal:{for:'pollock',people:['pollock']}}});
 expect(wakes(f.app.db)[0].authorship).toEqual(schedules(f.app.db)[0].authorship);
 expect(f.call('scheduleSet',{...input,prompt:'PRIVATE_EDIT'}).ok).toBe(true);
 expect(schedules(f.app.db)[0].member).toBe('jonathan');
 for(const v of [body,owner,{kind:'member',id:'other'}] as Viewer[])for(const op of ['list','schedules','log'])expect(JSON.stringify(f.call(op,{},v))).not.toContain('PRIVATE_');
 expect(JSON.stringify(exportDatabase(f.app.db))).not.toMatch(/PRIVATE_|cv-original|pollock/);
});
it.each([true,false])('controls require same authenticated origin and same verified conversation or owner principal (private=%s)',async privateWork=>{
 const f=await setup(privateWork);expect(f.call('scheduleSet',input).ok).toBe(true);
 const original=f.proof!,before=f.snapshot();
 for(const proof of [undefined,{...original,conversation:'cv-other'},{...original,agent:'fish'}, {...original,member:'other'}, {...original,project:'pond'}]){
  f.proof=proof;
  for(const [op,data] of [['scheduleSet',{...input,prompt:'FORGED'}],['scheduleRun',{id:input.id}],['scheduleRemove',{id:input.id}],['cancel',{id:wakes(f.app.db)[0].id}]] as const)expect(f.call(op,data).ok,op).toBe(false);
  expect(f.snapshot()).toEqual(before);
 }
 f.proof=original;
 expect(f.call('scheduleRun',{id:input.id},{...body}).ok).toBe(false);
 expect(f.call('scheduleRun',{id:input.id}).ok).toBe(true);
 const run=wakes(f.app.db).find(w=>w.runNow)!;expect(run.authorship?.conversation).toBe('cv-original');
 f.proof={...original,conversation:'cv-owner',principal:{for:'owner',people:['jonathan']}};
 expect(f.call('scheduleRun',{id:input.id}).ok).toBe(true);
 expect(wakes(f.app.db).filter(w=>w.runNow).find(w=>w.id!==run.id)?.authorship).toMatchObject({conversation:'cv-owner',principal:{for:'pollock',people:['jonathan','pollock']}});
 expect(f.call('cancel',{id:run.id}).ok).toBe(true);
 expect(f.call('scheduleRemove',{id:input.id}).ok).toBe(true);
});
it('never makes owner-created or historical no-origin work body-mutable, even with fresh owner steering',async()=>{
 const f=await setup(false);expect(f.call('scheduleSet',input,owner).ok).toBe(true);
 f.proof={...f.proof!,principal:{for:'owner',people:['jonathan']}};
 const before=f.snapshot();
 for(const [op,data] of [['scheduleSet',input],['scheduleRun',{id:input.id}],['scheduleRemove',{id:input.id}],['cancel',{id:wakes(f.app.db)[0].id}]] as const)expect(f.call(op,data).ok).toBe(false);
 expect(f.snapshot()).toEqual(before);
});
it('checks current central policy and fresh binding before replaying private mutation acknowledgements',async()=>{
 const f=await setup();expect(f.call('scheduleSet',input).ok).toBe(true);
 const id=randomUUID(),data={id:input.id},ack=f.call('scheduleRun',data,body,id);expect(ack.ok).toBe(true);
 expect(f.call('scheduleRun',data,body,id)).toEqual(ack);
 f.access.members.jonathan.agents=[];expect(f.call('scheduleRun',data,body,id)).toMatchObject({ok:false,code:'denied'});
 f.access.members.jonathan.agents=['art'];f.proof={...f.proof!,conversation:'cv-other',principal:{for:'owner',people:['jonathan']}};
 expect(f.call('scheduleRun',data,body,id)).toMatchObject({ok:false,code:'conflict'});
 f.proof=undefined;expect(f.call('scheduleRun',data,body,id).ok).toBe(false);
});
it('private command creation, replace, run, cancel and removal share replay authorization without private list reads',async()=>{
 const f=await setup(),id=randomUUID(),data={argv:['schedule','set','daily','--at','13:17','-p','PRIVATE_COMMAND']};
 const ack=f.call('command',data,body,id);expect(ack).toMatchObject({ok:true,value:{exit:0}});expect(JSON.stringify(ack)).not.toContain('PRIVATE_');
 expect(f.call('command',data,body,id)).toEqual(ack);
 expect(f.call('command',{argv:['schedule','run','daily']})).toMatchObject({ok:true,value:{exit:0}});
 const run=wakes(f.app.db).find(w=>w.runNow)!;
 expect(f.call('command',{argv:['cancel',run.id]})).toMatchObject({ok:true,value:{exit:0,stdout:`cancelled ${run.id}\n`}});
 const original=f.proof!;f.proof={...original,conversation:'cv-other'};expect(f.call('command',data,body,id)).toMatchObject({ok:false,code:'denied'});
 f.proof=original;f.access.members.jonathan.agents=[];expect(f.call('command',data,body,id)).toMatchObject({ok:false,code:'denied'});
 f.access.members.jonathan.agents=['art'];expect(f.call('command',{argv:['schedule','rm','daily']})).toMatchObject({ok:true,value:{exit:0}});
 expect(f.call('command',data,body,id)).toMatchObject({ok:false,code:'denied'});
 expect(f.call('scheduleSet',input,body,id).ok).toBe(false);
 expect(JSON.stringify(exportDatabase(f.app.db))).not.toContain('PRIVATE_');
});

it('private ids and deleted private receipts never become token-readable, including explicit member input',async()=>{
 const f=await setup(),receipt=randomUUID(),original=f.call('scheduleSet',{...input,member:'jonathan'},body,receipt);
 expect(original.ok).toBe(true);
 const removeId=randomUUID();expect(f.call('scheduleRemove',{id:input.id},body,removeId).ok).toBe(true);
 expect(f.call('scheduleSet',{...input,member:'jonathan'},body,receipt).ok).toBe(false);
 expect(f.call('scheduleRemove',{id:input.id},body,removeId).ok).toBe(false);
 for(const v of [owner,{kind:'member',id:'other'}] as Viewer[])expect(f.call('scheduleSet',{...input,member:'jonathan'},v,receipt)).toMatchObject({ok:false,code:'denied'});
 expect(schedules(f.app.db)).toEqual([]);
});
it('does not authorize control from capacity, saved by, archive or historical missing authorship',async()=>{
 const f=await setup(false);expect(f.call('scheduleSet',input).ok).toBe(true);
 const saved=schedules(f.app.db)[0];delete saved.authorship;
 f.app.db.prepare('UPDATE clock_schedules SET record=? WHERE id=?').run(JSON.stringify({...saved,legacy:{origin:'art',for_in:'cv-original',for:'owner'}}),saved.id);
 f.proof={...f.proof!,principal:{for:'owner',people:['jonathan']}};
 for(const op of ['scheduleSet','scheduleRun','scheduleRemove'])expect(f.call(op,op==='scheduleSet'?input:{id:input.id}).ok).toBe(false);
});
it('retains public command names for noncanonical public schedule ids',async()=>{
 const f=await setup(false);expect(f.call('scheduleSet',{...input,id:'daily'}).ok).toBe(true);
 expect(f.call('command',{argv:['schedule','set','daily','--at','13:17','-p','Replacement']})).toMatchObject({ok:true,value:{exit:0}});
 expect(schedules(f.app.db)).toHaveLength(1);expect(schedules(f.app.db)[0].id).toBe('daily');
 expect(f.call('command',{argv:['schedule','run','daily']})).toMatchObject({ok:true,value:{exit:0}});
});

it('preserves a positive verified private project through replacement and each occurrence',async()=>{
 const f=await setup();f.proof={...f.proof!,project:'pond'};
 expect(f.call('scheduleSet',input).ok).toBe(true);
 expect(schedules(f.app.db)[0]).toMatchObject({member:'jonathan',project:'pond',authorship:{member:'jonathan',project:'pond'}});
 expect(wakes(f.app.db).every(w=>w.member==='jonathan' && w.project==='pond' && w.authorship?.project==='pond')).toBe(true);
 expect(f.call('scheduleSet',{...input,prompt:'PRIVATE_PROJECT_EDIT'}).ok).toBe(true);
 expect(schedules(f.app.db)[0]).toMatchObject({member:'jonathan',project:'pond',authorship:{project:'pond'}});
 expect(wakes(f.app.db).filter(w=>w.state==='pending')).toHaveLength(1);
 expect(wakes(f.app.db).filter(w=>w.state==='pending')[0]).toMatchObject({member:'jonathan',project:'pond',authorship:{project:'pond'}});
});
it.each(['direct','command'])('binds %s control receipt replay to a service-only proof change',async door=>{
 const f=await setup();f.proof={...f.proof!,service:'bridge'};
 const id=randomUUID(),op=door==='direct'?'scheduleSet':'command',data=door==='direct'?input:{argv:['schedule','set','daily','--at','13:17','-p','PRIVATE_SERVICE']};
 const original=f.call(op,data,body,id);expect(original).toMatchObject({ok:true});
 expect(f.call(op,data,body,id)).toEqual(original);
 const before=f.snapshot();f.proof={...f.proof!,service:'other-bridge'};
 expect(f.call(op,data,body,id)).toMatchObject({ok:false,code:'conflict'});expect(f.snapshot()).toEqual(before);
});
it('a colliding public wake cannot waive a removed private schedule id window guard',async()=>{
 const f=await setup(false),publicProof=f.proof!;
 expect(f.call('in',{agent:'art',when:'1h',prompt:'Public',note:''}).ok).toBe(true);
 const id=wakes(f.app.db)[0].id;
 f.proof={...publicProof,member:'jonathan'};
 expect(f.call('scheduleSet',{...input,id}).ok).toBe(true);
 expect(await f.app.operations.callAsync('socket',owner,'clock.scheduleRemove',{id},randomUUID(),true)).toMatchObject({ok:true});
 f.proof=publicProof;const before=f.snapshot();
 expect(f.call('scheduleSet',{...input,id})).toMatchObject({ok:false,code:'denied'});
 expect(f.snapshot()).toEqual(before);
});

it.each([true,false])('keeps body cancel commands on the selected clock and active entries (private=%s)',async privateWork=>{
 const f=await setup(privateWork);expect(f.call('in',{agent:'art',when:'1h',prompt:'WORDS',note:''}).ok).toBe(true);
 const id=wakes(f.app.db)[0].id,before=f.snapshot();
 expect(f.call('command',{argv:['--agent','other','cancel',id]})).toMatchObject({ok:true,value:{exit:1,stderr:`wake: no spool entry ${id}\n`}});
 expect(f.snapshot()).toEqual(before);
 expect(f.call('command',{argv:['cancel',id]})).toMatchObject({ok:true,value:{exit:0,stdout:`cancelled ${id}\n`}});
 expect(f.call('command',{argv:['cancel',id]})).toMatchObject({ok:true,value:{exit:1,stderr:`wake: no spool entry ${id}\n`}});
});

it('resolves authorized noncanonical private schedule names for replace, run and remove without returning words',async()=>{
 const f=await setup();expect(f.call('scheduleSet',{...input,id:'daily'}).ok).toBe(true);
 for(const argv of [['schedule','set','daily','--at','13:17','-p','PRIVATE_REPLACEMENT'],['schedule','run','daily'],['schedule','rm','daily']]){
  const result=f.call('command',{argv});expect(result).toMatchObject({ok:true,value:{exit:0}});expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  if(argv[1]==='set'){expect(schedules(f.app.db)).toHaveLength(1);expect(schedules(f.app.db)[0]).toMatchObject({id:'daily',member:'jonathan',prompt:'PRIVATE_REPLACEMENT'});}
  if(argv[1]==='run')expect(wakes(f.app.db).find(w=>w.runNow)).toMatchObject({member:'jonathan',prompt:'PRIVATE_REPLACEMENT'});
 }
 expect(schedules(f.app.db)).toEqual([]);
});
it.each(['direct','command'])('reauthorizes public body cancellation receipt replay through %s',async door=>{
 const f=await setup(false);f.proof={...f.proof!,project:'pond',service:'bridge'};
 expect(f.call('in',{agent:'art',when:'1h',prompt:'Public',note:''}).ok).toBe(true);
 const id=wakes(f.app.db)[0].id,receipt=randomUUID(),op=door==='direct'?'cancel':'command',data=door==='direct'?{id}:{argv:['cancel',id]};
 const originalProof=f.proof!,ack=f.call(op,data,body,receipt);expect(ack).toMatchObject({ok:true});expect(f.call(op,data,body,receipt)).toEqual(ack);
 const before=f.snapshot();
 f.proof={...originalProof,service:'other'};expect(f.call(op,data,body,receipt)).toMatchObject({ok:false,code:'conflict'});
 f.proof={...originalProof,conversation:'cv-owner',principal:{for:'owner',people:['jonathan']}};expect(f.call(op,data,body,receipt)).toMatchObject({ok:false,code:'conflict'});
 f.proof=undefined;expect(f.call(op,data,body,receipt)).toMatchObject({ok:false,code:'denied'});
 f.proof=originalProof;f.access.projects.pond.agents=[];expect(f.call(op,data,body,receipt)).toMatchObject({ok:false,code:'denied'});
 expect(f.snapshot()).toEqual(before);
});

it('does not replay a deleted private noncanonical acknowledgement against a different schedule with the same name',async()=>{
 const f=await setup();expect(f.call('scheduleSet',{...input,id:'daily'}).ok).toBe(true);
 const receipt=randomUUID(),data={argv:['schedule','set','daily','--at','13:17','-p','PRIVATE_FIRST']};
 const ack=f.call('command',data,body,receipt);expect(ack).toMatchObject({ok:true,value:{exit:0}});
 expect(f.call('scheduleRemove',{id:'daily'}).ok).toBe(true);
 expect(f.call('scheduleSet',input).ok).toBe(true);
 const before=f.snapshot();expect(f.call('command',data,body,receipt)).toMatchObject({ok:false,code:'conflict'});expect(f.snapshot()).toEqual(before);
});

it.each([true,false])('suppresses an agent-authored file rearm only for its current exact principal and binding (private=%s)',async privateWork=>{
 const f=await setup(privateWork),scheduleInput={...input,prompt:undefined,file:'routines/rearm.md'};
 expect(f.call('scheduleSet',scheduleInput).ok).toBe(true);
 const occurrence=wakes(f.app.db)[0],request={agent:'art',file:scheduleInput.file,note:'rearm',when:`${(occurrence.due-f.app.operations.clock.now())/1000}s`};
 const count=()=>wakes(f.app.db).length,original=f.proof!,before=count();
 const receipt=randomUUID(),suppressed=f.call('in',request,body,receipt);expect(suppressed).toEqual({ok:true,value:{alreadyScheduled:true,schedule:input.id,due:occurrence.due}});
 expect(count()).toBe(before);expect(JSON.stringify(suppressed)).not.toMatch(/PRIVATE_|pollock|cv-original|member|authorship/);
 f.proof={...original,principal:{for:'owner',people:['jonathan']}};
 expect(f.call('in',request,body,receipt)).toMatchObject({ok:false,code:'conflict'});
 expect(count()).toBe(before);f.proof=original;
 for(const proof of [{...original,conversation:'cv-other'},{...original,service:'other-service'},
  {...original,principal:{for:'owner',people:['jonathan']}},{...original,principal:{for:'?',people:['pollock']}}]){
  f.proof=proof;expect(f.call('in',request)).toMatchObject({ok:true,value:{state:'pending'}});
 }
 f.proof=original;
 expect(f.call('in',request,{...body})).toMatchObject({ok:true,value:{state:'pending'}});
 const saved=schedules(f.app.db)[0];delete saved.authorship;
 f.app.db.prepare('UPDATE clock_schedules SET record=? WHERE id=?').run(JSON.stringify(saved),saved.id);
 expect(f.call('in',request)).toMatchObject({ok:true,value:{state:'pending'}});
 const partial={...saved,authorship:{origin:'art',conversation:original.conversation}};
 f.app.db.prepare('UPDATE clock_schedules SET record=? WHERE id=?').run(JSON.stringify(partial),saved.id);
 expect(f.call('in',request)).toMatchObject({ok:true,value:{state:'pending'}});
});

it.each([true,false])('exports only public suppression acknowledgements (private=%s)',async privateWork=>{
 const f=await setup(privateWork),scheduleInput={...input,prompt:undefined,file:'routines/private-rearm.md'};
 expect(f.call('scheduleSet',scheduleInput).ok).toBe(true);
 const occurrence=wakes(f.app.db)[0],request={agent:'art',file:scheduleInput.file,note:'rearm',when:`${(occurrence.due-f.app.operations.clock.now())/1000}s`},receipt=randomUUID();
 const answer=f.call('in',request,body,receipt);expect(answer).toMatchObject({ok:true,value:{alreadyScheduled:true}});
 expect(f.call('in',request,body,receipt)).toEqual(answer);
 expect(f.app.db.prepare('SELECT id FROM core_operations WHERE id=?').get(receipt)).toEqual({id:receipt});
 const snapshot=exportDatabase(f.app.db),receipts=snapshot.find(table=>table.name==='core_operations')!.rows;
 expect(receipts.some(row=>row.id===receipt)).toBe(!privateWork);
 f.proof=undefined;expect(f.call('in',request,body,receipt).ok).toBe(false);
});

it.each(['owner','?'])('uses exact %s steering with the legacy conversation-or-owner control rule',async principal=>{
 const f=await setup(false);f.proof={...f.proof!,principal:{for:principal,people:principal==='owner'?['jonathan']:['pollock']}};
 const original=f.proof!,scheduleInput={...input,prompt:undefined,file:'routines/steering.md'};
 expect(f.call('scheduleSet',scheduleInput).ok).toBe(true);
 const occurrence=wakes(f.app.db)[0],request={agent:'art',file:scheduleInput.file,note:'rearm',when:`${(occurrence.due-f.app.operations.clock.now())/1000}s`};
 expect(f.call('in',request)).toMatchObject({ok:true,value:{alreadyScheduled:true}});
 f.proof={...original,conversation:'cv-other'};
 expect(f.call('in',request)).toMatchObject({ok:true,value:principal==='owner'?{alreadyScheduled:true}:{state:'pending'}});
});
