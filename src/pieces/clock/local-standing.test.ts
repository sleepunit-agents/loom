import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { fixtureSharing } from '../../fixture.js';
import { installApprovals } from '../approvals/index.js';
import { load } from '../approvals/store.js';
import type { Caller } from '../approvals/model.js';
import { installClock } from './index.js';
import { clockLocalFiling, localMarker } from './local-filing.js';
import { clockLocalRecovery, clockLocalStanding } from './role.js';
import { wakes } from './store.js';
const owner: Viewer = {kind:'member',id:'jonathan'};
const caller: Caller = {who:{agent:'art',where:'house (queue)'},for:'owner',conversation:'cv-123456789abc'};
const prompt = localMarker + '\nInspect the host disk usage and report it.';
const closes: (()=>Promise<void>)[] = [];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
async function setup(runtime?: import('./role.js').Runtime) {
  const home=mkdtempSync(join(tmpdir(),'clock-local-')), access=fixtureSharing(), clock=new FakeClock(Date.parse('2026-11-13T12:00:00Z'));
  access.services.clock={types:['clock','approval'],operations:['clock.localRequest','clock.localStandingSchedule','approvals.piece-request','approvals.piece-standing-local','approvals.piece-standing-local-check']};
  access.services.approvals={types:['approval'],operations:['approvals.piece-request']};
  const options={home,clock,sharing:()=>access,authenticate:()=>({viewer:owner,valid:()=>true}),install(app:Parameters<NonNullable<Parameters<typeof startLoom>[0]['install']>>[0]) {
    installApprovals(app.db,app.operations,app.live,()=>access,{localAgent:'art'});
    const jobs=installClock(app.db,app.operations,app.live,()=>access,{runtime}); app.onClose(jobs.close);
  }};
  let app=await startLoom(options);
  closes.push(async()=>{await app.close();rmSync(home,{recursive:true,force:true});});
  return {get app(){return app;},access,clock,
    request(p=prompt,n='disk report',c=caller){return clockLocalFiling(app.operations).request(c,p,n);},
    async restart(){await app.close();app=await startLoom(options);},
  };
}
const value = <T>(r: import('../../core/index.js').Result): T => {if(!r.ok)throw Error(JSON.stringify(r));return r.value as T;};

