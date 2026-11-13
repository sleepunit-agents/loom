import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Result, type Viewer } from '../../core/index.js';
import { fixtureSharing } from '../../fixture.js';
import { installApprovals } from './index.js';
import { approvalsRole, type Caller } from './role.js';
import { load } from './store.js';
import { installClock } from '../clock/index.js';
import { clockLocalFiling } from '../clock/role.js';
import { filedLocal, localWords } from '../clock/local-filing.js';
const owner:Viewer={kind:'member',id:'jonathan'};
const caller:Caller={who:{agent:'art',where:'house (queue)'},for:'owner',project:'pond'};
const closes:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
const value=<T>(r:Result):T=>{if(!r.ok)throw Error(JSON.stringify(r));return r.value as T;};
async function setup() {
  const home=mkdtempSync(join(tmpdir(),'standing-local-')),clock=new FakeClock(),access=fixtureSharing();
  access.services.clock={types:['clock','approval'],operations:['clock.localRequest','approvals.piece-request','approvals.piece-standing-local','approvals.piece-standing-local-check']};
  access.services.runtime={types:['approval'],operations:['approvals.piece-standing-local','approvals.piece-standing-local-check']};
  const options={home,clock,sharing:()=>access,install(app:Parameters<NonNullable<Parameters<typeof startLoom>[0]['install']>>[0]) {
    installApprovals(app.db,app.operations,app.live,()=>access,{localAgent:'art'});
    const jobs=installClock(app.db,app.operations,app.live,()=>access);app.onClose(jobs.close);
  }};
  let app=await startLoom(options);
  closes.push(async()=>{await app.close();rmSync(home,{recursive:true,force:true});});
  const approval=value<{id:string}>(clockLocalFiling(app.operations).request(caller,'<!-- house: local -->\nInspect disk usage.','disk')).id;
  const filing=filedLocal(app.db,approval)!,words=localWords(filing.prompt,filing.note);
  const input={approval,mode:'use' as 'use'|'check',expected:{target:filing.target,digest:words.digest,details:words.details,caller:filing.caller}};
  const call=(extra:Partial<typeof input>={},who=caller,receipt=randomUUID())=>approvalsRole(app.operations,'clock').localStanding(who,{...input,...extra},receipt);
  const every=()=>value<{id:string}>(app.operations.call('direct',owner,'approvals.every-time',{id:approval},randomUUID()));
  return {get app(){return app;},access,clock,approval,input,call,every,
    async restart(){await app.close();app=await startLoom(options);},
  };
}
it('uses an exact standing filing after restart, deduplicates once, and checks without changing authority or audit',async()=>{
  const s=await setup();expect(s.call().ok).toBe(false);const job=s.every();await s.restart();
  const before=load(s.app.db);expect(s.call({mode:'check'})).toEqual({ok:true,value:{id:job.id,state:'on',uses:0}});
  expect(load(s.app.db)).toEqual(before);
  const receipt=randomUUID(),used=s.call({},caller,receipt);expect(used).toEqual({ok:true,value:{id:job.id,state:'on',uses:1}});
  expect(s.call({},caller,receipt)).toEqual(used);
  expect(s.call({mode:'check'})).toEqual({ok:true,value:{id:job.id,state:'on',uses:1}});
  expect(s.call({}, {...caller,who:{agent:'art',where:'next house (queue)'}})).toMatchObject({ok:true,value:{uses:2}});
  expect(load(s.app.db).audit.filter(r=>r.event==='standing-use')).toHaveLength(2);
});
it('refuses full-digest, details, original caller and service substitutions without use or audit',async()=>{
  const s=await setup();s.every();const before=load(s.app.db),e=s.input.expected;
  for(const expected of [{...e,digest:e.digest.slice(0,16)+'f'.repeat(48)},{...e,details:e.details+'x'},
    {...e,target:e.target+'x'},{...e,caller:{...caller,project:undefined}},
    {...e,caller:{...caller,who:{agent:'art',where:'no suffix'}}}])expect(s.call({expected}).ok).toBe(false);
  for(const who of [{...caller,for:'?'},{...caller,for:'loren'},{...caller,people:['loren']},
    {...caller,project:undefined},{...caller,who:{agent:'art',where:'a body'}},
    {...caller,who:{agent:'art',where:'house (chat)'}},{...caller,who:{agent:'bo',where:caller.who.where}}])expect(s.call({},who).ok).toBe(false);
  expect(load(s.app.db)).toEqual(before);
});
it('rechecks the owning live receipt and standing record on both check and use',async()=>{
  const s=await setup();s.every();const before=load(s.app.db),a=before.approvals[0],j=before.standing[0];
  for(const change of [{kind:'host'},{target:a.target+'x'},{digest:a.digest!.slice(0,16)+'f'.repeat(48)},
    {details:'changed'},{project:undefined},{member:'jonathan'},{for:'?'},{people:['loren']},
    {who:{agent:'art',where:'house (chat)'}},{state:'pending'},{state:'denied'},{state:'withdrawn'},{by:'other'}]) {
    s.app.db.prepare('UPDATE approvals_approvals SET record=? WHERE id=?').run(JSON.stringify({...a,...change}),a.id);
    for(const mode of ['use','check'] as const)expect(s.call({mode}).ok).toBe(false);
  }
  s.app.db.prepare('UPDATE approvals_approvals SET record=? WHERE id=?').run(JSON.stringify(a),a.id);
  for(const change of [{off:{at:j.at}},{from:'a-ffffffff'},{agent:'bo'},{kind:'host'},
    {target:j.target+'x'},{digest:j.digest.slice(0,16)+'f'.repeat(48)},{details:'changed'},
    {for:'?'},{people:['loren']},{who:{agent:'art',where:'a body'}},{by:'other'}]) {
    s.app.db.prepare('UPDATE approvals_rules SET record=? WHERE id=?').run(JSON.stringify({...j,...change}),j.id);
    for(const mode of ['use','check'] as const)expect(s.call({mode}).ok).toBe(false);
  }
  s.app.db.prepare('UPDATE approvals_rules SET record=? WHERE id=?').run(JSON.stringify(j),j.id);
  expect(load(s.app.db)).toEqual(before);expect(s.call().ok).toBe(true);
});
it('standing outlives one-shot expiry/use but a later Deny or disabling the job stops both modes',async()=>{
  const s=await setup(),j=s.every(),a=load(s.app.db).approvals[0];
  s.clock.advance(2*86400_000);expect(s.call({mode:'check'}).ok).toBe(true);
  s.app.db.prepare('UPDATE approvals_approvals SET record=? WHERE id=?').run(JSON.stringify({...a,state:'used'}),a.id);
  expect(s.call().ok).toBe(true);
  const deny={...a,id:'a-ffffffff',state:'denied',decided:new Date(s.clock.now()).toISOString()};
  s.app.db.prepare('INSERT INTO approvals_approvals VALUES (?,?,?)').run(deny.id,JSON.stringify(deny),s.clock.now());
  const before=load(s.app.db);
  for(const mode of ['use','check'] as const)expect(s.call({mode}).ok).toBe(false);
  expect(load(s.app.db)).toEqual(before);
  s.app.db.prepare('DELETE FROM approvals_approvals WHERE id=?').run(deny.id);
  value(s.app.operations.call('direct',owner,'approvals.standing-off',{id:j.id},randomUUID()));
  for(const mode of ['use','check'] as const)expect(s.call({mode}).ok).toBe(false);
});
it('checks are fresh even when the caller reuses an operation id',async()=>{
  const s=await setup(),j=s.every(),receipt=randomUUID();
  expect(s.call({mode:'check'},caller,receipt).ok).toBe(true);
  value(s.app.operations.call('direct',owner,'approvals.standing-off',{id:j.id},randomUUID()));
  expect(s.call({mode:'check'},caller,receipt).ok).toBe(false);
});
it('requires current central agent/project policy and an explicit Clock grant; refuses all public actors and doors',async()=>{
  const s=await setup();s.every();const before=load(s.app.db);
  for(const mode of ['use','check'] as const) {
    s.access.projects.pond.agents=[];expect(s.call({mode}).ok).toBe(false);s.access.projects.pond.agents=['art'];
    s.access.services.clock.operations=[];expect(s.call({mode}).ok).toBe(false);
    s.access.services.clock.operations=['approvals.piece-standing-local','approvals.piece-standing-local-check'];
    const input={...s.input,mode,caller},op=mode==='use'?'approvals.piece-standing-local':'approvals.piece-standing-local-check';
    for(const door of ['http','socket','mcp','direct'] as const)for(const viewer of [owner,{kind:'agent',id:'art'},
      {kind:'runner',id:'r'},{kind:'service',id:'runtime'}] as Viewer[])
      expect(s.app.operations.call(door,viewer,op,input,randomUUID()).ok).toBe(false);
    for(const door of ['http','socket','mcp'] as const)expect(s.app.operations.call(door,{kind:'service',id:'clock'},op,input,randomUUID()).ok).toBe(false);
  }
  expect(load(s.app.db)).toEqual(before);
});
it('rolls back use, audit and operation receipt when owning persistence aborts',async()=>{
  const s=await setup();s.every();const before=load(s.app.db),receipt=randomUUID();
  s.app.db.exec("CREATE TRIGGER abort_standing BEFORE UPDATE ON approvals_rules BEGIN SELECT RAISE(ABORT,'fixture'); END");
  expect(s.call({},caller,receipt).ok).toBe(false);expect(load(s.app.db)).toEqual(before);
  s.app.db.exec('DROP TRIGGER abort_standing');expect(s.call({},caller,receipt)).toMatchObject({ok:true,value:{uses:1}});
});

