/** The `machines` brick (docs/specs/boards.md, "The first bricks"). The data hook is a fake and so is `fetch`:
 * what is checked is what is drawn, the request loom would receive, and what the board is told. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer does not ship declarations.
import { act, create } from 'react-test-renderer';

const feed = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed }));
import { bricks, brickView, loadBricks } from './bricks';
import type { Form } from './layout';

await loadBricks();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Node = { type: string; props: Record<string, any>; children: (Node | string)[]; findAll(match: (node: Node) => boolean): Node[]; findAllByType(type: string): Node[] };
let tree: { root: Node; toJSON(): unknown; unmount(): void } | undefined;
const sent = vi.fn(), reported = vi.fn();
let ok = true;
const at = new Date(Date.now() - 60_000).toISOString();
const history = [{ id: 'r1', agent: 'art', job: 'j-9', conversation: 'cv-read-1', word: 'asked', person: null, read: 'disk', args: '{}', askedAt: at, bytes: 12, outcome: 'answered' }];
const cards = [{ id: 'card-1', ask: 'Let bea read Den?', review: 'a'.repeat(64) }];
beforeEach(() => {
  feed.mockReset(); sent.mockReset(); reported.mockReset(); ok = true;
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    sent(url, JSON.parse(init.body).input);
    const value = url.endsWith('/history') ? history : url.endsWith('/readerCards') ? cards : { id: 'x', state: 'pending' };
    return { ok, status: ok ? 200 : 403, json: async () => (ok ? { ok: true, value } : { ok: false }) };
  });
});
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; vi.unstubAllGlobals(); });

const hosting = { revokedAt: null, hostsAny: true, reportOnly: false, boxAgentsByBox: [{ agent: 'art', lent: false }, { agent: 'bea', lent: true }] };
const boxes = [
  { id: 'box-1', name: 'Den', owner: 'sam', ...hosting },
  { id: 'box-2', name: 'Attic', owner: 'lee', ...hosting, reportOnly: true, boxAgentsByBox: [] },
  { id: 'box-3', name: 'Old', owner: 'sam', ...hosting, revokedAt: at },
];
const reading = (over: object) => ({ box: 'box-1', kind: 'disk', thing: '/', usedPercent: 91, sizeMib: 100000, freeMib: 9000, engineStatus: null, level: 'raised', readAt: at, unknownSince: null, stale: false, ...over });
type World = { inventory?: object | null; mine?: object; facts?: object; owner?: boolean; jobs?: object; loading?: boolean };
const answer = (w: World = {}) => feed.mockImplementation((query: string, variables?: Record<string, string>, options?: { pause?: boolean }) => {
  if (options?.pause) return { status: 'loading' };
  if (w.loading) return { status: 'loading' };
  if (query.includes('account { member }')) return w.inventory === null ? { status: 'error' } : { status: 'live', data: w.inventory ?? { account: { member: 'sam' }, agents: [{ id: 'art', removedAt: null }, { id: 'bea', removedAt: null }, { id: 'gone', removedAt: at }], boxes,
    modelAccounts: [{ logins: [{ box: { id: 'box-1' }, needsSignIn: true }] }, {}] } };
  if (query.startsWith('query OwnerMachines')) return { status: 'live', data: w.mine ?? { boxes: boxes.map((b) => ({ ...b, readers: b.id === 'box-1' ? ['art'] : null, readingsLeftOut: b.id === 'box-1' ? 2 : 0 })),
    boxReadings: [reading({}), reading({ kind: 'memory', thing: '', level: 'ok', freeMib: 2048 }), reading({ box: 'box-2', level: 'ok', usedPercent: 10 })], agents: [{ id: 'art' }, { id: 'bea' }] } };
  if (query.startsWith('query BrickMachineFacts')) return { status: 'live', data: w.facts ?? { boxes: [{ id: 'box-1', sameMachineAsLoom: true, lastSeenAt: at, slots: 3 }, { id: 'box-2', sameMachineAsLoom: false, lastSeenAt: null, slots: null }],
    boxAlertSettings: [{ diskPercent: 85, diskUrgentPercent: 95, diskFreeMib: 1024, memoryFreeMib: 512 }] } };
  if (query.startsWith('query BrickHouseholdOwner')) return { status: 'live', data: { householdSetup: w.owner === false ? null : { defaultAgent: 'art' } } };
  if (query.startsWith('query BrickMachineJobs')) {
    expect(variables).toEqual({ a0: 'art', a1: 'bea' });
    return { status: 'live', data: w.jobs ?? {
      j0: [{ id: 'j-1', agent: 'art', title: 'Mend the fence', state: 'running', box: 'box-1', conversation: 'cv-fence-1', queuedAt: at }, { id: 'j-2', agent: 'art', title: 'Done one', state: 'done', box: 'box-1', conversation: 'cv-x', queuedAt: at },
        { id: 'j-3', agent: 'art', title: 'Elsewhere', state: 'running', box: 'box-2', conversation: 'cv-y', queuedAt: at }, { id: 'j-4', agent: 'art', title: '', state: 'queued', box: 'box-1', conversation: null, queuedAt: at }],
      p0: [], j1: [], p1: [{ id: 'j-5', agent: 'bea', box: 'box-1', state: 'running', queuedAt: at }] } };
  }
  throw new Error('A read the machines brick should not make: ' + query);
});
async function draw(form: Form) {
  await act(async () => { tree?.unmount(); tree = create(h(brickView('machines').Body, { params: {}, form, act: reported, raise: () => {} })); });
}
const said = (node: Node): string => node.children.map((child) => (typeof child === 'string' ? child : said(child))).join('');
const shown = () => said(tree!.root as Node);
const buttons = () => tree!.root.findAllByType('button').filter((b) => !b.props['data-place']);
const controls = () => tree!.root.findAll((node) => ['button', 'input', 'textarea', 'form', 'a', 'select'].includes(node.type) && !node.props['data-place']);
const placed = () => tree!.root.findAll((node) => !!node.props['data-place']).map((node) => JSON.parse(node.props['data-place']));
const press = (label: string) => act(async () => { await buttons().find((b) => said(b) === label)!.props.onClick(); });

it('lists every machine the member may read with its facts, readings and open alerts in the desktop\'s words', async () => {
  answer();
  await draw('primary');
  expect(shown()).toContain('2 machines · 1 open alert');
  for (const words of ['Den', 'The loom machine', 'last seen', 'A sign-in needs attention', '/ is running out of room: 91% full, 8.7 GB free.', 'Disk 91% · 8.7 GB free · Memory 2 GB available',
    'More than 24 things reported; 2 were left out.', 'Attic', 'never seen', 'Old', 'Revoked', 'Enrolling or revoking a machine is not done from a board.']) expect(shown(), words).toContain(words);
  expect(buttons().map(said).slice(0, 3)).toEqual(['Den', 'Attic', 'Old']);
  expect(sent).not.toHaveBeenCalled();
});

it('opens one machine: hosting, slots, the jobs on it now as session chips, its read grants, pending requests and read history', async () => {
  answer();
  await draw('primary');
  await press('Den');
  for (const words of ['Listed agents and agents of the owner', 'art, bea (lent)', 'Mend the fence', 'Untitled job', 'Private conversation', 'Let bea read Den?', 'Updated to show the current readers.', 'answered · 12 bytes'])
    expect(shown(), words).toContain(words);
  expect(shown()).not.toContain('Done one'); expect(shown()).not.toContain('Elsewhere');
  expect(placed()).toContainEqual({ brick: 'session', params: { session: 'cv-fence-1' } });
  expect(placed()).toContainEqual({ brick: 'session', params: { session: 'cv-read-1' } });
  expect(placed()).toContainEqual({ brick: 'person', params: { person: 'member:sam' } });
  expect(sent.mock.calls).toEqual([['/api/machine/history', { machine: 'box-1' }], ['/api/machine/readerCards', { machine: 'box-1' }]]);
  expect(reported).not.toHaveBeenCalled();
  // Another member's machine shows what it hosts and its jobs, and none of the owner's settings.
  sent.mockClear();
  await press('Attic');
  expect(shown()).toContain('Reporting only'); expect(shown()).toContain('Not reported');
  expect(shown()).not.toContain('Read history');
  expect(sent).not.toHaveBeenCalled();
});

it('requests a read grant and a revocation with machine.proposeReader, and answers a request with machine.answerReader', async () => {
  answer();
  await draw('primary');
  await press('Den');
  sent.mockClear();
  await press('Request revocation for art');
  expect(sent.mock.calls[0]).toEqual(['/api/machine/proposeReader', { box: 'box-1', agent: 'art', allow: false }]);
  expect(reported).toHaveBeenLastCalledWith('proposeReader', { allow: 'no' });
  expect(buttons().find((b) => said(b) === 'Request read grant')!.props.disabled).toBe(true);
  await press('bea');
  sent.mockClear();
  await press('Request read grant');
  expect(sent.mock.calls[0]).toEqual(['/api/machine/proposeReader', { box: 'box-1', agent: 'bea', allow: true }]);
  expect(reported).toHaveBeenLastCalledWith('proposeReader', { allow: 'yes' });
  sent.mockClear();
  await press('Allow');
  expect(sent.mock.calls[0]).toEqual(['/api/machine/answerReader', { id: 'card-1', answer: 'allow', review: 'a'.repeat(64) }]);
  expect(reported).toHaveBeenLastCalledWith('answerReader', { answer: 'allow' });
  sent.mockClear();
  await press('Deny');
  expect(sent.mock.calls[0]).toEqual(['/api/machine/answerReader', { id: 'card-1', answer: 'deny' }]);
  expect(reported).toHaveBeenLastCalledWith('answerReader', { answer: 'deny' });
  expect(JSON.stringify(reported.mock.calls)).not.toMatch(/box-1|art|bea|card-1/);
  // A refused change reports nothing.
  ok = false; reported.mockClear();
  await press('Deny');
  expect(reported).not.toHaveBeenCalled();
  expect(shown()).toContain('Could not change the read grant.');
});

const input = (label: string) => tree!.root.findAllByType('label').find((l) => said(l) === label)!.findAllByType('input')[0];
const submit = () => act(async () => tree!.root.findAllByType('form')[0].props.onSubmit({ preventDefault() {} }));
it('lets a household owner save the alert lines with machine.setAlertLines, checked as the desktop checks them', async () => {
  answer();
  await draw('primary');
  expect(input('Disk usage alert (%)').props.value).toBe('85');
  await act(async () => input('Disk usage alert (%)').props.onChange({ target: { value: '96' } }));
  await submit();
  expect(shown()).toContain('The urgent disk threshold must be higher than the disk alert threshold.');
  await act(async () => input('Disk usage alert (%)').props.onChange({ target: { value: '9' } }));
  await submit();
  expect(shown()).toContain('Disk usage alert (%) must be a whole number from 10 to 99.');
  expect(sent).not.toHaveBeenCalled();
  await act(async () => input('Disk usage alert (%)').props.onChange({ target: { value: '80' } }));
  await submit();
  expect(sent).toHaveBeenCalledWith('/api/machine/setAlertLines', { diskPercent: 80 });
  expect(reported).toHaveBeenCalledWith('setAlertLines', {});
  expect(shown()).toContain('Saved');
});

it('shows anyone else the alert lines without a way to change them', async () => {
  answer({ owner: false });
  await draw('primary');
  expect(shown()).toContain('Disk usage alert (%): 85');
  expect(shown()).toContain('A household owner changes these.');
  expect(tree!.root.findAllByType('form')).toEqual([]);
  expect(tree!.root.findAllByType('input')).toEqual([]);
});

it('draws the side form as a list and the compact form as one line, neither with a control', async () => {
  answer();
  await draw('side');
  for (const words of ['2 machines · 1 open alert', 'Den', 'The loom machine', '3 slots', '/ is running out of room']) expect(shown(), words).toContain(words);
  expect(controls()).toEqual([]);
  await draw('compact');
  const json = tree!.toJSON() as { type: string; props: { className: string } };
  expect(json.type).toBe('p'); expect(json.props.className).toBe('board-brief');
  expect(shown()).toBe('2 machines · 1 open alert');
  expect(controls()).toEqual([]);
});

it('says the list is unavailable to someone loom gives no account, says so for no machines, and loading until loom answers', async () => {
  for (const form of ['primary', 'side', 'compact'] as const) {
    for (const inventory of [null, { account: null, agents: [], boxes: [] }]) {
      answer({ inventory });
      await draw(form);
      expect(shown(), form).toBe('This list of machines is unavailable.');
      expect(controls()).toEqual([]);
    }
    answer({ loading: true });
    await draw(form);
    expect(shown(), form).toBe('Loading…');
  }
  answer({ inventory: { account: { member: 'kim' }, agents: [], boxes: [] }, mine: { boxes: [], boxReadings: [], agents: [] }, facts: { boxes: [], boxAlertSettings: [] } });
  await draw('primary');
  expect(shown()).toContain('No machines are visible to this account.');
  expect(sent).not.toHaveBeenCalled();
});

it('is headed by its name', () => {
  expect(bricks.machines.title({})).toBe('Machines');
  expect(bricks.machines.sub({})).toBe('');
});
