import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { startLoom } from '../../foundation.js';
import { FakeClock, operation, type Viewer } from '../../core/index.js';
import { fixtureSharing } from '../../fixture.js';
import { installAttention } from '../attention/index.js';
import { secretGrantAttention } from '../secrets/attention.js';
import { installSecrets, grantsRole } from '../secrets/index.js';
import { wake, type Wake } from './store.js';
import { installClock } from './index.js';
import { createFoundation } from '../../core/app.js';
import { clockAnswers } from './dependencies/answers.js';

const owner: Viewer = { kind: 'member', id: 'jonathan' };
const agent: Viewer = { kind: 'agent', id: 'art' };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
async function setup(secrets = false) {
  const home = mkdtempSync(join(tmpdir(), 'loom-clock-answers-'));
  const clock = new FakeClock(Date.parse('2026-11-13T12:00:00Z'));
  const access = fixtureSharing();
  const sharing = () => access;
  const options = { home, clock, next: true, sharing, install: secrets ? (app: Parameters<NonNullable<Parameters<typeof startLoom>[0]['install']>>[0]) => {
    const sources = installAttention(app.db, app.operations, app.live, sharing);
    installSecrets(app.db, app.operations, app.live, sharing, secretGrantAttention(sources, app.operations));
  } : undefined };
  let app = await startLoom(options);
  cleanups.push(async () => { await app.close(); rmSync(home, { recursive: true, force: true }); });
  const call = (name: string, input: object = {}, viewer = owner) => app.operations.call('direct', viewer, name, input, randomUUID());
  const value = <T>(name: string, input: object = {}, viewer = owner): T => {
    const result = call(name, input, viewer); if (!result.ok) throw Error(JSON.stringify(result)); return result.value as T;
  };
  const request = () => value<{id:string}>('approvals.request', { kind: 'merge', target: `github:acme/app#12@${'a'.repeat(40)}`, ask: 'Merge the fix?', why: 'Fix the page.', if_yes: 'I merge it.', if_no: 'I leave it open.' }, agent);
  const park = (id: string, viewer = agent) => value<Wake>('clock.park', { agent: 'art', prompt: 'Continue original work', note: 'original note', on: id }, viewer);
  const flush = async () => { clock.advance(0); await settle(); };
  return { get app() { return app; }, call, value, request, park, clock, access, flush,
    async restart() { await app.close(); app = await startLoom(options); } };
}

it('next parks on a real approval and wakes promptly on Allow without spending it', async () => {
  const s = await setup(); const card = s.request(); const parked = s.park(card.id);
  await s.flush(); expect(wake(s.app.db, parked.id)?.state).toBe('parked');
  s.value('approvals.answer', {id:card.id, action:'allow'});
  await s.flush();
  expect(wake(s.app.db, parked.id)).toMatchObject({state:'held',hold:'staging',wait:{answer:'allowed'},note:'Resumed after your OK: original note'});
  expect(wake(s.app.db, parked.id)?.prompt).toContain(`approvals use ${card.id} --kind merge --target`);
  expect(s.value('approvals.check',{id:card.id},agent)).toEqual({state:'allowed'});
  await s.restart(); await s.flush();
  expect(wake(s.app.db, parked.id)?.state).toBe('held');
});

it('reads a Deny after restart and times out a pending card with distinct instructions', async () => {
  const s = await setup(); const first = s.request(); const denied = s.park(first.id);
  await s.restart(); s.value('approvals.answer',{id:first.id,action:'deny'}); await s.flush();
  expect(wake(s.app.db, denied.id)?.prompt).toContain('answer to '+first.id+': denied');
  expect(wake(s.app.db, denied.id)?.prompt).not.toContain('approvals use');
  const second = s.request(); const pending = s.park(second.id);
  const deadline = pending.wait!.until;
  s.clock.advance(12*3600_000); await settle(); await s.restart();
  expect(wake(s.app.db,pending.id)?.wait?.until).toBe(deadline);
  s.clock.advance(deadline-s.clock.now()-1); await settle();
  expect(wake(s.app.db,pending.id)?.state).toBe('parked');
  s.clock.advance(1); await settle();
  expect(wake(s.app.db,pending.id)).toMatchObject({state:'held',wait:{answer:'pending'}});
  expect(wake(s.app.db,pending.id)?.prompt).toContain('No answer to '+second.id+' after 24h');
});

