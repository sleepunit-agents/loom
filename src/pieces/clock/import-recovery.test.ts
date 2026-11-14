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
  const app=await startLoom({home:join(dir,'new'),clock,install(app){
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
it('refuses an uncertain linked import and cancels only definitely unstarted linked work on recovery',async()=>{
 const s=await setup(),id='w-111111';
 const row={id,agent:'art',note:'archived occurrence',prompt:'ARCHIVED_WORDS',schedule:input.id,due:s.clock.now(),createdAt:s.clock.now(),changedAt:s.clock.now(),by:{kind:'runner',id:'clock-import:unverified'},failures:0,state:'held',hold:'uncertain',attempt:'old-attempt'};
 s.app.db.prepare('INSERT INTO clock_wakes VALUES (?,?,?)').run(id,JSON.stringify(row),s.clock.now());
 const before=schedules(s.app.db);expect(s.call('scheduleRecover',input)).toMatchObject({ok:false,code:'invalid'});
 expect(schedules(s.app.db)).toEqual(before);expect(wakes(s.app.db)).toEqual([row]);
 const {attempt:_attempt,...unstarted}=row;
 s.app.db.prepare('UPDATE clock_wakes SET record=? WHERE id=?').run(JSON.stringify({...unstarted,hold:'provenance'}),id);
 expect(s.call('scheduleRecover',input).ok).toBe(true);
 expect(wakes(s.app.db).find(w=>w.id===id)).toMatchObject({state:'cancelled'});
 expect(wakes(s.app.db).filter(w=>w.state==='pending')).toHaveLength(1);
});
it.each([{for:'person:pollock'},{member:'jonathan'},{project:'pond'},{for_people:['pollock']},{lane:'daily'},
 {model:'saved'},{slot:'saved'},{continuation:'saved'},{approval:'saved'},{place:'saved'},{standing:true},
 {prompt:'<!-- house: local -->\nlocal words'},{_firing:true}])('does not recover archived capability or private/person hints: %j',async raw=>{
 const s=await setup(raw),before=schedules(s.app.db);
 expect(s.call('scheduleRecover',input)).toMatchObject({ok:false,code:'invalid'});expect(schedules(s.app.db)).toEqual(before);expect(wakes(s.app.db)).toEqual([]);
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
 s.app.db.exec("CREATE TRIGGER fail_recovery BEFORE INSERT ON clock_wakes BEGIN SELECT RAISE(ABORT,'fixture'); END");
 expect(s.call('scheduleRecover',input,owner,receipt).ok).toBe(false);expect(schedules(s.app.db)).toEqual(before);expect(wakes(s.app.db)).toEqual([]);
 s.app.db.exec('DROP TRIGGER fail_recovery');expect(s.call('scheduleRecover',input,owner,receipt).ok).toBe(true);expect(wakes(s.app.db)).toHaveLength(1);
});
it('uses the daemon command grammar, and rechecks owner authority on command receipt replay',async()=>{
 const s=await setup(),receipt=randomUUID(),request={agent:'art',argv:['schedule','recover','daily','--at','13:17','--days','mon-fri','-p','FRESH_WORDS','--note','Fresh owner schedule']};
 const result=s.call('command',request,owner,receipt);expect(result).toMatchObject({ok:true,value:{exit:0,stderr:''}});
 expect((result as {value:{stdout:string}}).value.stdout).toContain('schedule daily: next at');expect(wakes(s.app.db)).toHaveLength(1);
 expect(s.call('command',request,owner,receipt)).toEqual(result);
 s.access.members.jonathan.owner=false;expect(s.call('command',request,owner,receipt)).toMatchObject({ok:false,code:'denied'});
});
