import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startLoom } from '../../foundation.js';
import { FakeClock, type Viewer } from '../../core/index.js';
import { fixtureSharing } from '../../fixture.js';
import { importClock } from './importer.js';
import { wake, wakes, type Wake } from './store.js';
import { load } from '../approvals/store.js';
import { installApprovals } from '../approvals/index.js';
import { approvalsRole } from '../approvals/role.js';
import { clockVouchApplication } from './role.js';
const owner: Viewer = { kind: 'member', id: 'jonathan' };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const ids = ['w-aaaaaa', 'w-bbbbbb', 'w-cccccc'];
async function setup(preinstalled = false) {
  const home = mkdtempSync(join(tmpdir(), 'clock-vouch-'));
  const source = join(home, 'old'); mkdirSync(join(source, 'art'), {recursive:true});
  writeFileSync(join(source, 'art', 'spool.jsonl'), ids.map(id => JSON.stringify({ id, kind:'wake', for:'-',
    at:'2026-11-13 07:00:00', created:'2026-11-13 05:00:00', prompt:'Review my queue', note:'unknown work', origin:'agent:art', fails:3 })).join('\n'));
  const clock = new FakeClock(Date.parse('2026-11-13T12:00:00Z'));
  const access = fixtureSharing();
  access.services.clock = {types:['approval'],operations:['approvals.piece-request']};
  let first = true;
  const options = {home, clock, next:true, sharing:()=>access, stdout:()=>{}, install(app: Parameters<NonNullable<Parameters<typeof startLoom>[0]['install']>>[0]) {
    if (first) { importClock(app.db, source, clock.now()); first = false; }
    if (preinstalled) installApprovals(app.db, app.operations, app.live, ()=>access);
  }};
  let app = await startLoom(options);
  cleanups.push(async () => { await app.close(); rmSync(home,{recursive:true,force:true}); });
  const call = (name:string, input:object, viewer = owner, receipt = randomUUID()) => app.operations.call('direct',viewer,name,input,receipt);
  const value = <T>(name:string, input:object, viewer = owner): T => { const r = call(name,input,viewer); if (!r.ok) throw Error(JSON.stringify(r)); return r.value as T; };
  const change = (id:string, patch: Partial<Wake>) => {
    app.db.prepare('UPDATE clock_wakes SET record=? WHERE id=?').run(JSON.stringify({...wake(app.db,id),...patch}),id);
  };
  const request = (which = ids.slice(0,2)) => {
    const r = approvalsRole(app.operations,'clock').call('request',{who:{agent:'art',where:'clock'},for:'owner'}, {
      kind:'vouch-wake', target:`art:${which.join(',')}`, ask:'Count these unknown wakes as your work?', why:'The imported work has no verified owner.',
      if_yes:'The eligible wakes become your work.', if_no:'The wakes remain held.', details:which.map(id=>`${id} fires at the saved time`).join('\n')
    },randomUUID());
    if (!r.ok) throw Error(JSON.stringify(r)); return r.value as {id:string};
  };
  return { get app(){return app;}, call,value,change,request,clock,access,
    async restart(){await app.close();app=await startLoom(options);} };
}
const settle = async () => {for(let n=0;n<6;n++)await Promise.resolve();};
it('adopts unknown imports with the actual owner and retains words, deadline, archival data and retry receipt across restart', async () => {
  const s = await setup(), before = wake(s.app.db,ids[0])!;
  expect(before.failures).toBe(3);
  const input = {target:`art:${ids[0]}`}, receipt = randomUUID();
  const result = s.call('clock.vouch',input,owner,receipt);
  expect(result).toEqual({ok:true,value:{done:[ids[0]],gone:[]}});
  const adopted = wake(s.app.db,ids[0])!;
  expect(adopted).toEqual({...before,by:owner,state:'pending',hold:undefined,outcome:'Owner vouched for unknown imported work',vouched:{by:'jonathan',at:s.clock.now()}});
  expect(s.call('clock.vouch',input,owner,receipt)).toEqual(result);
  expect(s.app.db.prepare('SELECT * FROM clock_events').all()).toHaveLength(1);
  await s.restart(); expect(wake(s.app.db,ids[0])).toEqual(adopted);
  s.clock.advance(3600_000); await settle();
  expect(wake(s.app.db,ids[0])).toMatchObject({state:'held',hold:'staging',by:owner});
  expect(s.call('clock.vouch',input).ok).toBe(false);
});
it('applies an owner Allow and spends the exact card atomically, while Deny changes no wakes', async () => {
  const s = await setup(), card = s.request();
  const before = wake(s.app.db,ids[2]);
  expect(s.call('approvals.answer',{id:card.id,action:'allow'}).ok).toBe(true);
  expect(load(s.app.db).approvals.find(a=>a.id===card.id)).toMatchObject({state:'used',by:'jonathan'});
  for (const id of ids.slice(0,2)) expect(wake(s.app.db,id)).toMatchObject({state:'pending',by:owner});
  const denial = s.request([ids[2]]);
  expect(s.call('approvals.answer',{id:denial.id,action:'deny'}).ok).toBe(true);
  expect(wake(s.app.db,ids[2])).toEqual(before);
  expect(s.call('approvals.answer',{id:card.id,action:'allow'}).ok).toBe(false);
});
it('rolls back all adopted rows, approval answer, spend and events if the second row cannot commit', async () => {
  const s = await setup(), card = s.request(), before = wakes(s.app.db), approvals = load(s.app.db);
  s.app.db.exec(`CREATE TRIGGER abort_vouch BEFORE UPDATE ON clock_wakes WHEN NEW.id='w-bbbbbb' BEGIN SELECT RAISE(ABORT,'fixture'); END`);
  expect(s.call('approvals.answer',{id:card.id,action:'allow'})).toMatchObject({ok:false});
  expect(wakes(s.app.db)).toEqual(before); expect(load(s.app.db)).toEqual(approvals);
  expect(s.app.db.prepare('SELECT * FROM clock_events').all()).toEqual([]);
  s.app.db.exec('DROP TRIGGER abort_vouch');
  expect(s.call('approvals.answer',{id:card.id,action:'allow'}).ok).toBe(true);
});
it('keeps gone rows unchanged, adopts only eligible ids, and refuses spending when none remain', async () => {
  const s = await setup(); s.change(ids[1],{state:'cancelled'});
  const gone = wake(s.app.db,ids[1]);
  expect(s.value('clock.vouch',{target:`art:${ids.slice(0,2).join(',')}`})).toEqual({done:[ids[0]],gone:[ids[1]]});
  expect(wake(s.app.db,ids[1])).toEqual(gone);
  const card = s.request([ids[2]]); s.change(ids[2],{hold:'uncertain',attempt:'intent'});
  const before = wakes(s.app.db), approvals = load(s.app.db);
  expect(s.call('approvals.answer',{id:card.id,action:'allow'}).ok).toBe(false);
  expect(wakes(s.app.db)).toEqual(before); expect(load(s.app.db)).toEqual(approvals);
});
it('refuses agents, members, runners and services even when a request body claims owner', async () => {
  const s = await setup(), before = wakes(s.app.db);
  for (const viewer of [{kind:'agent',id:'art'},{kind:'member',id:'pollock'},{kind:'runner',id:'clock-import:unverified'},{kind:'service',id:'clock'}] as Viewer[]) {
    expect(s.call('clock.vouch',{target:`art:${ids[0]}`},viewer)).toMatchObject({ok:false,code:'denied'});
    expect(s.call('clock.vouch',{target:`art:${ids[0]}`,by:owner,for:'owner'},viewer).ok).toBe(false);
  }
  expect(wakes(s.app.db)).toEqual(before);
});
it('rechecks the deciding owner and target create policy, refuses cross-agent and private mixed targets', async () => {
  const s = await setup(), card = s.request();
  const before = wakes(s.app.db);
  s.access.members.jonathan.agents = [];
  expect(s.call('clock.vouch',{target:`art:${ids[0]}`}).ok).toBe(false);
  expect(s.call('approvals.answer',{id:card.id,action:'allow'}).ok).toBe(false);
  expect(wakes(s.app.db)).toEqual(before);
  s.access.members.jonathan.agents = ['art','mark'];
  for (const patch of [{agent:'mark'},{member:'pollock'}]) {
    s.change(ids[1],patch);
    const snapshot = wakes(s.app.db);
    expect(s.call('clock.vouch',{target:`art:${ids.slice(0,2).join(',')}`}).ok).toBe(false);
    expect(wakes(s.app.db)).toEqual(snapshot);
    s.change(ids[1],before[1]);
  }
  s.access.members.jonathan.owner = false;
  expect(s.call('clock.vouch',{target:`art:${ids[0]}`}).ok).toBe(false);
});
it('does not adopt uncertain, recurring, parked, already attributed or capability-bearing work', async () => {
  const s = await setup(), original = wake(s.app.db,ids[0])!;
  const patches: Partial<Wake>[] = [
    {hold:'uncertain'}, {state:'firing'}, {state:'fired'}, {state:'failed'}, {state:'cancelled'}, {state:'pending'},
    {schedule:'art/review'}, {wait:{id:'a-12345678',until:s.clock.now()}}, {attempt:'old-intent'},
    {by:owner}, {by:{kind:'agent',id:'art'}}, {continuation:'cont-x'}, {approval:'a-12345678'}, {slot:'review'}, {place:'alert:x'},
    {prompt:'<!-- house: local -->\nDo work'}, {file:'../outside',prompt:undefined},
    ...['for','kind','schedule','on','continuation','approval','slot','place','_firing','local_approval','standing','standing_target','standing_digest','delivery','deliver_place','prompt'].map(key=>({legacy:{...original.legacy,[key]: key==='for'?'owner':key==='prompt'?'<!-- house: local -->':true}})),
  ];
  for (const patch of patches) {
    s.app.db.prepare('UPDATE clock_wakes SET record=? WHERE id=?').run(JSON.stringify({...original,...patch}),ids[0]); const before = wake(s.app.db,ids[0]);
    expect(s.call('clock.vouch',{target:`art:${ids[0]}`}).ok,JSON.stringify(patch)).toBe(false);
    expect(wake(s.app.db,ids[0])).toEqual(before);
  }
});
it('fails closed with preinstalled uncomposed approvals and rejects malformed application calls', async () => {
  const s = await setup(true), card = s.request(), before = wakes(s.app.db);
  expect(s.call('approvals.answer',{id:card.id,action:'allow'})).toMatchObject({ok:false,code:'unavailable'});
  expect(wakes(s.app.db)).toEqual(before);
  const approval = load(s.app.db).approvals.find(a=>a.id===card.id)!;
  const role = clockVouchApplication(s.app.operations);
  for (const a of [approval,{...approval,state:'allowed',by:'other'},{...approval,kind:'merge',state:'allowed',by:'jonathan'}])
    expect(role.apply(a as typeof approval,'jonathan').ok).toBe(false);
});

