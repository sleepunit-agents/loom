import { it, expect, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  status: 'live', cleared: false, callbacks: [] as Array<() => void>,
  records: new Map([['tasks/task/t-1', { key: 'tasks/task/t-1', title: 'Current title', status: 'open' }]]),
}));
vi.mock('../../web/src/page', () => ({ collectionsRuntime: async () => ({ runtime: {
  isCleared: () => fixture.cleared,
  records: () => fixture.records,
  view: (_spec: unknown, changed: () => void) => {
    fixture.callbacks.push(changed);
    return { state: () => ({ keys: [...fixture.records.keys()], status: fixture.status, more: false, withheld: [] }), close: () => {}, more: () => {} };
  },
} }) }));
import { watchTasks } from '../../web/src/tasks-live';

it('a chip opening after Work gets the warm snapshot; losing freshness drops the derived copy and recovery restores it', async () => {
  const first = vi.fn();
  const stopFirst = watchTasks('csrf', first);
  await vi.waitFor(() => expect(first).toHaveBeenCalled());
  const ordinary = vi.fn();
  const stopOrdinary = watchTasks('csrf', ordinary);
  expect(ordinary).not.toHaveBeenCalled();
  const chip = vi.fn();
  const stopChip = watchTasks('csrf', chip, true);
  expect(chip).toHaveBeenLastCalledWith(new Set(['tasks/task/t-1']), fixture.records);
  fixture.status = 'stale';
  fixture.callbacks[0]();
  expect(chip).toHaveBeenLastCalledWith(new Set(), new Map());
  expect(ordinary).not.toHaveBeenCalled();
  fixture.status = 'live';
  fixture.callbacks[0]();
  expect(chip).toHaveBeenLastCalledWith(new Set(['tasks/task/t-1']), fixture.records);
  const ordinaryCalls = ordinary.mock.calls.length;
  fixture.cleared = true;
  fixture.callbacks[0]();
  expect(chip).toHaveBeenLastCalledWith(new Set(), new Map());
  expect(ordinary).toHaveBeenCalledTimes(ordinaryCalls);
  stopChip(); stopOrdinary(); stopFirst();
});
