import { once } from 'node:events';
import { WebSocket } from 'ws';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Sharing, type Viewer } from '../../core/index.js';
import { installClock } from './index.js';
import { importClock } from './importer.js';
import { schedules, wakes, type Schedule } from './store.js';
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();});
const owner:Viewer={kind:'member',id:'jonathan'};
const input={id:'art/daily',agent:'art',at:'13:17',days:'mon-fri',prompt:'FRESH_WORDS',note:'Fresh owner schedule'};
async function setup(raw:Record<string,unknown>={}) {
 const dir=mkdtempSync(join(tmpdir(),'clock-import-recovery-')); cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
 const from=join(dir,'old');mkdirSync(join(from,'art'),{recursive:true});
 writeFileSync(join(from,'art/schedules.json'),JSON.stringify({daily:{at:'03:47',prompt:'ARCHIVED_WORDS',note:'ARCHIVED_NOTE',for:'owner',...raw}}));
 const clock=new FakeClock(Date.parse('2026-11-14T18:00:00Z'));
 const access:Sharing={members:{jonathan:{owner:true,agents:['art']},pollock:{owner:false,agents:['art']}},projects:{},services:{}};
 const starts:unknown[]=[];
 const open=async(importing=false)=>{
  const app=await startLoom({home:join(dir,'new'),clock,authenticate:req=>({viewer:req.headers['x-fixture-agent']?{kind:'agent',id:'art'}:owner,valid:()=>true}),install(app){
   if(importing)importClock(app.db,from,clock.now());
   const jobs=installClock(app.db,app.operations,app.live,()=>access,{runtime:{async startBody(i){starts.push(i);return {state:'started',body:'fixture-body'};}}});app.onClose(jobs.close);
  }});
  let closed=false;const close=app.close;app.close=async()=>{if(!closed){closed=true;await close();}};cleanup.push(app.close);return app;
 };
 const app=await open(true);
 const call=(name:string,data:object,viewer=owner,receipt=randomUUID())=>app.operations.call('direct',viewer,'clock.'+name,data,receipt);
 return {app,clock,access,starts,open,call};
}
it('recovers a real imported schedule with complete fresh owner words and dispatches only its new occurrence after restart',async()=>{
 const s=await setup();expect(schedules(s.app.db)[0]).toMatchObject({enabled:false,importRecovery:'plain'});expect(wakes(s.app.db)).toEqual([]);
 const receipt=randomUUID(), result=s.call('scheduleRecover',input,owner,receipt);expect(result).toMatchObject({ok:true});
 expect(s.call('scheduleRecover',input,owner,receipt)).toEqual(result);
 const saved=schedules(s.app.db)[0];expect(saved).toMatchObject({by:owner,enabled:true,prompt:'FRESH_WORDS',at:['13:17'],days:'mon-fri',authorship:{principal:{for:'owner',people:['jonathan']}}});
 expect(saved).not.toHaveProperty('importRecovery');expect(JSON.stringify(saved)).not.toContain('ARCHIVED');
 const occurrence=wakes(s.app.db)[0];expect(wakes(s.app.db)).toHaveLength(1);expect(occurrence.authorship).toEqual(saved.authorship);
 await s.app.close();const app=await s.open();expect(schedules(app.db)[0]).toEqual(saved);expect(wakes(app.db)).toHaveLength(1);
 s.clock.advance(occurrence.due-s.clock.now());for(let n=0;n<20;n++)await Promise.resolve();
 expect(s.starts).toHaveLength(1);expect(s.starts[0]).toMatchObject({viewer:owner,wake:{prompt:'FRESH_WORDS',authorship:saved.authorship}});
 expect(app.operations.call('direct',owner,'clock.scheduleRecover',input,randomUUID()).ok).toBe(false);
});
it('requires the current owner and current agent give-work, including receipt replay',async()=>{
 const s=await setup(), before=schedules(s.app.db);
 for(const viewer of [{kind:'agent',id:'art'},{kind:'member',id:'pollock'},{kind:'service',id:'clock'}] as Viewer[])
  expect(s.call('scheduleRecover',input,viewer)).toMatchObject({ok:false,code:'denied'});
 expect(schedules(s.app.db)).toEqual(before);
 const receipt=randomUUID();expect(s.call('scheduleRecover',input,owner,receipt).ok).toBe(true);
 s.access.members.jonathan.owner=false;expect(s.call('scheduleRecover',input,owner,receipt)).toMatchObject({ok:false,code:'denied'});
 s.access.members.jonathan.owner=true;s.access.members.jonathan.agents=[];
 expect(s.call('scheduleRecover',input,owner,receipt)).toMatchObject({ok:false,code:'denied'});
});
it('keeps ordinary replacement unknown, rather than silently adopting archived steering',async()=>{
 const s=await setup();expect(s.call('scheduleSet',input).ok).toBe(true);
 expect(schedules(s.app.db)[0].authorship?.principal.for).toBe('?');
 expect(s.call('scheduleRecover',input)).toMatchObject({ok:false,code:'invalid'});
});
it.each([{state:'held',hold:'uncertain'},{state:'firing',hold:undefined},{state:'held',hold:'provenance',attempt:'old-attempt'}])('refuses unsafe linked import %j and cancels only definitely unstarted work',async unsafe=>{
 const s=await setup(),id='w-111111';
 const row={id,agent:'art',note:'archived occurrence',prompt:'ARCHIVED_WORDS',schedule:input.id,due:s.clock.now(),createdAt:s.clock.now(),changedAt:s.clock.now(),by:{kind:'runner',id:'clock-import:unverified'},failures:0,...unsafe};
 s.app.db.prepare('INSERT INTO clock_wakes VALUES (?,?,?)').run(id,JSON.stringify(row),s.clock.now());
 const before=schedules(s.app.db);expect(s.call('scheduleRecover',input)).toMatchObject({ok:false,code:'invalid'});
 expect(schedules(s.app.db)).toEqual(before);expect(wakes(s.app.db)).toEqual([JSON.parse(JSON.stringify(row))]);
 const {attempt:_attempt,...unstarted}=row;
 s.app.db.prepare('UPDATE clock_wakes SET record=? WHERE id=?').run(JSON.stringify({...unstarted,state:'held',hold:'provenance'}),id);
 expect(s.call('scheduleRecover',input).ok).toBe(true);
 expect(wakes(s.app.db).find(w=>w.id===id)).toMatchObject({state:'cancelled'});
 expect(wakes(s.app.db).filter(w=>w.state==='pending')).toHaveLength(1);
});
it.each([{credential:'fixture-saved-token'},{private:true},{future_capability:false},{note:42},{days:42},{prompt:undefined,prompt_file:'routines/night.md'},{origin:'person:pollock'},{origin:'agent:other'},{for:'person:pollock'},{for_why:'steered'},{for_why:'unverified'},{for_why:'other-agent'},{authorship:{principal:{for:'pollock'}}},{principal:{for:'pollock'}},{conversation:'old'},{service:'old'},{member:'jonathan'},{project:'pond'},{for_people:['pollock']},{lane:'daily'},
 {model:'saved'},{slot:'saved'},{continuation:'saved'},{approval:'saved'},{place:'saved'},{standing:true},
 {prompt:'<!-- house: local -->\nlocal words'},{_firing:true}])('does not recover archived capability or private/person hints: %j',async raw=>{
 const s=await setup(raw),before=schedules(s.app.db);
 expect(s.call('scheduleRecover',input)).toMatchObject({ok:false,code:'invalid'});expect(schedules(s.app.db)).toEqual(before);expect(wakes(s.app.db)).toEqual([]);
});
it('refuses an active import even if its plain eligibility marker remains',async()=>{
 const s=await setup(),saved={...schedules(s.app.db)[0],enabled:true};
 s.app.db.prepare('UPDATE clock_schedules SET record=? WHERE id=?').run(JSON.stringify(saved),saved.id);
 expect(s.call('scheduleRecover',input)).toMatchObject({ok:false,code:'invalid'});
 expect(schedules(s.app.db)).toEqual([saved]);expect(wakes(s.app.db)).toEqual([]);
});
it('refuses a file import even if it has a stale plain eligibility marker',async()=>{
 const s=await setup({prompt:undefined,prompt_file:'routines/night.md'}),saved={...schedules(s.app.db)[0],importRecovery:'plain' as const};
 s.app.db.prepare('UPDATE clock_schedules SET record=? WHERE id=?').run(JSON.stringify(saved),saved.id);
 expect(s.call('scheduleRecover',input)).toMatchObject({ok:false,code:'invalid'});
 expect(schedules(s.app.db)).toEqual([saved]);expect(wakes(s.app.db)).toEqual([]);
});
it('refuses historical unmarked imports, scope changes and malformed or capability-bearing new submissions without changing records',async()=>{
 const s=await setup(),before=schedules(s.app.db);
 for(const patch of [{agent:'other'},{member:'jonathan'},{model:'saved'},{file:'routines/a.md'},{approval:'a-12345678'},
  {prompt:'<!-- house: local -->\nlocal work'},{at:'bad'},{days:'bad'},{prompt:undefined}]){
  expect(s.call('scheduleRecover',{...input,...patch}).ok).toBe(false);expect(schedules(s.app.db)).toEqual(before);expect(wakes(s.app.db)).toEqual([]);
 }
 const historical:Schedule={...before[0]};delete historical.importRecovery;
 s.app.db.prepare('UPDATE clock_schedules SET record=? WHERE id=?').run(JSON.stringify(historical),historical.id);
 expect(s.call('scheduleRecover',input)).toMatchObject({ok:false,code:'invalid'});
});
it('rolls back schedule and occurrence together and can retry the original receipt',async()=>{
 const s=await setup(),before=schedules(s.app.db),receipt=randomUUID();
 const id='w-111111',row={id,agent:'art',note:'archived occurrence',prompt:'ARCHIVED_WORDS',schedule:input.id,due:s.clock.now(),createdAt:s.clock.now(),changedAt:s.clock.now(),by:{kind:'runner',id:'clock-import:unverified'},failures:0,state:'held',hold:'provenance'};
 s.app.db.prepare('INSERT INTO clock_wakes VALUES (?,?,?)').run(id,JSON.stringify(row),s.clock.now());
 const witnessed:string[]=[];s.app.db.function('recovery_witness',(state:string)=>{witnessed.push(state);return 1;});
 s.app.db.exec("CREATE TRIGGER fail_recovery BEFORE INSERT ON clock_wakes WHEN NEW.id <> 'w-111111' BEGIN SELECT recovery_witness(json_extract((SELECT record FROM clock_wakes WHERE id='w-111111'),'$.state')); SELECT RAISE(ABORT,'fixture'); END");
 expect(s.call('scheduleRecover',input,owner,receipt).ok).toBe(false);expect(witnessed).toEqual(['cancelled']);expect(schedules(s.app.db)).toEqual(before);expect(wakes(s.app.db)).toEqual([row]);
 s.app.db.exec('DROP TRIGGER fail_recovery');expect(s.call('scheduleRecover',input,owner,receipt).ok).toBe(true);expect(wakes(s.app.db).filter(w=>w.state==='pending')).toHaveLength(1);
});
it('requires an explicit new note in the command and accepts an explicitly empty note',async()=>{
 const s=await setup(),argv=['schedule','recover','daily','--at','13:17','-p','FRESH_WORDS'];
 expect(s.call('command',{agent:'art',argv})).toMatchObject({ok:true,value:{exit:2}});
 expect(schedules(s.app.db)[0].enabled).toBe(false);expect(wakes(s.app.db)).toEqual([]);
 expect(s.call('command',{agent:'art',argv:[...argv,'--note','']})).toMatchObject({ok:true,value:{exit:0}});
 expect(schedules(s.app.db)[0].note).toBe('');
});
it('uses the daemon command grammar, and rechecks owner authority on command receipt replay',async()=>{
 const s=await setup(),receipt=randomUUID(),request={agent:'art',argv:['schedule','recover','daily','--at','13:17','--days','mon-fri','-p','FRESH_WORDS','--note','Fresh owner schedule']};
 const result=s.call('command',request,owner,receipt);expect(result).toMatchObject({ok:true,value:{exit:0,stderr:''}});
 expect((result as {value:{stdout:string}}).value.stdout).toContain('schedule daily: next at');expect(wakes(s.app.db)).toHaveLength(1);
 expect(s.call('command',request,owner,receipt)).toEqual(result);
 s.access.members.jonathan.owner=false;expect(s.call('command',request,owner,receipt)).toMatchObject({ok:false,code:'denied'});
});

