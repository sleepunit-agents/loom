import { it, expect, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ status: 'live', more: true, cleared: false, keys: ['loom/project/art:p'],
  records: new Map<string, { key: string }>([['loom/project/art:p', { key: 'loom/project/art:p' }]]),
  changed: () => {}, next: vi.fn(), close: vi.fn(), specs: [] as unknown[] }));
vi.mock('../../web/src/page', () => ({ collectionsRuntime: async () => ({ runtime: {
  isCleared: () => fixture.cleared, records: () => fixture.records,
  view: (spec: unknown, changed: () => void) => { fixture.specs.push(spec); fixture.changed = changed;
    return { state: () => ({ keys: fixture.keys, status: fixture.status, more: fixture.more, withheld: [] }), close: fixture.close, more: fixture.next }; },
} }) }));
import { watchProjects, projectsLive, PROJECTS_SPEC } from '../../web/src/tasks-live';
it('shares a paged directory, drops partial/stale snapshots, publishes empty membership and recovers after reconnect', async () => {
  const first = vi.fn(); const off = watchProjects('csrf', first);
  await vi.waitFor(() => expect(fixture.next).toHaveBeenCalledTimes(1));
  expect(first).not.toHaveBeenCalled();
  expect(projectsLive()).toBe(false);
  fixture.more = false; fixture.changed();
  expect(first).toHaveBeenLastCalledWith(new Set(fixture.keys), fixture.records);
  const second = vi.fn(); const off2 = watchProjects('csrf', second);
  expect(second).toHaveBeenLastCalledWith(new Set(fixture.keys), fixture.records);
  expect(fixture.specs).toEqual([PROJECTS_SPEC]);
  fixture.status = 'stale'; fixture.changed();
  expect(projectsLive()).toBe(false);
  expect(second).toHaveBeenLastCalledWith(new Set(), new Map());
  fixture.keys = []; fixture.records = new Map(); fixture.status = 'live'; fixture.changed();
  expect(projectsLive()).toBe(true);
  expect(second).toHaveBeenLastCalledWith(new Set(), new Map());
  fixture.cleared = true; fixture.changed();
  expect(projectsLive()).toBe(false);
  off2(); off(); expect(fixture.close).not.toHaveBeenCalled();
});
it('publishes a whole initially empty directory so a stale page cannot retain an archived last card', async () => {
  fixture.cleared = false; fixture.more = false; fixture.keys = []; fixture.records = new Map();
  const listener = vi.fn(); const off = watchProjects('csrf', listener);
  await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(new Set(), new Map()));
  expect(projectsLive()).toBe(true); off(); expect(fixture.close).toHaveBeenCalledTimes(1);
});
