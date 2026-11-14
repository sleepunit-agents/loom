import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { startLoom } from '../../foundation.js';
import { FakeClock, failure, operation, type RecordType, type Viewer } from '../../core/index.js';
import { installAttention } from './index.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const alice: Viewer = { kind: 'member', id: 'alice' }, bob: Viewer = { kind: 'member', id: 'bob' };
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'attention-member-'));
  const clock = new FakeClock();
  const access = { members: { alice: { owner: true, agents: ['art'] }, bob: { owner: false, agents: ['art'] } }, projects: {}, services: {} };
  const types = new Map<string, RecordType>();
  const app = await startLoom({ home, clock, sharing: () => access, install: app => {
    const register = app.live.register.bind(app.live); app.live.register = type => { types.set(type.name, type); register(type); };
    installAttention(app.db, app.operations, app.live, () => access);
  } });
  cleanup.push(async () => { await app.close(); rmSync(home, { recursive: true, force: true }); });
  let n = 0;
  const call = (name: string, input: unknown, viewer = alice, id = `member-${++n}`) => app.operations.call('direct', viewer, `attention.${name}`, input, id);
  expect(call('raise', { id: 'ask', agent: 'art', ask: 'Continue?', source: { kind: 'conversation', id: 'cv-test' } })).toMatchObject({ ok: true });
  return { app, home, clock, access, call, type: types.get('attention.readMark')! };
}
it('marks only the authenticated member, leaves the ask open, and publishes once across fresh/retried writes', async () => {
  const { app, clock, call, type } = await setup();
  const changed = vi.spyOn(app.live, 'changed');
  const first = call('markRead', { id: 'ask' }, alice, 'first');
  expect(first).toMatchObject({ value: { ask: 'ask', member: 'alice', readAt: clock.now() } });
  clock.advance(60_000);
  expect(call('markRead', { id: 'ask' }, alice, 'first')).toEqual(first);
  expect(call('markRead', { id: 'ask' })).toEqual(first);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(call('get', { id: 'ask' })).toMatchObject({ value: { state: 'open' } });
  const id = type.ids(undefined)[0];
  expect(type.read(id, alice)).toMatchObject({ member: 'alice' });
  expect(type.read(id, bob)).toBeUndefined();
  expect(call('markRead', { id: 'ask' }, bob)).toMatchObject({ value: { member: 'bob' } });
  expect(type.ids(undefined)).toHaveLength(2);
});
it('rejects forged membership and nonmembers; revocation hides held marks without widening ask scope', async () => {
  const { call, type, access } = await setup();
  expect(call('markRead', { id: 'ask', member: 'bob' })).toMatchObject({ code: 'invalid' });
  for (const viewer of [{kind:'agent',id:'art'}, {kind:'service',id:'attention'}, {kind:'member',id:'missing'}] as Viewer[]) expect(call('markRead', { id: 'ask' }, viewer)).toMatchObject({ code: 'denied' });
  expect(call('markRead', { id: 'missing' })).toMatchObject({ code: 'denied' });
  call('markRead', { id: 'ask' }, bob);
  const id = type.ids(undefined)[0];
  access.members.bob.agents = [];
  expect(type.read(id, bob)).toBeUndefined();
  expect(call('markRead', { id: 'ask' }, bob)).toMatchObject({ code: 'denied' });
  access.members.bob.agents = ['art'];
  expect(type.read(id, bob)).toMatchObject({ ask: 'ask' });
  expect(call('raise', { id:'private',agent:'art',member:'alice',ask:'Private?',source:{kind:'conversation',id:'cv-private'} })).toMatchObject({ok:true});
  expect(call('markRead', { id:'private' }, bob)).toMatchObject({code:'denied'});
});
it('rolls back marks, retry receipts and live publication with its enclosing operation', async () => {
  const { app, call } = await setup();
  const changed = vi.spyOn(app.live, 'changed');
  const before = app.db.prepare('SELECT * FROM core_operations').all();
  app.operations.register(operation({name:'test.readMark',write:true,input:z.object({}),output:z.unknown(),may:()=>true,
    run() { expect(call('markRead',{id:'ask'})).toMatchObject({ok:true}); return failure('conflict','Abort'); },
  }));
  expect(app.operations.call('direct',alice,'test.readMark',{},'outer')).toMatchObject({code:'conflict'});
  expect(app.db.prepare('SELECT * FROM attention_read_marks').all()).toEqual([]);
  expect(app.db.prepare('SELECT * FROM core_operations').all()).toEqual(before);
  expect(changed).not.toHaveBeenCalled();
});

it('upgrades an existing version-five database without changing asks and keeps read facts after reopen', async () => {
  const { createFoundation } = await import('../../core/app.js');
  const { migrate } = await import('../../core/index.js');
  const { attentionMigrations } = await import('./schema/index.js');
  const home = mkdtempSync(join(tmpdir(), 'attention-read-upgrade-'));
  const sharing = () => ({members:{alice:{owner:true,agents:['art']}},projects:{},services:{}});
  const first = createFoundation({home,clock:new FakeClock()});
  migrate(first.db, 'attention', attentionMigrations.filter(m => m.number <= 5));
  const original = JSON.stringify({id:'old',agent:'art',ask:'An existing ask',source:{kind:'conversation',id:'cv-old'},state:'open',createdAt:1,changedAt:1});
  first.db.prepare('INSERT INTO attention_asks VALUES (?,?)').run('old',original);
  installAttention(first.db,first.operations,first.live,sharing);
  expect((first.db.prepare('SELECT record FROM attention_asks WHERE id=?').get('old') as {record:string}).record).toBe(original);
  const marked = first.operations.call('direct',alice,'attention.markRead',{id:'old'},'upgrade-read');
  expect(marked).toMatchObject({ok:true,value:{ask:'old',member:'alice'}});
  migrate(first.db,'attention',attentionMigrations);
  expect(first.db.prepare('SELECT * FROM attention_read_marks').all()).toHaveLength(1);
  first.close();
  const next = createFoundation({home,clock:new FakeClock()});
  cleanup.push(async()=>{next.close();rmSync(home,{recursive:true,force:true});});
  installAttention(next.db,next.operations,next.live,sharing);
  expect(next.operations.call('direct',alice,'attention.markRead',{id:'old'},'fresh-read')).toEqual(marked);
  expect((next.db.prepare('SELECT record FROM attention_asks WHERE id=?').get('old') as {record:string}).record).toBe(original);
});
