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
import { clockLocalRecovery } from './role.js';
import { wakes } from './store.js';
const owner: Viewer = {kind:'member',id:'jonathan'};
const caller: Caller = {who:{agent:'art',where:'house (queue)'},for:'owner',conversation:'cv-123456789abc'};
const prompt = localMarker + '\nInspect the host disk usage and report it.';
const closes: (()=>Promise<void>)[] = [];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
async function setup() {
  const home=mkdtempSync(join(tmpdir(),'clock-local-')), access=fixtureSharing(), clock=new FakeClock(Date.parse('2026-11-13T12:00:00Z'));
  access.services.clock={types:['clock','approval'],operations:['clock.localRequest','clock.localSchedule','approvals.piece-request','approvals.piece-use-local']};
  access.services.approvals={types:['approval'],operations:['approvals.piece-request']};
  const options={home,clock,sharing:()=>access,authenticate:()=>({viewer:owner,valid:()=>true}),install(app:Parameters<NonNullable<Parameters<typeof startLoom>[0]['install']>>[0]) {
    installApprovals(app.db,app.operations,app.live,()=>access);
    const jobs=installClock(app.db,app.operations,app.live,()=>access); app.onClose(jobs.close);
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
  value(s.app.operations.call('direct',owner,'approvals.answer',{id,action:'allow'},randomUUID()));
}
function recover(s:Awaited<ReturnType<typeof setup>>,id:string,extra={},c=caller,receipt=randomUUID()) {
  return clockLocalRecovery(s.app.operations).schedule(c,{approval:id,when:'1h',mode:'in',...extra},receipt);
}
it('recovers exact saved words and whole note after restart, atomically spends once and deduplicates its receipt',async()=>{
  const s=await setup(),note='full original note '+ 'n'.repeat(200),id=value<{id:string}>(s.request(prompt,note)).id;
  allow(s,id);await s.restart();
  const receipt=randomUUID(),r=recover(s,id,{},caller,receipt);
  expect(value(r)).toMatchObject({prompt,note,approval:id,agent:'art',by:{kind:'agent',id:'art'},due:s.clock.now()+3600000});
  expect(load(s.app.db).approvals[0].state).toBe('used');expect(wakes(s.app.db)).toHaveLength(1);
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
  expect(call.mock.calls.some(args=>args[2]==='approvals.piece-use-local')).toBe(false);
  expect(load(s.app.db)).toEqual(before);expect(wakes(s.app.db)).toEqual([]);
});
it('requires a current live Allow, its full digest, displayed details and scope',async()=>{
  const s=await setup(),id=idOf(s);
  expect(recover(s,id).ok).toBe(false);allow(s,id);
  const original=load(s.app.db).approvals[0];
  for(const change of [{digest:original.digest!.slice(0,16)+'f'.repeat(48)},{details:'Other words'},{project:'pond'},{member:'jonathan'},
    {who:{agent:'art',where:'bridge (discord)'}},{for:'?'},{state:'denied'},{state:'used',used:original.decided},
    {expires:new Date(s.clock.now()-1000).toISOString()}]) {
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
  s.access.services.clock.operations.push('clock.localSchedule');expect(recover(s,id,{},c).ok).toBe(false);
  s.access.services.clock.operations.push('approvals.piece-use-local');
  for(let n=0;n<50;n++) value(s.app.operations.call('direct',owner,'clock.in',{agent:'art',prompt:'ordinary',note:'',when:'2h'},randomUUID()));
  const call=vi.spyOn(s.app.operations,'call');
  expect(recover(s,id,{},c).ok).toBe(false);expect(load(s.app.db)).toEqual(before);
  expect(call.mock.calls.some(args=>args[2]==='approvals.piece-use-local')).toBe(false);
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
    expect(s.app.operations.call(door,viewer,'clock.localSchedule',input,randomUUID()).ok).toBe(false);
  for(const door of ['http','mcp'] as const)expect(s.app.operations.call(door,{kind:'service',id:'clock'},'clock.localSchedule',input,randomUUID()).ok).toBe(false);
  expect(load(s.app.db).approvals[0].state).toBe('allowed');expect(wakes(s.app.db)).toEqual([]);
});
