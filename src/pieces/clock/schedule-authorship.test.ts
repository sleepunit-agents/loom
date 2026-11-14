import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { startLoom } from '../../foundation.js';
import { FakeClock, exportDatabase, type Viewer, type Sharing } from '../../core/index.js';
import type { ClockProvenance } from '../runtime/role.js';
import { installClock } from './index.js';
import { schedules, wakes } from './store.js';
import { narrowPrincipal, replacementAuthorship, runAuthorship } from './authorship.js';
const clean: Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
const owner:Viewer={kind:'member',id:'jonathan'}, person:Viewer={kind:'member',id:'pollock'}, body:Viewer={kind:'agent',id:'art'};
const input={id:'daily',agent:'art',at:'13:17',prompt:'SAVED_WORDS',note:'SAVED_NOTE'};
async function setup(){
 const home=mkdtempSync(join(tmpdir(),'clock-schedule-authorship-'));clean.push(()=>rmSync(home,{recursive:true,force:true}));
 const clock=new FakeClock();
 const access:Sharing={members:{jonathan:{owner:true,agents:['art']},pollock:{owner:false,agents:['art']},other:{owner:false,agents:['art']}},projects:{},services:{}};
 let proof:ClockProvenance|undefined;
 const open=async()=>{
  const app=await startLoom({home,clock,authenticate:()=>({viewer:owner,valid:()=>true}),install(app){const jobs=installClock(app.db,app.operations,app.live,()=>access,{provenance:v=>v===body?proof:undefined});app.onClose(jobs.close);}});
  let closed=false;const close=app.close;app.close=async()=>{if(!closed){closed=true;await close();}};clean.push(app.close);return app;
 };
 const app=await open();
 const call=(op:string,data:object,viewer=owner,id=randomUUID())=>app.operations.call('direct',viewer,'clock.'+op,data,id);
 return {app,open,clock,access,call,set proof(p:ClockProvenance|undefined){proof=p;}};
}
it.each([
 ['owner','owner','owner'],['owner','pollock','pollock'],['pollock','owner','pollock'],['pollock','pollock','pollock'],
 ['pollock','other','?'],['?','owner','?'],['owner','?','?'],['?','pollock','?'],
])('meets %s and %s without losing named steering', (a,b,result)=>{
 expect(narrowPrincipal({for:a,people:['saved']},{for:b,people:['caller','saved']})).toEqual({for:result,people:['caller','saved']});
});
it('never infers a historical original from a fresh owner, and preserves only justified conversations',()=>{
 const caller={origin:'art',conversation:'cv-new',principal:{for:'owner',people:['jonathan']}};
 expect(replacementAuthorship(undefined,caller)).toEqual({origin:'art',principal:{for:'?',people:['jonathan']}});
 const original={...caller,conversation:'cv-old',principal:{for:'pollock',people:['pollock']}};
 expect(replacementAuthorship(original,caller).conversation).toBeUndefined();
 expect(replacementAuthorship(original,{...caller,conversation:'cv-old'}).conversation).toBe('cv-old');
 expect(runAuthorship(original,caller)).toMatchObject({conversation:'cv-new',principal:{for:'pollock'}});
 expect(runAuthorship(original,{principal:{for:'owner',people:['jonathan']}})).toMatchObject({conversation:'cv-old',principal:{for:'pollock'}});
});
it('persists original schedule principal in occurrences and narrows owner edits and runs across restart',async()=>{
 const f=await setup(), setId=randomUUID(), created=f.call('scheduleSet',input,person,setId);expect(created).toMatchObject({ok:true});
 expect((created as {value:object}).value).not.toHaveProperty('authorship');expect(f.call('scheduleSet',input,person,setId)).toEqual(created);
 expect(schedules(f.app.db)[0].authorship).toEqual({principal:{for:'pollock',people:['pollock']}});
 expect(wakes(f.app.db)[0].authorship).toEqual(schedules(f.app.db)[0].authorship);
 expect(f.call('scheduleSet',{...input,prompt:'Changed by owner'})).toMatchObject({ok:true});
 const saved=schedules(f.app.db)[0];expect(saved.authorship).toEqual({principal:{for:'pollock',people:['jonathan','pollock']}});
 const runId=randomUUID(), ran=f.call('scheduleRun',{id:input.id},owner,runId);expect(ran).toMatchObject({ok:true});
 expect((ran as {value:object}).value).not.toHaveProperty('authorship');expect(f.call('scheduleRun',{id:input.id},owner,runId)).toEqual(ran);
 expect(wakes(f.app.db).find(w=>w.runNow)?.authorship).toEqual(saved.authorship);
 expect(JSON.stringify(f.call('schedules',{}))).not.toContain('authorship');
 await f.app.close();const again=await f.open();expect(schedules(again.db)[0].authorship).toEqual(saved.authorship);
 const next=wakes(again.db).filter(w=>w.state==='pending'&&!w.runNow);expect(next).toHaveLength(1);expect(next[0].authorship).toEqual(saved.authorship);
});
it('different named editors meet to unknown; a later owner cannot promote them',async()=>{
 const f=await setup();expect(f.call('scheduleSet',input,person).ok).toBe(true);
 expect(f.call('scheduleSet',input,{kind:'member',id:'other'}).ok).toBe(true);
 expect(f.call('scheduleSet',input).ok).toBe(true);
 expect(schedules(f.app.db)[0].authorship).toEqual({principal:{for:'?',people:['jonathan','other','pollock']}});
});
it('unbound schedules stay unknown and historical rows are never backfilled from saved by or archive',async()=>{
 const f=await setup();expect(f.call('scheduleSet',input,body).ok).toBe(true);
 expect(schedules(f.app.db)[0].authorship).toEqual({origin:'art',principal:{for:'?',people:[]}});
 const s=schedules(f.app.db)[0];delete s.authorship;
 f.app.db.prepare('UPDATE clock_schedules SET record=? WHERE id=?').run(JSON.stringify({...s,by:owner,legacy:{for:'owner'}}),s.id);
 expect(f.call('scheduleRun',{id:s.id}).ok).toBe(true);expect(wakes(f.app.db).find(w=>w.runNow)?.authorship?.principal.for).toBe('?');
 expect(f.call('scheduleSet',input).ok).toBe(true);expect(schedules(f.app.db)[0].authorship?.principal.for).toBe('?');
});
it('refuses private body schedules without flattening their member or writing public words, including command path',async()=>{
 const f=await setup();f.proof={agent:'art',conversation:'cv-bound',member:'jonathan',principal:{for:'owner',people:['jonathan']}};
 expect(f.call('scheduleSet',input,body)).toMatchObject({ok:false,code:'denied'});
 expect(f.call('command',{agent:'art',argv:['schedule','set','daily','--at','13:17','-p','SAVED_WORDS']},body)).toMatchObject({ok:true,value:{exit:1}});
 expect(schedules(f.app.db)).toEqual([]);expect(wakes(f.app.db)).toEqual([]);
});
it.each([false,true])('private schedule receipts stay private after removal (historical marker absent: %s)',async historical=>{
 const f=await setup(),id=randomUUID();
 const windowCall=(op:string,data:object,receipt=randomUUID())=>f.app.operations.callAsync('socket',owner,'clock.'+op,data,receipt,true);
 expect(await windowCall('scheduleSet',{...input,member:'jonathan'})).toMatchObject({ok:true});
 if(historical)f.app.db.prepare('DELETE FROM clock_meta WHERE key=?').run('private-id:'+input.id);
 expect(await windowCall('scheduleRun',{id:input.id},id)).toMatchObject({ok:true});
 expect(await windowCall('scheduleRemove',{id:input.id})).toMatchObject({ok:true});
 expect(f.call('scheduleRun',{id:input.id},owner,id)).toMatchObject({ok:false,code:'denied'});
 expect(JSON.stringify(exportDatabase(f.app.db))).not.toMatch(/SAVED_WORDS|SAVED_NOTE/);
 expect(JSON.stringify(f.call('schedules',{}))).not.toMatch(/SAVED_WORDS|authorship/);
});