it('retains the exact use receipt across core expiry and restart without counting or auditing again',async()=>{
  const s=await setup();s.every();const receipt=randomUUID(),r=s.call({},caller,receipt);
  const before=load(s.app.db);s.clock.advance(31*86400_000);await s.restart();
  expect(s.call({},caller,receipt)).toEqual(r);expect(load(s.app.db)).toEqual(before);
  expect(s.call({expected:{...s.input.expected,details:'changed'}},caller,receipt)).toMatchObject({ok:false,code:'conflict'});
});
it('rolls back the already-updated standing use when audit insertion fails',async()=>{
  const s=await setup();s.every();const before=load(s.app.db),receipt=randomUUID();
  s.app.db.exec("CREATE TRIGGER abort_audit BEFORE INSERT ON approvals_audit BEGIN SELECT RAISE(ABORT,'fixture'); END");
  expect(s.call({},caller,receipt).ok).toBe(false);expect(load(s.app.db)).toEqual(before);
  expect(s.app.db.prepare("SELECT key FROM approvals_meta WHERE key LIKE 'local-standing-use:%'").all()).toEqual([]);
  s.app.db.exec('DROP TRIGGER abort_audit');expect(s.call({},caller,receipt)).toMatchObject({ok:true,value:{uses:1}});
});
it('refuses a missing original receipt without spending or changing audit',async()=>{
  const s=await setup();s.every();
  s.app.db.prepare('DELETE FROM approvals_approvals WHERE id=?').run(s.approval);
  const before=load(s.app.db);
  for(const mode of ['use','check'] as const)expect(s.call({mode})).toMatchObject({ok:false,code:'denied'});
  expect(load(s.app.db)).toEqual(before);
  expect(s.app.db.prepare("SELECT key FROM approvals_meta WHERE key LIKE 'local-standing-use:%'").all()).toEqual([]);
});
