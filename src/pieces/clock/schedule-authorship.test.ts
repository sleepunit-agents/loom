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
import { installClock, type ClockOptions } from './index.js';
import { schedules, wakes } from './store.js';
import { narrowPrincipal, replacementAuthorship, runAuthorship } from './authorship.js';
const clean: Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
const owner:Viewer={kind:'member',id:'jonathan'}, person:Viewer={kind:'member',id:'pollock'}, body:Viewer={kind:'agent',id:'art'};
const input={id:'daily',agent:'art',at:'13:17',prompt:'SAVED_WORDS',note:'SAVED_NOTE'};
async function setup(options:ClockOptions={}){
 const home=mkdtempSync(join(tmpdir(),'clock-schedule-authorship-'));clean.push(()=>rmSync(home,{recursive:true,force:true}));
 const clock=new FakeClock();
 const access:Sharing={members:{jonathan:{owner:true,agents:['art']},pollock:{owner:false,agents:['art']},other:{owner:false,agents:['art']}},projects:{},services:{}};
 let proof:ClockProvenance|undefined;
 const open=async()=>{
  const app=await startLoom({home,clock,authenticate:()=>({viewer:owner,valid:()=>true}),install(app){const jobs=installClock(app.db,app.operations,app.live,()=>access,{...options,provenance:v=>v===body?proof:undefined});app.onClose(jobs.close);}});
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
it('preserves private body schedule scope and returns only acknowledgements, including command path',async()=>{
 const f=await setup();f.proof={agent:'art',conversation:'cv-bound',member:'jonathan',principal:{for:'owner',people:['jonathan']}};
 expect(f.call('scheduleSet',input,body)).toMatchObject({ok:true,value:{private:true}});
 expect(f.call('command',{agent:'art',argv:['schedule','set','daily','--at','13:17','-p','SAVED_WORDS']},body)).toMatchObject({ok:true,value:{exit:0}});
 expect(schedules(f.app.db)).toHaveLength(1);expect(schedules(f.app.db).every(s=>s.member==='jonathan')).toBe(true);
 expect(JSON.stringify(f.call('schedules',{},body))).not.toContain('SAVED_WORDS');
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

it('run-now adds a newly participating owner without changing the saved schedule steering',async()=>{
 const f=await setup();expect(f.call('scheduleSet',input,person).ok).toBe(true);
 const saved=schedules(f.app.db)[0];expect(saved.authorship!.principal.people).toEqual(['pollock']);
 expect(f.call('scheduleRun',{id:input.id}).ok).toBe(true);
 expect(wakes(f.app.db).find(w=>w.runNow)?.authorship!.principal).toEqual({for:'pollock',people:['jonathan','pollock']});
 expect(schedules(f.app.db)[0]).toEqual(saved);
});


it('captures household lane authorship and retains it through edits, reassignment, run-now and restart',async()=>{
 const f=await setup();f.access.members.second={owner:true,agents:['art','other']};f.access.members.third={owner:true,agents:['art','other']};f.access.members.jonathan.agents.push('other');
 const lane={name:'night',agent:'art',at:'13:17',text:'LANE_WORDS',note:'LANE_NOTE'};
 const first=f.call('laneSet',lane);expect(first).toMatchObject({ok:true});
 const original={principal:{for:'owner',people:['jonathan']}};
 expect(schedules(f.app.db)[0].authorship).toEqual(original);expect(wakes(f.app.db)[0].authorship).toEqual(original);
 expect((first as {value:object}).value).not.toHaveProperty('authorship');
 expect(f.call('laneSet',{name:lane.name,text:'EDITED_WORDS'},{kind:'member',id:'second'}).ok).toBe(true);
 expect(f.call('laneAssign',{name:lane.name,agent:'other'},{kind:'member',id:'third'}).ok).toBe(true);
 const saved=schedules(f.app.db)[0];expect(saved.agent).toBe('other');
 expect(saved.authorship).toEqual({principal:{for:'owner',people:['jonathan','second','third']}});
 expect(wakes(f.app.db).filter(w=>w.state==='pending')).toHaveLength(1);
 expect(wakes(f.app.db).find(w=>w.state==='pending')).toMatchObject({agent:'other',authorship:saved.authorship});
 const run=f.call('scheduleRun',{id:saved.id});expect(run.ok).toBe(true);expect((run as {value:object}).value).not.toHaveProperty('authorship');
 expect(wakes(f.app.db).find(w=>w.runNow)?.authorship).toEqual(saved.authorship);
 expect(JSON.stringify(f.call('lanes',{}))).not.toContain('authorship');
 expect(JSON.stringify(f.call('command',{agent:'other',argv:['lane','list']}))).not.toContain('authorship');
 await f.app.close();const again=await f.open();expect(schedules(again.db)[0].authorship).toEqual(saved.authorship);
 expect(wakes(again.db).filter(w=>w.state==='pending').every(w=>JSON.stringify(w.authorship)===JSON.stringify(saved.authorship))).toBe(true);
});
it('keeps historical lane steering unknown on edit and reassignment, without relaxing household administration',async()=>{
 const f=await setup();f.access.members.jonathan.agents.push('other');
 expect(f.call('laneSet',{name:'night',agent:'art',at:'13:17',text:'LANE_WORDS'}).ok).toBe(true);
 const lane=schedules(f.app.db)[0];delete lane.authorship;
 f.app.db.prepare('UPDATE clock_schedules SET record=? WHERE id=?').run(JSON.stringify({...lane,legacy:{for:'owner'},by:owner}),lane.id);
 expect(f.call('laneSet',{name:'night',text:'EDITED_WORDS'}).ok).toBe(true);
 expect(f.call('laneAssign',{name:'night',agent:'other'}).ok).toBe(true);
 expect(schedules(f.app.db)[0].authorship).toEqual({principal:{for:'?',people:['jonathan']}});
 const before=JSON.stringify(schedules(f.app.db)),events=f.app.db.prepare('SELECT * FROM clock_events').all();
 f.proof={agent:'art',conversation:'cv-bound',member:'jonathan',principal:{for:'owner',people:['jonathan']}};
 for(const viewer of [person,body,{kind:'service',id:'clock'} as Viewer]) {
  expect(f.call('laneSet',{name:'night',text:'FORGED'},viewer).ok).toBe(false);
  expect(f.call('laneAssign',{name:'night',agent:'art'},viewer).ok).toBe(false);
  expect(f.call('laneRemove',{name:'night'},viewer).ok).toBe(false);
 }
 expect(JSON.stringify(schedules(f.app.db))).toBe(before);expect(f.app.db.prepare('SELECT * FROM clock_events').all()).toEqual(events);
});

it('retains lane original evidence in the recurrence created by actual dispatch and redacts Live',async()=>{
 let starts=0;const f=await setup({runtime:{async startBody(){starts++;return {state:'started',body:'lane-body'};}}});
 expect(f.call('laneSet',{name:'night',agent:'art',at:'13:17',text:'LANE_WORDS'}).ok).toBe(true);
 const saved=schedules(f.app.db)[0],occurrence=wakes(f.app.db)[0];
 expect(saved.authorship).toEqual({principal:{for:'owner',people:['jonathan']}});
 const ws=new WebSocket(f.app.url.replace('http:','ws:')+'/live');await once(ws,'open');
 try {
  const frame=once(ws,'message');ws.send(JSON.stringify({kind:'subscribe',type:'schedule'}));const [raw]=await frame;
  const records=JSON.parse(raw.toString()).records;expect(records).toHaveLength(1);
  expect(records[0].laneDetails.text).toBe('LANE_WORDS');expect(records[0]).not.toHaveProperty('authorship');
 }finally{ws.close();await once(ws,'close');}
 f.clock.advance(occurrence.due-f.clock.now());
 for(let n=0;n<8;n++)await Promise.resolve();
 expect(starts).toBe(1);expect(wakes(f.app.db).find(w=>w.id===occurrence.id)?.state).toBe('fired');
 const next=wakes(f.app.db).find(w=>w.id!==occurrence.id)!;expect(next).toMatchObject({state:'pending',schedule:saved.id,authorship:saved.authorship});
 expect(next.due).toBeGreaterThan(occurrence.due);
});

it('does not promote a retained named lane original and still requires independent target creation permission',async()=>{
 const f=await setup();expect(f.call('laneSet',{name:'night',agent:'art',at:'13:17',text:'LANE_WORDS'}).ok).toBe(true);
 const lane=schedules(f.app.db)[0];lane.authorship={origin:'art',conversation:'cv-original',principal:{for:'pollock',people:['pollock']}};
 f.app.db.prepare('UPDATE clock_schedules SET record=? WHERE id=?').run(JSON.stringify(lane),lane.id);
 expect(f.call('laneSet',{name:'night',text:'EDITED_WORDS'}).ok).toBe(true);
 expect(schedules(f.app.db)[0].authorship).toEqual({principal:{for:'pollock',people:['jonathan','pollock']}});
 const before={schedules:schedules(f.app.db),wakes:wakes(f.app.db),events:f.app.db.prepare('SELECT * FROM clock_events').all()};
 expect(f.call('laneAssign',{name:'night',agent:'other'})).toMatchObject({ok:false,code:'denied'});
 expect({schedules:schedules(f.app.db),wakes:wakes(f.app.db),events:f.app.db.prepare('SELECT * FROM clock_events').all()}).toEqual(before);
});

it('redacts authored lane lists and cached lane mutation results independently of creation capture',async()=>{
 const f=await setup(),lane={name:'night',agent:'art',at:'13:17',text:'LANE_WORDS'};
 expect(f.call('laneSet',lane).ok).toBe(true);
 const stored=schedules(f.app.db)[0];stored.authorship={principal:{for:'owner',people:['PRIVATE_INTERNAL_NAME']}};
 f.app.db.prepare('UPDATE clock_schedules SET record=? WHERE id=?').run(JSON.stringify(stored),stored.id);
 const listed=f.call('lanes',{});expect(listed).toMatchObject({ok:true,value:[{lane:'night'}]});
 expect(JSON.stringify(listed)).not.toMatch(/authorship|PRIVATE_INTERNAL_NAME/);
 for(const [op,data] of [['laneSet',{name:'night',text:'EDITED_WORDS'}],['laneAssign',{name:'night',agent:'art'}]] as const){
  const receipt=randomUUID(),result=f.call(op,data,owner,receipt);expect(result.ok).toBe(true);
  expect((result as {value:object}).value).not.toHaveProperty('authorship');
  expect(f.call(op,data,owner,receipt)).toEqual(result);
  expect(schedules(f.app.db)[0].authorship?.principal.people).toContain('PRIVATE_INTERNAL_NAME');
 }
});
