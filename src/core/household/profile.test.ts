import { once } from 'node:events';
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startLoom } from '../../foundation.js';
import { fixture, installFixture } from '../../fixture.js';
import { FakeClock } from '../clock.js';
import { HouseholdDatabase } from './document.js';
import { installHouseholdProfiles } from './profile.js';
import type { RecordType } from '../live/index.js';
import type { Viewer } from '../../policy.js';
const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
const owner: Viewer = { kind: 'member', id: 'jonathan' }, art: Viewer = { kind: 'agent', id: 'art' };
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'profile-')); fixture(home);
  const clock = new FakeClock(), app = await startLoom({ home, next: true, clock, install: installFixture, stdout: () => {}, authenticate: () => ({ viewer: owner, valid: () => true }) });
  closes.push(async () => { await app.close(); rmSync(home, { recursive: true, force: true }); });
  const db = new HouseholdDatabase(app.db);
  const call = (viewer: Viewer, name: string, input: unknown, id = randomUUID()) => app.operations.call('direct', viewer, `household.${name}`, input, id);
  return { home, clock, app, db, call };
}
it('preserves owner-only edit/request and scoped read across every door, without reading old JSON or publishing metadata', async () => {
  const { app, db, home, call } = await setup();
  db.change(home, raw => { raw.about = { art: 'Imported description.', mark: 'Other.' }; raw.aboutAsk = { mark: 'private timestamp' }; raw.secret = 'never publish'; });
  const before = db.document()!;
  writeFileSync(join(home, 'household.json'), JSON.stringify({ about: { art: 'Wrong old value' } }));
  const denied: Viewer[] = [{ kind: 'member', id: 'pollock' }, { kind: 'member', id: 'missing' }, art, { kind: 'runner', id: 'box' }, { kind: 'service', id: 'sharing' }];
  for (const door of ['http', 'socket', 'mcp', 'direct'] as const) {
    for (const v of denied) for (const name of ['setProfile', 'requestProfile']) expect(app.operations.call(door, v, `household.${name}`, { agent: 'art', ...(name === 'setProfile' ? { text: 'Bad' } : {}) }, randomUUID())).toMatchObject({ code: 'denied' });
    expect(app.operations.call(door, owner, 'household.profile', { agent: 'art' })).toEqual({ ok: true, value: { agent: 'art', description: 'Imported description.' } });
    expect(app.operations.call(door, { kind: 'agent', id: 'mark' }, 'household.profile', { agent: 'art' })).toMatchObject({ code: 'denied' });
  }
  expect(call(owner, 'setProfile', { agent: 'art', text: '  Owner\n words.  ' })).toEqual({ ok: true, value: { agent: 'art', description: 'Owner words.' } });
  expect(db.document()).toEqual({ ...before, about: { art: 'Owner words.', mark: 'Other.' } });
  expect(call(owner, 'setProfile', { agent: 'art', text: 'x'.repeat(601) })).toMatchObject({ code: 'invalid' });
  expect(call(owner, 'setProfile', { agent: 'unknown', text: 'No' })).toMatchObject({ code: 'not-found' });
  expect(call(owner, 'setProfile', { agent: 'art', text: '' })).toEqual({ ok: true, value: { agent: 'art' } });
  expect(call({ kind: 'member', id: 'pollock' }, 'profile', { agent: 'pond-bot' })).toEqual({ ok: true, value: { agent: 'pond-bot' } });
  expect(call({ kind: 'member', id: 'pollock' }, 'profile', { agent: 'art' })).toMatchObject({ code: 'denied' });
});
it('binds agent answers to a once-only unexpired owner request; owner edits close it, bad text never spends it', async () => {
  const { call, db, home, clock } = await setup();
  const answer = (text = 'I keep the household running.') => call(art, 'describeSelf', { text });
  expect(answer()).toMatchObject({ code: 'denied' });
  expect(call(owner, 'requestProfile', { agent: 'art' })).toMatchObject({ ok: true, value: { requestedAt: new Date(clock.now()).toISOString() } });
  for (const v of [owner, { kind: 'member', id: 'pollock' }, { kind: 'agent', id: 'mark' }, { kind: 'agent', id: 'unknown' }, { kind: 'runner', id: 'art' }, { kind: 'service', id: 'art' }] as Viewer[]) expect(call(v, 'describeSelf', { text: 'No.' })).toMatchObject({ code: 'denied' });
  for (const text of ['x'.repeat(301), 'One. Two. Three.', '  ']) expect(answer(text)).toMatchObject({ code: 'invalid' });
  expect(call(art, 'describeSelf', { text: 'Spoof.', agent: 'mark' })).toMatchObject({ code: 'invalid' });
  expect(answer()).toEqual({ ok: true, value: { agent: 'art', description: 'I keep the household running.' } });
  expect(answer('Replace.')).toMatchObject({ code: 'denied' });
  call(owner, 'requestProfile', { agent: 'art' });
  call(owner, 'setProfile', { agent: 'art', text: 'Owner choice.' });
  expect(answer()).toMatchObject({ code: 'denied' });
  call(owner, 'requestProfile', { agent: 'art' }); clock.advance(24 * 3_600_000);
  expect(answer()).toMatchObject({ code: 'denied' });
  db.change(home, raw => { raw.aboutAsk = { art: new Date(clock.now() + 1000).toISOString() }; });
  expect(answer()).toMatchObject({ code: 'denied' });
  expect(call(owner, 'profile', { agent: 'art' })).toEqual({ ok: true, value: { agent: 'art', description: 'Owner choice.' } });
});
it('rolls back profile and request consumption with a failed retry receipt; replay never overwrites later owner words', async () => {
  const { app, db, call } = await setup(); call(owner, 'requestProfile', { agent: 'art' });
  const before = db.document(), id = randomUUID(), events: unknown[] = [];
  app.live.observe(changes => { if (changes.length) events.push(changes); });
  app.db.exec("CREATE TRIGGER fail_profile_result BEFORE INSERT ON core_operations BEGIN SELECT RAISE(ABORT, 'fail'); END");
  expect(call(art, 'describeSelf', { text: 'Agent reply.' }, id)).toMatchObject({ ok: false });
  expect(db.document()).toEqual(before); expect(events).toEqual([]);
  app.db.exec('DROP TRIGGER fail_profile_result');
  const result = call(art, 'describeSelf', { text: 'Agent reply.' }, id); expect(result).toMatchObject({ ok: true });
  expect(events).toHaveLength(1);
  call(owner, 'setProfile', { agent: 'art', text: 'Later owner words.' }); events.length = 0;
  expect(call(art, 'describeSelf', { text: 'Agent reply.' }, id)).toEqual(result); expect(events).toEqual([]);
  expect(call(owner, 'profile', { agent: 'art' })).toEqual({ ok: true, value: { agent: 'art', description: 'Later owner words.' } });
});
it('projects safe scoped Live records and schedules expiry without a poller', async () => {
  const { app, home, clock, call, db } = await setup(), types = new Map<string, RecordType>();
  installHouseholdProfiles({ ...app, operations: { ...app.operations, register: () => {} }, live: { register: (t: RecordType) => types.set(t.name, t) } } as unknown as Parameters<typeof installHouseholdProfiles>[0], home);
  const type = types.get('household.profile')!;
  call(owner, 'requestProfile', { agent: 'art' });
  const record = type.read('art', art)!;
  expect(record).toEqual({ id: 'art', agent: 'art', requestedAt: new Date(clock.now()).toISOString() });
  expect(type.expires!(record)).toBe(clock.now() + 24 * 3_600_000);
  expect(type.read('art', { kind: 'agent', id: 'mark' })).toBeUndefined();
  expect(type.read('unknown', owner)).toBeUndefined();
  clock.advance(24 * 3_600_000); expect(type.read('art', art)).toEqual({ id: 'art', agent: 'art' });
  db.change(home, raw => { (raw.members as Array<{ person: string; agents: string[] }>).find(m => m.person === 'pollock')!.agents = []; });
  expect(type.read('pond-bot', { kind: 'member', id: 'pollock' })).toBeUndefined();
});