it('redacts saved authorship from schedule and wake Live snapshots and updates',async()=>{
 const f=await setup();expect(f.call('scheduleSet',input,person).ok).toBe(true);
 const ws=new WebSocket(f.app.url.replace('http:','ws:')+'/live');await once(ws,'open');
 try {
  for(const type of ['schedule','wake']){
   const frame=once(ws,'message');ws.send(JSON.stringify({kind:'subscribe',type}));const [raw]=await frame;
   const data=JSON.parse(raw.toString());expect(data.records).toHaveLength(1);expect(data.records[0].prompt).toBe('SAVED_WORDS');
   expect(data.records[0]).not.toHaveProperty('authorship');
  }
  const messages:unknown[]=[];ws.on('message',raw=>messages.push(JSON.parse(raw.toString())));
  const changed=once(ws,'message');expect(f.call('scheduleSet',{...input,prompt:'UPDATED_WORDS'}).ok).toBe(true);await changed;
  // The schedule update is published after cancelled and new wake records.
  const snapshot=once(ws,'message');ws.send(JSON.stringify({kind:'subscribe',type:'schedule'}));await snapshot;
  expect(JSON.stringify(messages)).toContain('UPDATED_WORDS');expect(JSON.stringify(messages)).not.toContain('authorship');
 }finally{const closed=once(ws,'close');ws.terminate();await closed;}
});

it('refuses otherwise-authorized project and member scope changes without changing schedule or occurrences',async()=>{
 const f=await setup();f.access.projects.pond={members:['jonathan'],agents:['art']};
 expect(f.call('scheduleSet',input).ok).toBe(true);
 const before={s:schedules(f.app.db),w:wakes(f.app.db),events:f.app.db.prepare('SELECT * FROM clock_events').all()};
 for(const changed of [{project:'pond'},{member:'jonathan'}]){
  expect(await f.app.operations.callAsync('socket',owner,'clock.scheduleSet',{...input,...changed},randomUUID(),true)).toMatchObject({ok:false,code:'invalid'});
  expect({s:schedules(f.app.db),w:wakes(f.app.db),events:f.app.db.prepare('SELECT * FROM clock_events').all()}).toEqual(before);
 }
});
it('copies saved narrowed authorship into the next occurrence created by dispatch',async()=>{
 const f=await setup();expect(f.call('scheduleSet',input,person).ok).toBe(true);expect(f.call('scheduleSet',input).ok).toBe(true);
 const original=wakes(f.app.db).find(w=>w.state==='pending')!, saved=schedules(f.app.db)[0].authorship;
 await f.clock.advance(original.due-f.clock.now());
 for(let n=0;n<6;n++)await Promise.resolve();
 const next=wakes(f.app.db).find(w=>w.schedule===input.id&&w.due>original.due);
 expect(next).toBeDefined();expect(next!.authorship).toEqual(saved);
 expect(next!.authorship!.principal).toEqual({for:'pollock',people:['jonathan','pollock']});
});