it('rejects malformed, unordered, repeated or oversized targets without altering rows', async () => {
  const s = await setup(), before = wakes(s.app.db);
  for (const target of ['art:', 'art:w-AAAAAA', 'art:w-zzzzzz', `art:${ids[1]},${ids[0]}`, `art:${ids[0]},${ids[0]}`,
    `art:${ids[0]},w-${randomUUID()},w-${randomUUID()},w-${randomUUID()},w-${randomUUID()},w-${randomUUID()}`])
    expect(s.call('clock.vouch',{target}).ok).toBe(false);
  expect(wakes(s.app.db)).toEqual(before);
});
it('adopts overdue work without bypassing pause, then rechecks authority before dispatch', async () => {
  const s = await setup(); s.clock.advance(3600_000); await settle();
  s.value('clock.pause',{agent:'art'});
  s.value('clock.vouch',{target:`art:${ids[0]}`}); s.clock.advance(0); await settle();
  expect(wake(s.app.db,ids[0])).toMatchObject({state:'held',hold:'paused',by:owner});
  s.value('clock.resume',{agent:'art'});
  s.access.members.jonathan.agents = [];
  s.clock.advance(60_000); await settle();
  expect(wake(s.app.db,ids[0])).toMatchObject({state:'held',hold:'permission'});
});

it('reports invalid executable imports as gone without rolling back other eligible work on the same card', async () => {
  const s = await setup();
  s.change(ids[1],{prompt:undefined,file:'../outside',legacy:{...wake(s.app.db,ids[1])!.legacy,prompt:undefined,prompt_file:'../outside'}});
  const bad = wake(s.app.db,ids[1])!, card = s.request();
  const answer = s.call('approvals.answer',{id:card.id,action:'allow'});
  expect(answer.ok).toBe(true);
  expect(wake(s.app.db,ids[0])).toMatchObject({state:'pending',by:owner,failures:3});
  expect(wake(s.app.db,ids[1])).toEqual(bad);
  const receipt = s.app.db.prepare("SELECT result FROM core_operations WHERE name='clock.vouch'").get() as {result:string};
  expect(JSON.parse(receipt.result)).toEqual({ok:true,value:{done:[ids[0]],gone:[ids[1]]}});
  expect(load(s.app.db).approvals.find(a=>a.id===card.id)?.state).toBe('used');
});
