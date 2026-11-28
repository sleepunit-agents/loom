/** Gallery fixtures for the `tickets` brick (development only; ../scenes.ts): the household's tickets across its
 * projects, a state at a time. The same household as ./work.ts: garden is in use, pond is retired. */
import type { Answer, BrickScenes } from '../scenes';

const row = (id: string, title: string, over: Record<string, unknown> = {}) => ({ id, title, status: 'open', closeReason: null, priority: 2, project: 'garden', projectRow: { name: 'Garden' },
  assigneeKind: null, assignee: null, isReady: true, isShelved: false, ...over });
const ready = [
  row('t-12', 'Replace the pump filter', { priority: 0 }),
  row('t-13', 'Test the soil pH in every bed and write the numbers into the garden notes', { priority: 1 }),
  row('t-7', 'Mulch the fruit trees'),
  row('t-10', 'Net the brassicas against pigeons'),
  row('t-14', 'Prune the old apple'),
  row('t-53', 'Borrow a ladder', { project: null, projectRow: null }),
  row('t-16', 'Clear the bindweed from behind the greenhouse', { project: 'greenhouse', projectRow: { name: 'Greenhouse' } }),
  row('t-17', 'Sow the broad beans', { priority: 3 }),
];
const working = [
  row('t-3', 'Work out why the drip line on the south fence loses pressure after the third emitter, and replace whatever is clogged', { status: 'in_progress', isReady: false, assigneeKind: 'agent', assignee: 'moss' }),
  row('t-1', 'Raise the north bed and line it before the first frost', { status: 'in_progress', isReady: false, assigneeKind: 'agent', assignee: 'fern' }),
  row('t-52', 'Find out whether the council still collects green waste in January', { status: 'in_progress', isReady: false, project: null, projectRow: null, assigneeKind: 'member', assignee: 'alex' }),
];
const shelved = [
  row('t-30', 'Old orchard plan', { project: 'pond', projectRow: { name: 'Pond' }, isShelved: true, isReady: false }),
  row('t-31', 'Fit the pond pump timer', { status: 'in_progress', project: 'pond', projectRow: { name: 'Pond' }, isShelved: true, isReady: false, assigneeKind: 'agent', assignee: 'moss' }),
];
const every = [working[0], row('t-8', 'Fix the gate latch', { status: 'closed', closeReason: 'done', isReady: false }), ...ready.slice(0, 3), shelved[0], row('t-54', 'Return the hired rotavator', { status: 'closed', closeReason: 'cancelled', isReady: false, project: null, projectRow: null }), ...working.slice(1), ...ready.slice(3)];
const pages = (rows: unknown[]) => ({ rows: Array.from({ length: 31 }, (_, i) => ({ ...(rows[i % rows.length] as object), id: `t-${300 + i}` })) });
const data = (over: Record<string, Answer> = {}): Record<string, Answer> => ({
  BrickTicketsRetired: { retired: [{ id: 'pond' }] }, BrickTicketsReady: { rows: ready }, BrickTicketsAll: { rows: every },
  BrickTicketsOpen: (v: Record<string, unknown>) => ({ rows: JSON.stringify(v.where).includes('"inArray"') ? shelved : working }), ...over,
});

export const scenes: BrickScenes[] = [
  { brick: 'tickets', scenes: [
    { name: 'default', params: { state: 'ready' }, data: data() },
    { name: 'in-progress', params: { state: 'in-progress' }, data: data() },
    { name: 'shelved', params: { state: 'shelved' }, only: ['primary', 'side'], data: data() },
    { name: 'all', params: { state: 'all' }, data: data() },
    { name: 'more', params: { state: 'ready' }, only: ['primary', 'compact'], data: data({ BrickTicketsReady: pages(ready) }) },
    { name: 'empty', params: { state: 'ready' }, data: data({ BrickTicketsReady: { rows: [] } }) },
    { name: 'none-retired', params: { state: 'shelved' }, only: ['side'], data: data({ BrickTicketsRetired: { retired: [] } }) },
    { name: 'unavailable', params: { state: 'ready' }, only: ['side', 'primary'], data: data({ BrickTicketsReady: 'offline' }) },
    { name: 'loading', params: { state: 'ready' }, only: ['side'], data: data({ BrickTicketsReady: 'loading' }) },
  ] },
];