const idOf = (s: Awaited<ReturnType<typeof setup>>) => value<{id:string}>(s.request()).id;
function allow(s:Awaited<ReturnType<typeof setup>>,id:string) {
  value(s.app.operations.call('direct',owner,'approvals.every-time',{id},randomUUID()));
}
function recover(s:Awaited<ReturnType<typeof setup>>,id:string,extra={},c=caller,receipt=randomUUID()) {
  return clockLocalStanding(s.app.operations).schedule(c,{approval:id,when:'1h',mode:'in',...extra},receipt);
}
it('recovers exact saved words and whole note after restart, atomically spends once and deduplicates its receipt',async()=>{
  const s=await setup(),note='full original note '+ 'n'.repeat(200),id=value<{id:string}>(s.request(prompt,note)).id;
  allow(s,id);await s.restart();
  const receipt=randomUUID(),r=recover(s,id,{},caller,receipt);
  expect(value(r)).toMatchObject({prompt,note,approval:id,agent:'art',by:{kind:'agent',id:'art'},due:s.clock.now()+3600000});
  expect(load(s.app.db).standing[0].uses).toBe(1);expect(wakes(s.app.db)).toHaveLength(1);
  expect(recover(s,id,{},caller,receipt)).toEqual(r);
  expect(recover(s,id).ok).toBe(false);expect(wakes(s.app.db)).toHaveLength(1);
});
it('refuses retyped words or note, principal, service, agent and project mismatches before spending',async()=>{
  const s=await setup(),id=idOf(s);allow(s,id);const before=load(s.app.db);
  const call=vi.spyOn(s.app.operations,'call');
  for(const extra of [{prompt:prompt+'x'},{note:'disk report '},{when:'bad'},{when:'0s'}])
    expect(recover(s,id,extra).ok).toBe(false);
  for(const c of [{...caller,for:'?'},{...caller,for:'pollock'},{...caller,people:['pollock']},
    {...caller,project:'pond'},{...caller,who:{agent:'bo',where:caller.who.where}},
    {...caller,who:{agent:'art',where:'bridge (discord)'}}, {...caller,who:{agent:'art',where:'a body'}}])
    expect(recover(s,id,{},c).ok).toBe(false);
  expect(call.mock.calls.some(args=>args[2]==='approvals.piece-standing-local')).toBe(false);
  expect(load(s.app.db)).toEqual(before);expect(wakes(s.app.db)).toEqual([]);
});
it('requires a current live Allow, its full digest, displayed details and scope',async()=>{
  const s=await setup(),id=idOf(s);
  expect(recover(s,id).ok).toBe(false);allow(s,id);
  const original=load(s.app.db).approvals[0];
  for(const change of [{digest:original.digest!.slice(0,16)+'f'.repeat(48)},{details:'Other words'},{project:'pond'},{member:'jonathan'},
    {who:{agent:'art',where:'bridge (discord)'}},{for:'?'},{state:'denied'},{by:'not-owner'}]) {
    s.app.db.prepare('UPDATE approvals_approvals SET record=? WHERE id=?').run(JSON.stringify({...original,...change}),id);
    expect(recover(s,id).ok).toBe(false);expect(wakes(s.app.db)).toEqual([]);
  }
  s.app.db.prepare('UPDATE approvals_approvals SET record=? WHERE id=?').run(JSON.stringify(original),id);
  expect(recover(s,id).ok).toBe(true);
});
it('checks capacity and current central agent/project/service policy before spending',async()=>{
  const s=await setup(),c={...caller,project:'pond'},id=value<{id:string}>(s.request(prompt,'disk report',c)).id;allow(s,id);
  const before=load(s.app.db);
  s.access.projects.pond.agents=[];expect(recover(s,id,{},c).ok).toBe(false);s.access.projects.pond.agents=['art'];
  s.access.services.clock.operations=['clock.localRequest','approvals.piece-request'];expect(recover(s,id,{},c).ok).toBe(false);
  s.access.services.clock.operations.push('clock.localStandingSchedule');expect(recover(s,id,{},c).ok).toBe(false);
  s.access.services.clock.operations.push('approvals.piece-standing-local','approvals.piece-standing-local-check');
  for(let n=0;n<50;n++) value(s.app.operations.call('direct',owner,'clock.in',{agent:'art',prompt:'ordinary',note:'',when:'2h'},randomUUID()));
  const call=vi.spyOn(s.app.operations,'call');
  expect(recover(s,id,{},c).ok).toBe(false);expect(load(s.app.db)).toEqual(before);
  expect(call.mock.calls.some(args=>args[2]==='approvals.piece-standing-local')).toBe(false);
});
it('rolls back consumption, audit and changes if scheduling fails',async()=>{
  const s=await setup(),id=idOf(s);allow(s,id);const before=load(s.app.db);
  s.app.db.exec("CREATE TRIGGER abort_wake BEFORE INSERT ON clock_wakes BEGIN SELECT RAISE(ABORT,'fixture'); END");
  expect(recover(s,id).ok).toBe(false);expect(load(s.app.db)).toEqual(before);expect(wakes(s.app.db)).toEqual([]);
  s.app.db.exec('DROP TRIGGER abort_wake');expect(recover(s,id).ok).toBe(true);
});
it('refuses caller forgery from public doors and other actors',async()=>{
  const s=await setup(),id=idOf(s);allow(s,id);const input={caller,approval:id,mode:'in',when:'1h'};
  for(const door of ['http','mcp','direct'] as const)for(const viewer of [owner,{kind:'agent',id:'art'},
    {kind:'runner',id:'runner'},{kind:'service',id:'approvals'}] as Viewer[])
    expect(s.app.operations.call(door,viewer,'clock.localStandingSchedule',input,randomUUID()).ok).toBe(false);
  for(const door of ['http','mcp'] as const)expect(s.app.operations.call(door,{kind:'service',id:'clock'},'clock.localStandingSchedule',input,randomUUID()).ok).toBe(false);
  expect(load(s.app.db).standing[0].uses).toBe(0);expect(wakes(s.app.db)).toEqual([]);
});

