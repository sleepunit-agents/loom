import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h, useSyncExternalStore } from 'react';
// @ts-expect-error Existing renderer dependency has no bundled declarations.
import { act, create } from 'react-test-renderer';
import type { Snapshot } from '../../data';
import { MEMBER_RETENTION_INTERVAL, useMemberRetention } from './member-retention';
const f = vi.hoisted(() => ({ snapshot: { status: 'loading', records: [] } as Snapshot, call: vi.fn(), listeners: new Set<() => void>() }));
vi.mock('../../data', () => ({
  useRecords: () => useSyncExternalStore(fn => { f.listeners.add(fn); return () => { f.listeners.delete(fn); }; }, () => f.snapshot),
  call: f.call,
  callOnce: () => ({ result: Promise.resolve({ ok: true, value: { member: 'owner', agents: [], summaries: [] } }) }),
}));
vi.mock('../../lib/cojeev-motion/use-reduced-motion', () => ({ useReducedMotion: () => true }));
import Home from './home';
import Inbox from './index';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create> | undefined;
beforeEach(() => { vi.useFakeTimers(); f.call.mockReset().mockImplementation(() => ({ result: Promise.resolve({ ok: true, value: { days: 0, turns: 0 } }) })); f.snapshot = { status: 'loading', records: [] }; });
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; vi.useRealTimers(); });
async function publish(status: Snapshot['status']) { await act(async () => { f.snapshot = { status, records: [] }; f.listeners.forEach(fn => fn()); }); }
it.each([Home, Inbox])('mounted desk page invokes retention on live arrival, daily and reconnect, then stops', async Page => {
  await act(async () => { tree = create(h(Page)); });
  expect(f.call).not.toHaveBeenCalled();
  await publish('live');
  expect(f.call).toHaveBeenCalledExactlyOnceWith('attention.retain', {});
  await publish('live'); expect(f.call).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(MEMBER_RETENTION_INTERVAL - 1); });
  expect(f.call).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(f.call).toHaveBeenCalledTimes(2);
  for (const status of ['offline', 'denied', 'loading'] as const) {
    await publish(status);
    await act(async () => { await vi.advanceTimersByTimeAsync(MEMBER_RETENTION_INTERVAL); });
    expect(f.call).toHaveBeenCalledTimes(2);
  }
  await publish('live'); expect(f.call).toHaveBeenCalledTimes(3);
  await act(async () => tree!.unmount()); tree = undefined;
  await act(async () => { await vi.advanceTimersByTimeAsync(MEMBER_RETENTION_INTERVAL); });
  expect(f.call).toHaveBeenCalledTimes(3);
});
function Harness() { useMemberRetention('live'); return null; }
it('does not overlap a pending sweep, ignores result records and retries failure on the next day', async () => {
  let finish!: (value: unknown) => void;
  f.call.mockImplementationOnce(() => ({ result: new Promise(resolve => { finish = resolve; }) }));
  await act(async () => { tree = create(h(Harness)); });
  await act(async () => { await vi.advanceTimersByTimeAsync(2 * MEMBER_RETENTION_INTERVAL); });
  expect(f.call).toHaveBeenCalledTimes(1);
  await act(async () => finish({ ok: false, message: 'PRIVATE' }));
  f.call.mockImplementationOnce(() => ({ result: Promise.reject(new Error('PRIVATE')) }));
  await act(async () => { await vi.advanceTimersByTimeAsync(MEMBER_RETENTION_INTERVAL); });
  expect(f.call).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(MEMBER_RETENTION_INTERVAL); });
  expect(f.call).toHaveBeenCalledTimes(3);
  expect(tree!.toJSON()).toBeNull();
});
it('unmount cancels future sweeps while an already sent request can finish', async () => {
  let finish!: () => void;
  f.call.mockImplementationOnce(() => ({ result: new Promise<void>(resolve => { finish = resolve; }) }));
  await act(async () => { tree = create(h(Harness)); });
  await act(async () => tree!.unmount()); tree = undefined;
  await act(async () => { finish(); await vi.advanceTimersByTimeAsync(2 * MEMBER_RETENTION_INTERVAL); });
  expect(f.call).toHaveBeenCalledTimes(1);
});
