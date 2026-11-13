import { expect, it, vi } from 'vitest';
import { waitChecks } from './wait-checks';
import type { Ask } from './model';
const ask = (id: string, fields: Partial<Ask> = {}): Ask => ({ id, ask: 'Continue?', source: { kind: 'piece', id: 'test' }, state: 'open', createdAt: 1, changedAt: 1, waits_on: { task: 't-1' }, ...fields });
const live = (...records: Ask[]) => ({ status: 'live' as const, records });
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
it('checks only unmanaged open waits, once per version and again with fresh calls on a sweep', async () => {
  const check = vi.fn(async () => ({ ok: true })), worker = waitChecks(check);
  const snapshot = live(ask('task'), ask('approval', { waits_on: { approval: 'a-12345678' }, member: 'owner' }), ask('managed', { sourceManaged: true }), ask('answered', { state: 'answered' }), ask('resolved', { state: 'resolved' }), ask('ordinary', { waits_on: undefined }));
  worker.update(snapshot); await tick();
  expect(check.mock.calls).toEqual([['task'], ['approval']]);
  worker.update({ ...snapshot }); await tick(); expect(check).toHaveBeenCalledTimes(2);
  worker.update(live(ask('task', { changedAt: 2 }))); await tick(); expect(check).toHaveBeenCalledTimes(3);
  worker.sweep(); await tick(); expect(check).toHaveBeenCalledTimes(4);
  worker.stop(); worker.sweep(); await tick(); expect(check).toHaveBeenCalledTimes(4);
});
it('serializes pending requests and skips removed or hidden asks before the next call', async () => {
  let finish!: () => void;
  const check = vi.fn(() => new Promise<void>(resolve => { finish = resolve; })), worker = waitChecks(check);
  worker.update(live(ask('first'), ask('gone'))); worker.sweep(); worker.update(live(ask('first'), ask('new')));
  expect(check.mock.calls).toEqual([['first']]);
  worker.update({ status: 'denied', records: [] }); finish(); await tick(); expect(check).toHaveBeenCalledTimes(1);
  worker.update(live(ask('new'))); expect(check.mock.calls).toEqual([['first'], ['new']]);
  worker.stop(); finish(); await tick(); expect(check).toHaveBeenCalledTimes(2);
});
it('holds refusals and exceptions until a sweep or reconnect, without using returned records', async () => {
  const check = vi.fn().mockRejectedValueOnce(new Error('PRIVATE')).mockResolvedValue({ ok: false, message: 'PRIVATE' });
  const worker = waitChecks(check), snapshot = live(ask('wait'));
  worker.update(snapshot); await tick(); worker.update(snapshot); await tick(); expect(check).toHaveBeenCalledTimes(1);
  worker.sweep(); await tick(); expect(check).toHaveBeenCalledTimes(2);
  worker.update({ status: 'offline', records: snapshot.records }); worker.sweep(); await tick(); expect(check).toHaveBeenCalledTimes(2);
  worker.update(snapshot); await tick(); expect(check).toHaveBeenCalledTimes(3);
  expect(snapshot.records[0].state).toBe('open'); worker.stop();
});
