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
async function setup(staging = false, denied?: { value: boolean; fold?: boolean }) {
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
      if (denied.value) return { ...snapshot, services: {} };
      if (denied.fold) return { ...snapshot, services: { ...snapshot.services, attention: { ...snapshot.services.attention, operations: snapshot.services.attention.operations.filter(op => op !== 'attention.fold') } } };
      return snapshot;
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
  expect(warning.mock.calls.filter(([message]) => message === 'Attention retention failed (denied)')).toHaveLength(1);
  expect(warning.mock.calls.every(([message]) => ['Attention retention failed (denied)', 'Attention wait inventory failed (denied)'].includes(message))).toBe(true);
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
  expect(warning.mock.calls.filter(([message]) => message === 'Attention retention failed (denied)')).toHaveLength(1);
  expect(warning.mock.calls.every(([message]) => ['Attention retention failed (denied)', 'Attention wait inventory failed (denied)'].includes(message))).toBe(true);
  denied.value = false; clock.advance(86_400_000);
  expect(turns()).toHaveLength(0);
});

it('household owner retention folds all private metadata after service retention', async () => {
  const { app, clock, write, turns } = await setup();
  write('public'); write('owner-private', 'owner');
  expect(app.operations.call('direct', { kind: 'member', id: 'other' }, 'attention.recordTurn', {
    agent: 'art', member: 'other', turn: { venue: 'loom', place: 'other-private', at: '2026-07-01T09:00:00Z', from: { kind: 'person', slug: 'other' }, kind: 'message' },
  }, 'other-private-turn')).toMatchObject({ ok: true });
  clock.advance(0);
  expect(turns().map(t => t.member).sort()).toEqual(['other', 'owner']);
  const changed = vi.spyOn(app.live, 'changed');
  const result = app.operations.call('direct', { kind: 'member', id: 'owner' }, 'attention.retain', {}, 'member-retain');
  expect(result).toEqual({ ok: true, value: { days: 2, turns: 2 } });
  expect(turns()).toEqual([]);
  expect(changed).toHaveBeenCalledOnce();
  const days = app.db.prepare('SELECT record FROM attention_days').all().map(r => JSON.parse((r as { record: string }).record));
  expect(days).toHaveLength(3);
  const own = days.find(d => d.member === 'owner');
  expect(own).toMatchObject({ member: 'owner', counts: { message: 1 } });
  expect(app.operations.call('direct', { kind: 'member', id: 'other' }, 'attention.days', { conversation: own.conversation })).toMatchObject({ code: 'denied' });
  expect(app.operations.call('direct', { kind: 'member', id: 'owner' }, 'attention.retain', {}, 'member-retain')).toEqual(result);
  expect(app.operations.call('direct', { kind: 'member', id: 'owner' }, 'attention.retain', {}, 'member-retain-again')).toEqual({ ok: true, value: { days: 0, turns: 0 } });
});

it.each(['continue', 'revoke', 'fold', 'stop'] as const)('yields retention inventory after 1000 conversations: %s', async mode => {
  const denied = { value: false, fold: false };
  const { app, clock } = await setup(false, denied);
  const putConversation = app.db.prepare('INSERT INTO attention_conversations VALUES (?,?)');
  const putTurn = app.db.prepare('INSERT INTO attention_turns VALUES (?,?,?,?)');
  app.db.transaction(() => {
    for (let n = 0; n < 2001; n++) {
      const id = `cv-${n.toString(16).padStart(12, '0')}`;
      putConversation.run(id, JSON.stringify({ id, agent: 'art' }));
      putTurn.run(`${id}:1`, id, 1, JSON.stringify({ id: `${id}:1`, conversation: id, seq: 1, at: '2026-07-01T09:00:00Z', kind: 'message' }));
    }
  })();
  const count = () => (app.db.prepare('SELECT count(*) AS n FROM attention_days').get() as { n: number }).n;
  const calls = vi.spyOn(app.operations, 'call');
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  let stopClose: Promise<void> | undefined;
  let closing = false;
  clock.at(clock.now(), () => {
    expect(count()).toBe(1000);
    if (mode === 'revoke') denied.value = true;
    if (mode === 'fold') denied.fold = true;
    if (mode === 'stop') { closing = true; stopClose = app.close(); }
  });
  const cancellations: ReturnType<typeof vi.fn>[] = [];
  const at = clock.at.bind(clock);
  vi.spyOn(clock, 'at').mockImplementation((time, fn) => {
    const cancel = vi.fn(at(time, fn));
    if (!closing && time === clock.now()) cancellations.push(cancel);
    return cancel;
  });
  clock.advance(0);
  if (stopClose) {
    await stopClose;
    expect(cancellations).toHaveLength(1);
    expect(cancellations[0]).toHaveBeenCalledTimes(1);
  } else expect(count()).toBe(mode === 'continue' ? 2001 : 1000);
  const sweeps = calls.mock.calls.filter(c => c[2] === 'attention.retain');
  expect(sweeps.map(c => c[3])).toEqual(mode === 'continue' || mode === 'fold' ? [{}, { after: 1000 }, { after: 2000 }] : mode === 'revoke' ? [{}, { after: 1000 }] : [{}]);
  if (mode === 'revoke' || mode === 'fold') {
    if (mode === 'revoke') expect(warning).toHaveBeenCalledWith('Attention retention failed (denied)');
    else expect(warning).not.toHaveBeenCalled();
    denied.value = false; denied.fold = false; clock.advance(86_400_000);
    expect(count()).toBe(2001);
  }
});
