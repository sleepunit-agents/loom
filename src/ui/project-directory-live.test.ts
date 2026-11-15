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

it('publishes a whole initially empty directory so a stale page cannot retain an archived last card', async () => {
  fixture.cleared = false; fixture.more = false; fixture.keys = []; fixture.records = new Map();
  const listener = vi.fn(); const off = watchProjects('csrf', listener);
  await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(new Set(), new Map()));
  expect(projectsLive()).toBe(true); off(); expect(fixture.close).toHaveBeenCalledTimes(1);
});