it('refuses invisible or missing answers and rechecks visibility rather than saved action metadata', async () => {
  const s = await setup(); const card = s.request();
  const reader = clockAnswers(s.app.db,s.app.operations,s.app.live,()=>s.access);
  for (const viewer of [{kind:'agent',id:'mark'}, {kind:'member',id:'pollock'}, {kind:'service',id:'ungranted'}, {kind:'runner',id:'box'}] as Viewer[]) {
    expect(reader.check(card.id,viewer)).toBeUndefined();
    expect(s.call('clock.park',{agent:'mark',prompt:'Hidden',note:'',on:card.id},viewer).ok).toBe(false);
  }
  expect(s.call('clock.park',{agent:'art',prompt:'Missing',note:'',on:'a-deadbeef'},agent).ok).toBe(false);
  const parked = s.park(card.id,owner); await s.flush();
  s.clock.advance(60_000); await settle();
  s.app.operations.register(operation({name:'fixture.revoke',write:true,input:z.object({}),output:z.unknown(),may:()=>true,run(ctx){
    s.access.members.jonathan.agents = []; s.access.members.jonathan.owner = false; ctx.changed('core.access','all');
  }}));
  s.value('fixture.revoke'); await s.flush();
  expect(wake(s.app.db,parked.id)).toMatchObject({state:'held',hold:'permission'});
  expect(reader.check(card.id,owner)).toBeUndefined();
  s.clock.advance(86400_000); await settle();
  expect(wake(s.app.db,parked.id)).toMatchObject({state:'held',hold:'permission'});
  expect(wake(s.app.db,parked.id)?.prompt).not.toContain('approvals use');
});

it('composes real secret request answers without exposing secret names or granting a new house', async () => {
  const s = await setup(true);
  s.value('secrets.describe',{name:'api-key',description:'Private secret name'});
  const request = s.value<{id:string}>('secrets.requestHouse',{agent:'art',target:'api-key',scope:{house:'h-1'},why:'work',minutes:2},agent);
  const parked = s.park(request.id); await s.flush();
  const now = s.clock.now();
  expect(wake(s.app.db,parked.id)?.due).toBe(now+5*60_000);
  s.value('attention.answer',{id:request.id,answer:{kind:'yes'}});
  const grants = s.app.db.prepare('SELECT * FROM secrets_grants ORDER BY id').all();
  expect(grants).toHaveLength(1);
  await s.flush(); expect(s.clock.now()).toBe(now);
  expect(wake(s.app.db,parked.id)).toMatchObject({state:'held',wait:{answer:'allowed'}});
  expect(wake(s.app.db,parked.id)?.prompt).toContain('request it again');
  const reader = clockAnswers(s.app.db,s.app.operations,s.app.live,()=>s.access);
  expect(reader.check(request.id,agent)).toEqual({state:'allowed'});
  expect(wake(s.app.db,parked.id)?.prompt).not.toContain('api-key');
  expect(reader.check(request.id,{kind:'agent',id:'mark'})).toBeUndefined();
  expect(s.app.db.prepare('SELECT * FROM secrets_grants ORDER BY id').all()).toEqual(grants);
  const may = grantsRole(s.app.db);
  expect(may.mayUse('art',{kind:'secret',target:'api-key'},s.clock.now(),{house:'h-1'})).toBe(true);
  expect(may.mayUse('art',{kind:'secret',target:'api-key'},s.clock.now(),{house:'h-2'})).toBe(false);
  expect(s.value('secrets.may',{agent:'art',kind:'secret',target:'api-key'},agent)).toEqual({allow:false});
});

it('keeps missing Secrets unavailable and unsubscribes the answer observer', async () => {
  const s = await setup(); const reader = clockAnswers(s.app.db,s.app.operations,s.app.live,()=>s.access);
  expect(reader.check('q-missing',owner)).toBeUndefined();
  let changes = 0; const off = reader.subscribe(()=>changes++);
  s.app.live.changed([{type:'wake',id:'w-test'}]); expect(changes).toBe(0);
  s.app.live.changed([{type:'approval',id:'a-test'}]); expect(changes).toBe(1);
  s.app.live.changed([{type:'secret.request',id:'q-test'}]); expect(changes).toBe(2);
  s.app.live.changed([{type:'core.access',id:'all'}]); expect(changes).toBe(3);
  off(); s.app.live.changed([{type:'core.access',id:'all'}]); expect(changes).toBe(3);
});

it('observes an expired approval rather than handing out stale Allow instructions', async () => {
  const s = await setup(); const card = s.request();
  expect(await s.app.operations.callAsync('socket',owner,'approvals.answer',{id:card.id,action:'allow'},randomUUID(),true)).toMatchObject({ok:true});
  const approval = s.value<{approvals:{id:string;expires:string}[]}>('approvals.list').approvals.find(a=>a.id===card.id)!;
  s.clock.advance(Date.parse(approval.expires)-s.clock.now());
  const parked = s.park(card.id); await s.flush();
  expect(wake(s.app.db,parked.id)).toMatchObject({state:'held',wait:{answer:'expired'}});
  expect(wake(s.app.db,parked.id)?.prompt).not.toContain('approvals use');
});

it('reads a real secret Deny after restart without reopening its household ask', async () => {
  const s = await setup(true);
  s.value('secrets.describe',{name:'api-key',description:''});
  const request = s.value<{id:string}>('secrets.requestHouse',{agent:'art',target:'api-key',scope:{house:'h-1'},why:'work'},agent);
  const parked = s.park(request.id);
  await s.restart(); s.value('attention.answer',{id:request.id,answer:{kind:'no'}}); await s.flush();
  expect(wake(s.app.db,parked.id)).toMatchObject({state:'held',wait:{answer:'denied'}});
  expect(wake(s.app.db,parked.id)?.prompt).not.toContain('request it again');
  expect(s.value('attention.get',{id:request.id})).toMatchObject({answer:{kind:'no'}});
});

