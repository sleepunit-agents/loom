import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoom } from '../../foundation.js';
import { createFoundation } from '../../core/app.js';
import { FakeClock, failure } from '../../core/index.js';
import { HouseholdDatabase } from '../../core/household/document.js';
import { SharingDatabase } from '../../core/household/sharing.js';
import { migrateHouseholdTables } from '../../core/household/schema.js';
import { installAttentionMaintenance } from './daemon.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0)) await close(); });
async function setup(staging = false, denied?: { value: boolean }) {
  const home = mkdtempSync(join(tmpdir(), 'attention-maintenance-'));
  const metadata = createFoundation({ home }); migrateHouseholdTables(metadata.db);
  metadata.db.transaction(() => new HouseholdDatabase(metadata.db).replace(home, {
    v: 1, agents: ['art'], default: 'art', owner: 'owner',
    members: [{ person: 'owner', role: 'owner', agents: '*' }, { person: 'other', role: 'member', agents: ['art'] }],
  }))(); metadata.close();
  const clock = new FakeClock(Date.parse('2026-11-13T12:00:00Z'));
  let foundation: ReturnType<typeof createFoundation>;
  const app = await startLoom({ home, next: true, staging, clock, stdout: () => {},
    install: current => { foundation = current; },
    ...(denied ? { sharing: () => {
      const snapshot = new SharingDatabase(foundation.db, home).sharing();
      return denied.value ? { ...snapshot, services: {} } : snapshot;
    } } : {}),
  });
  cleanups.push(async () => { await app.close(); rmSync(home, { recursive: true, force: true }); });
  let n = 0;
  const write = (place: string, member?: string, at = '2026-07-01T09:00:00Z') => {
    const result = app.operations.call('direct', { kind: 'member', id: 'owner' }, 'attention.recordTurn', {
      agent: 'art', ...(member ? { member } : {}),
      turn: { venue: 'loom', place, at, from: { kind: 'person', slug: 'owner' }, kind: 'message' },
    }, `maintenance-${++n}`);
    expect(result).toMatchObject({ ok: true });
  };
  const turns = () => app.db.prepare('SELECT record FROM attention_turns').all().map(r => JSON.parse((r as {record: string}).record));
  return { app, clock, home, write, turns };
}
it.each([false, true])('next mode folds authorized old metadata on the next tick and daily, including staging=%s', async staging => {
  const { app, clock, write, turns } = await setup(staging);
  write('old'); write('private', 'owner'); write('recent', undefined, '2026-11-13T10:00:00Z');
  expect(turns()).toHaveLength(3);
  clock.advance(0);
  expect(turns()).toHaveLength(2);
  expect(turns().some(t => t.member === 'owner')).toBe(true);
  expect(app.db.prepare('SELECT count(*) AS n FROM attention_days').get()).toEqual({ n: 1 });
  write('next-day'); clock.advance(86_400_000 - 1);
  expect(turns()).toHaveLength(3);
  clock.advance(1); expect(turns()).toHaveLength(2);
  expect(app.db.prepare('SELECT count(*) AS n FROM attention_days').get()).toEqual({ n: 2 });
});
it('uses the registered service, reports no private refusal wording and retries tomorrow', async () => {
  const { app, clock, home, write, turns } = await setup();
  const services = new SharingDatabase(app.db, home).sharing().services;
  expect(services.attention.operations).toEqual(expect.arrayContaining(['attention.retain', 'attention.fold']));
  const original = app.operations.call.bind(app.operations), callers: unknown[] = [];
  let refuse = true;
  vi.spyOn(app.operations, 'call').mockImplementation((door, viewer, name, input, id) => {
    if (name === 'attention.retain') {
      callers.push(viewer);
      if (refuse) return failure('denied', 'PRIVATE WORDING');
    }
    return original(door, viewer, name, input, id);
  });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  write('old'); clock.advance(0);
  expect(turns()).toHaveLength(1);
  expect(warning).toHaveBeenCalledExactlyOnceWith('Attention retention failed (denied)');
  refuse = false; clock.advance(86_400_000);
  expect(turns()).toHaveLength(0);
  expect(callers).toEqual([{ kind: 'service', id: 'attention' }, { kind: 'service', id: 'attention' }]);
});
it('installs one maintenance schedule and cancels it before the foundation closes', async () => {
  const { app, clock } = await setup();
  const call = vi.spyOn(app.operations, 'call');
  installAttentionMaintenance(app); installAttentionMaintenance(app);
  clock.advance(0);
  expect(call.mock.calls.filter(c => c[2] === 'attention.retain')).toHaveLength(1);
  const closeDb = app.db.close.bind(app.db);
  vi.spyOn(app.db, 'close').mockImplementation(() => {
    const beforeClose = call.mock.calls.length;
    clock.advance(2 * 86_400_000);
    expect(call).toHaveBeenCalledTimes(beforeClose);
    return closeDb();
  });
  await app.close();
  const count = call.mock.calls.length;
  clock.advance(2 * 86_400_000);
  expect(call).toHaveBeenCalledTimes(count);
});

it('rechecks real central service grants on every sweep without impersonating a member', async () => {
  const denied = { value: false };
  const { clock, write, turns } = await setup(false, denied);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  clock.advance(0); write('old');
  denied.value = true; clock.advance(86_400_000);
  expect(turns()).toHaveLength(1);
  expect(warning).toHaveBeenCalledExactlyOnceWith('Attention retention failed (denied)');
  denied.value = false; clock.advance(86_400_000);
  expect(turns()).toHaveLength(0);
});

it('member retention folds its own private metadata after service retention, leaving other members private turns held', async () => {
  const { app, clock, write, turns } = await setup();
  write('public'); write('owner-private', 'owner');
  expect(app.operations.call('direct', { kind: 'member', id: 'other' }, 'attention.recordTurn', {
    agent: 'art', member: 'other', turn: { venue: 'loom', place: 'other-private', at: '2026-07-01T09:00:00Z', from: { kind: 'person', slug: 'other' }, kind: 'message' },
  }, 'other-private-turn')).toMatchObject({ ok: true });
  clock.advance(0);
  expect(turns().map(t => t.member).sort()).toEqual(['other', 'owner']);
  const changed = vi.spyOn(app.live, 'changed');
  const result = app.operations.call('direct', { kind: 'member', id: 'owner' }, 'attention.retain', {}, 'member-retain');
  expect(result).toEqual({ ok: true, value: { days: 1, turns: 1 } });
  expect(turns()).toMatchObject([{ member: 'other' }]);
  expect(changed).toHaveBeenCalledOnce();
  const days = app.db.prepare('SELECT record FROM attention_days').all().map(r => JSON.parse((r as { record: string }).record));
  expect(days).toHaveLength(2);
  const own = days.find(d => d.member === 'owner');
  expect(own).toMatchObject({ member: 'owner', counts: { message: 1 } });
  expect(app.operations.call('direct', { kind: 'member', id: 'other' }, 'attention.days', { conversation: own.conversation })).toMatchObject({ code: 'denied' });
  expect(app.operations.call('direct', { kind: 'member', id: 'owner' }, 'attention.retain', {}, 'member-retain')).toEqual(result);
  expect(app.operations.call('direct', { kind: 'member', id: 'owner' }, 'attention.retain', {}, 'member-retain-again')).toEqual({ ok: true, value: { days: 0, turns: 0 } });
});