it('allows only one outstanding target across receipts and restarts, then permits a new wake after cancellation',async()=>{
  const s=await setup(),id=idOf(s);allow(s,id);
  const receipt=randomUUID(),r=recover(s,id,{},caller,receipt),w=value<{id:string}>(r);
  await s.restart();expect(recover(s,id,{},caller,receipt)).toEqual(r);
  expect(recover(s,id).ok).toBe(false);expect(load(s.app.db).standing[0].uses).toBe(1);
  value(s.app.operations.call('direct',owner,'clock.cancel',{id:w.id},randomUUID()));
  expect(recover(s,id).ok).toBe(true);expect(load(s.app.db).standing[0].uses).toBe(2);
});
it('keeps the exact scheduling receipt beyond 30 days even after terminal work, and rechecks policy before replay',async()=>{
  const s=await setup(),id=idOf(s);allow(s,id);
  const receipt=randomUUID(),r=recover(s,id,{},caller,receipt);
  value(s.app.operations.call('direct',owner,'clock.cancel',{id:value<{id:string}>(r).id},randomUUID()));
  s.clock.advance(31*86400_000);await s.restart();
  expect(recover(s,id,{},caller,receipt)).toEqual(r);expect(wakes(s.app.db)).toHaveLength(1);
  expect(recover(s,id,{when:'2h'},caller,receipt)).toMatchObject({ok:false,code:'conflict'});
  s.access.services.clock.operations=[];expect(recover(s,id,{},caller,receipt)).toMatchObject({ok:false,code:'denied'});
});
const settle=async()=>{for(let n=0;n<12;n++)await Promise.resolve();};
it('dispatches exact saved work after restart, checks without another use, and releases the target after confirmed start',async()=>{
  const startBody=vi.fn(async(_input:Parameters<import('./role.js').Runtime['startBody']>[0])=>({state:'started' as const,body:'body-1'})),s=await setup({startBody});
  const id=idOf(s);allow(s,id);recover(s,id);await s.restart();s.clock.advance(3600000);await settle();
  expect(startBody).toHaveBeenCalledTimes(1);
  expect(startBody.mock.calls[0][0]).toMatchObject({wake:{prompt,note:'disk report',approval:id,by:{kind:'agent',id:'art'}}});
  expect(load(s.app.db).standing[0].uses).toBe(1);expect(wakes(s.app.db)[0].state).toBe('fired');
  expect(recover(s,id).ok).toBe(true);
});
it('holds revoked standing work before runtime, including revocation between intent commit and invocation',async()=>{
  for(const afterIntent of [false,true]) {
    const startBody=vi.fn(async(_input:Parameters<import('./role.js').Runtime['startBody']>[0])=>({state:'started' as const,body:'body'})),s=await setup({startBody});
    const id=idOf(s);allow(s,id);recover(s,id);
    const job=load(s.app.db).standing[0];
    const off=()=>value(s.app.operations.call('direct',owner,'approvals.standing-off',{id:job.id},randomUUID()));
    if(afterIntent) {
      const stop=s.app.live.observe(changes=>{if(changes.some(c=>c.type==='wake') && wakes(s.app.db)[0].state==='firing'){stop();off();}});
    } else off();
    s.clock.advance(3600000);await settle();expect(startBody).not.toHaveBeenCalled();
    expect(wakes(s.app.db)[0]).toMatchObject({state:'held',hold:'permission'});
  }
});
it('holds modified work, changed original cards and revoked current project policy at fire time',async()=>{
  for(const change of ['prompt','note','project','file','approval','card','policy']) {
    const startBody=vi.fn(async(_input:Parameters<import('./role.js').Runtime['startBody']>[0])=>({state:'started' as const,body:'body'})),s=await setup({startBody});
    const c={...caller,project:'pond'},id=value<{id:string}>(s.request(prompt,'disk report',c)).id;allow(s,id);
    recover(s,id,{},c);
    if(change==='policy')s.access.projects.pond.agents=[];
    else if(change==='card') {
      const a=load(s.app.db).approvals[0];s.app.db.prepare('UPDATE approvals_approvals SET record=? WHERE id=?').run(JSON.stringify({...a,digest:a.digest!.slice(0,16)+'f'.repeat(48)}),a.id);
    } else {
      const w=wakes(s.app.db)[0];s.app.db.prepare('UPDATE clock_wakes SET record=? WHERE id=?').run(JSON.stringify({...w,[change]:'changed'}),w.id);
    }
    s.clock.advance(3600000);await settle();expect(startBody).not.toHaveBeenCalled();
    expect(wakes(s.app.db)[0]).toMatchObject({state:'held',hold:'permission'});
  }
});
it('rolls back use, audit, binding and scheduling receipt together when private binding persistence fails',async()=>{
  const s=await setup(),id=idOf(s);allow(s,id);const before=load(s.app.db),receipt=randomUUID();
  s.app.db.exec("CREATE TRIGGER abort_binding BEFORE INSERT ON clock_meta WHEN NEW.key LIKE 'local-standing-wake:%' BEGIN SELECT RAISE(ABORT,'fixture'); END");
  expect(recover(s,id,{},caller,receipt).ok).toBe(false);expect(load(s.app.db)).toEqual(before);expect(wakes(s.app.db)).toEqual([]);
  s.app.db.exec('DROP TRIGGER abort_binding');expect(recover(s,id,{},caller,receipt).ok).toBe(true);
});