it('offers recovery only to the current owner and refreshes availability when linked work becomes uncertain',async()=>{
 const s=await setup();const sockets:WebSocket[]=[];
 try {
  for(const agent of [false,true]) {
   const ws=new WebSocket(s.app.url.replace('http:','ws:')+'/live',{headers:agent?{'x-fixture-agent':'art'}:{}});sockets.push(ws);await once(ws,'open');
   const initial=once(ws,'message');ws.send(JSON.stringify({kind:'subscribe',type:'schedule'}));const [raw]=await initial;
   expect(JSON.parse(raw.toString()).records[0].canRecover).toBe(!agent);
  }
  // A wake change must invalidate the schedule's derived hint independently.
  const row=schedules(s.app.db)[0];
  const linked={...row,id:'w-linked',schedule:row.id,due:s.clock.now()+1000,state:'held',hold:'uncertain',failures:0,createdAt:s.clock.now()};
  s.app.db.prepare('INSERT INTO clock_wakes (id,record,changed_at) VALUES (?,?,?)').run(linked.id,JSON.stringify(linked),s.clock.now());
  let changed=once(sockets[0],'message');s.app.live.changed([{type:'wake',id:linked.id}]);let [raw]=await changed;
  expect(JSON.parse(raw.toString()).record.canRecover).toBe(false);
  s.app.db.prepare('DELETE FROM clock_wakes WHERE id=?').run(linked.id);
  changed=once(sockets[0],'message');s.app.live.changed([{type:'wake',id:linked.id}]);[raw]=await changed;
  expect(JSON.parse(raw.toString()).record.canRecover).toBe(true);
  changed=once(sockets[0],'message');s.access.members.jonathan.agents=[];s.app.live.refreshAccess();[raw]=await changed;
  expect(JSON.parse(raw.toString()).records[0].canRecover).toBe(false);
  changed=once(sockets[0],'message');s.access.members.jonathan.agents=['art'];s.app.live.refreshAccess();[raw]=await changed;
  expect(JSON.parse(raw.toString()).records[0].canRecover).toBe(true);
  changed=once(sockets[0],'message');s.access.members.jonathan.owner=false;s.app.live.refreshAccess();[raw]=await changed;
  expect(JSON.parse(raw.toString()).records[0].canRecover).toBe(false);
  expect(s.call('scheduleRecover',input)).toMatchObject({ok:false,code:'denied'});
 } finally {for(const ws of sockets){const closed=once(ws,'close');ws.terminate();await closed;}}
});