it('keeps a scoped Live subscription isolated from other agents and refreshes request expiry', async () => {
  const { app, call, clock } = await setup();
  const ws = new WebSocket(app.url.replace('http:', 'ws:') + '/live');
  closes.push(async () => { ws.terminate(); });
  const messages: unknown[] = [], pending: ((v: unknown) => void)[] = [];
  ws.on('message', raw => { const v: unknown = JSON.parse(raw.toString()); const receive = pending.shift(); if (receive) receive(v); else messages.push(v); });
  const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise<unknown>(resolve => pending.push(resolve));
  await once(ws, 'open'); ws.send(JSON.stringify({ kind: 'subscribe', type: 'household.profile', scope: 'art' }));
  expect(await next()).toMatchObject({ kind: 'set', scope: 'art', records: [{ id: 'art', agent: 'art' }] });
  expect(call(owner, 'setProfile', { agent: 'mark', text: 'Mark only.' }).ok).toBe(true);
  expect(call(owner, 'setProfile', { agent: 'art', text: 'Art only.' }).ok).toBe(true);
  // The Art put is an ordered barrier: an erroneous earlier Mark put fails here.
  expect(await next()).toMatchObject({ kind: 'put', scope: 'art', record: { id: 'art', description: 'Art only.' } });
  expect(call(owner, 'requestProfile', { agent: 'art' }).ok).toBe(true);
  expect(await next()).toMatchObject({ kind: 'put', record: { id: 'art', requestedAt: new Date(clock.now()).toISOString() } });
  clock.advance(24 * 3_600_000);
  expect(await next()).toEqual({ kind: 'put', type: 'household.profile', scope: 'art', record: { id: 'art', agent: 'art', description: 'Art only.' } });
});