it('one-shot and standing recovery cannot duplicate an outstanding standing target in either order',async()=>{
  for(const standingFirst of [true,false]) {
    const s=await setup(),id=idOf(s);allow(s,id);
    s.access.services.clock.operations.push('clock.localSchedule','approvals.piece-use-local');
    const once=()=>clockLocalRecovery(s.app.operations).schedule(caller,{approval:id,mode:'in',when:'1h'});
    expect((standingFirst?recover(s,id):once()).ok).toBe(true);
    expect((standingFirst?once():recover(s,id)).ok).toBe(false);
    expect(wakes(s.app.db)).toHaveLength(1);
  }
});
it('a definitely not-started retry and an uncertain result both keep the target occupied',async()=>{
  for(const state of ['not-started','uncertain'] as const) {
    const s=await setup({startBody:async()=>({state,reason:'fixture'})}),id=idOf(s);allow(s,id);recover(s,id);
    s.clock.advance(3600000);await settle();expect(recover(s,id).ok).toBe(false);
    expect(load(s.app.db).standing[0].uses).toBe(1);
  }
});

it('rechecks immutable executable words after intent commit and before runtime invocation',async()=>{
  const startBody=vi.fn(async(_input:Parameters<import('./role.js').Runtime['startBody']>[0])=>({state:'started' as const,body:'body'}));
  const s=await setup({startBody}),id=idOf(s);allow(s,id);recover(s,id);
  const stop=s.app.live.observe(changes=>{
    const w=wakes(s.app.db)[0];
    if(changes.some(c=>c.type==='wake') && w.state==='firing') {
      stop();s.app.db.prepare('UPDATE clock_wakes SET record=? WHERE id=?').run(JSON.stringify({...w,prompt:prompt+'changed'}),w.id);
    }
  });
  s.clock.advance(3600000);await settle();expect(startBody).not.toHaveBeenCalled();
  expect(wakes(s.app.db)[0]).toMatchObject({state:'held',hold:'permission'});
});
it('keeps a firing target occupied while runtime has not reported its outcome',async()=>{
  let finish!:(r:import('./role.js').StartResult)=>void;
  const s=await setup({startBody:()=>new Promise(resolve=>{finish=resolve;})}),id=idOf(s);allow(s,id);recover(s,id);
  s.access.services.clock.operations.push('clock.localSchedule','approvals.piece-use-local');
  s.clock.advance(3600000);await settle();expect(wakes(s.app.db)[0].state).toBe('firing');
  expect(recover(s,id).ok).toBe(false);
  expect(clockLocalRecovery(s.app.operations).schedule(caller,{approval:id,mode:'in',when:'1h'}).ok).toBe(false);
  expect(load(s.app.db).standing[0].uses).toBe(1);expect(wakes(s.app.db)).toHaveLength(1);
  finish({state:'started',body:'body'});await settle();expect(recover(s,id).ok).toBe(true);
});