it.each([{slot:'old-slot'},{prompt:undefined,prompt_file:'routines/night.md'},{for_why:'steered'},{future_capability:false}])('never offers a live recovery control for unsupported archive %j',async raw=>{
 const s=await setup(raw),ws=new WebSocket(s.app.url.replace('http:','ws:')+'/live');
 try {await once(ws,'open');const initial=once(ws,'message');ws.send(JSON.stringify({kind:'subscribe',type:'schedule'}));const [message]=await initial;
  expect(JSON.parse(message.toString()).records[0].canRecover).toBe(false);
 }finally{const closed=once(ws,'close');ws.terminate();await closed;}
});
it.each(['failed','cancelled','fired'])('allows fresh work after a terminal %s occurrence without replaying its attempt',async state=>{
 const s=await setup(),id='w-terminal';
 const old={id,agent:'art',note:'Old occurrence',prompt:'ARCHIVED_WORDS',schedule:input.id,due:s.clock.now()-1,createdAt:s.clock.now()-1,changedAt:s.clock.now(),by:{kind:'runner',id:'clock-import:unverified'},failures:1,state,attempt:'terminal-attempt'};
 s.app.db.prepare('INSERT INTO clock_wakes VALUES (?,?,?)').run(id,JSON.stringify(old),s.clock.now());
 expect(s.call('scheduleRecover',input).ok).toBe(true);
 expect(wakes(s.app.db).find(w=>w.id===id)).toEqual(old);
 const fresh=wakes(s.app.db).filter(w=>w.id!==id);expect(fresh).toHaveLength(1);expect(fresh[0]).toMatchObject({prompt:'FRESH_WORDS',state:'pending'});expect(fresh[0].attempt).toBeUndefined();
 s.clock.advance(fresh[0].due-s.clock.now());for(let n=0;n<20;n++)await Promise.resolve();
 expect(s.starts).toHaveLength(1);expect(s.starts[0]).toMatchObject({wake:{id:fresh[0].id,prompt:'FRESH_WORDS'}});
 expect(wakes(s.app.db).find(w=>w.id===id)).toEqual(old);
});