it('keeps wake authority while answer visibility differs from a privileged viewer', async () => {
  const s = await setup(); const card = s.request(); const parked = s.park(card.id);
  // Construct a current private approval scope after the park was filed. Clock
  // work is still agent-visible; the answer is now only visible to its member.
  const row = s.app.db.prepare('SELECT record FROM approvals_approvals WHERE id=?').get(card.id) as {record:string};
  s.app.db.prepare('UPDATE approvals_approvals SET record=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.record),member:'jonathan'}),card.id);
  expect(await s.app.operations.callAsync('socket',owner,'approvals.answer',{id:card.id,action:'allow'},randomUUID(),true)).toMatchObject({ok:true});
  const answers = clockAnswers(s.app.db,s.app.operations,s.app.live,()=>s.access);
  expect(answers.check(card.id,agent)).toBeUndefined();
  expect(answers.check(card.id,owner)?.state).toBe('allowed');
  expect(s.call('clock.checkPark',{id:parked.id},owner).ok).toBe(true);
  await s.flush(); expect(wake(s.app.db,parked.id)?.state).toBe('parked');
  s.clock.advance(parked.wait!.until-s.clock.now()); await settle();
  expect(wake(s.app.db,parked.id)).toMatchObject({state:'held',hold:'staging',wait:{answer:'unknown'}});
  expect(wake(s.app.db,parked.id)?.prompt).not.toContain('approvals use');
});

it('Clock close disposes its composed observer before the foundation closes', () => {
  const home = mkdtempSync(join(tmpdir(),'loom-clock-answer-close-'));
  const app = createFoundation({home,clock:new FakeClock()});
  try {
    const answers = clockAnswers(app.db,app.operations,app.live,fixtureSharing);
    const notified = vi.fn(); const disposed = vi.fn();
    const subscribe = (changed:()=>void) => {
      const off = answers.subscribe(()=>{notified();changed();});
      return () => {disposed();off();};
    };
    const jobs = installClock(app.db,app.operations,app.live,fixtureSharing,{approvals:{...answers,subscribe}});
    app.live.changed([{type:'approval',id:'a-test'}]); expect(notified).toHaveBeenCalledTimes(1);
    jobs.close(); jobs.close(); expect(disposed).toHaveBeenCalledTimes(1);
    app.live.changed([{type:'approval',id:'a-test'}]); expect(notified).toHaveBeenCalledTimes(1);
  } finally {app.close();rmSync(home,{recursive:true,force:true});}
});

it('uses current secret revocation before a queued Allow can resume work', async () => {
  const s = await setup(true);
  s.value('secrets.describe',{name:'api-key',description:''});
  const request = s.value<{id:string}>('secrets.requestHouse',{agent:'art',target:'api-key',scope:{house:'h-1'},why:'work'},agent);
  const parked = s.park(request.id); await s.flush();
  s.value('attention.answer',{id:request.id,answer:{kind:'yes'}});
  s.value('secrets.revoke',{agent:'art',kind:'secret',target:'api-key',scope:{house:'h-1'}});
  await s.flush();
  expect(wake(s.app.db,parked.id)).toMatchObject({state:'held',wait:{answer:'cancelled'}});
  expect(wake(s.app.db,parked.id)?.prompt).toContain('answer to '+request.id+': cancelled');
  expect(wake(s.app.db,parked.id)?.prompt).not.toContain('request it again');
  expect(wake(s.app.db,parked.id)?.prompt).not.toContain('approvals use');
  expect(s.app.db.prepare('SELECT * FROM secrets_grants').all()).toEqual([]);
});

it('resumes an applied resource grant without giving secret-house or receipt-spending instructions', async () => {
  const s = await setup(true);
  const request = s.value<{id:string}>('secrets.request',{agent:'art',kind:'piece',target:'tasks',why:'work'},agent);
  const parked = s.park(request.id); await s.flush();
  s.value('attention.answer',{id:request.id,answer:{kind:'yes'}});
  const grants = s.app.db.prepare('SELECT * FROM secrets_grants ORDER BY id').all();
  await s.flush();
  expect(wake(s.app.db,parked.id)).toMatchObject({state:'held',wait:{answer:'allowed'}});
  expect(wake(s.app.db,parked.id)?.prompt).toContain('Check the requested access is available');
  expect(wake(s.app.db,parked.id)?.prompt).not.toContain('request it again');
  expect(wake(s.app.db,parked.id)?.prompt).not.toContain('approvals use');
  expect(s.app.db.prepare('SELECT * FROM secrets_grants ORDER BY id').all()).toEqual(grants);
  expect(grantsRole(s.app.db).mayUse('art',{kind:'piece',target:'tasks'},s.clock.now())).toBe(true);
});
