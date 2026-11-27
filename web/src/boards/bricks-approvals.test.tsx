/** The `approvals` brick: the list of approval requests (docs/specs/boards.md, "The first bricks"). The data hook
 * is a fake and so is `fetch`, which nothing here should call: the list answers nothing. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer does not ship declarations.
import { act, create } from 'react-test-renderer';

const feed = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed }));
import { bricks, brickView, type Params } from './bricks';
import type { Form } from './layout';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Node = { type: string; props: Record<string, any>; children: (Node | string)[]; findAll(match: (node: Node) => boolean): Node[]; findAllByType(type: string): Node[] };
let tree: { root: Node; toJSON(): unknown; update(element: unknown): void; unmount(): void } | undefined;
const sent = vi.fn(), reported = vi.fn(), raised = vi.fn();

const card = (id: string, over: object = {}) => ({ id, kind: 'command', target: 'pond/pump', actingFor: 'sam', operation: null, what: `What of ${id}`, why: `Why of ${id}.`, agent: 'art', project: 'pond',
  member: null, conversation: null, state: 'pending', ask: `What of ${id}?`, ifYes: 'yes', ifNo: 'no', details: '', changeSummary: null, askedAt: '2026-11-14T15:00:00Z', decidedBy: null, expiresAt: null, ...over });
const household = card('a-house', { kind: 'setting', operation: 'household.change', what: 'A household change', ask: 'stored ask', ifYes: 'stored yes', ifNo: 'stored no', target: 'stored-target', project: null, askedAt: '2026-11-13T15:00:00Z',
  details: JSON.stringify({ change: 'members.role', member: 'robin', role: 'owner' }) });
const world = { status: 'live', approvals: [] as ReturnType<typeof card>[], record: [] as object[] };
beforeEach(() => {
  feed.mockReset(); sent.mockReset(); reported.mockReset(); raised.mockReset();
  Object.assign(world, { status: 'live', record: [{ seq: 4, at: '2026-11-11T16:00:00Z', event: 'deny', approval: 'a-no', agent: 'art', note: 'Denied by Sam in Slack' }],
    approvals: [card('a-2', { askedAt: '2026-11-14T16:00:00Z', kind: 'merge', target: 'github:acme/app#12@abc' }), card('a-1'), household,
      card('a-yes', { state: 'allowed', decidedBy: 'sam', askedAt: '2026-11-10T15:00:00Z' }), card('a-no', { state: 'denied', decidedBy: 'sam', askedAt: '2026-11-11T15:00:00Z' }),
      { ...household, id: 'a-house-done', state: 'allowed', decidedBy: 'lee', askedAt: '2026-11-09T15:00:00Z' }] });
  feed.mockImplementation((query: string) => {
    const name = /^query (\w+)/.exec(query)![1];
    if (name !== 'ApprovalsView') throw new Error('A read the approvals brick should not make: ' + name);
    return world.status === 'live' ? { status: 'live', data: { approvals: world.approvals, approvalRules: [], approvalNotices: [], approvalRecord: world.record } } : { status: world.status };
  });
  vi.stubGlobal('fetch', async (url: string) => { sent(url); return { ok: false, status: 500, json: async () => ({ ok: false }) }; });
});
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; vi.unstubAllGlobals(); });

const element = (params: Params, form: Form) => h(brickView('approvals').Body, { params, form, act: reported, raise: raised });
async function draw(params: Params, form: Form) { await act(async () => { tree?.unmount(); tree = create(element(params, form)); }); }
const again = (params: Params, form: Form) => act(async () => { tree!.update(element(params, form)); });
const said = (node: Node): string => node.children.map((child) => (typeof child === 'string' ? child : said(child))).join('');
const text = () => said(tree!.root as Node);
const controls = () => tree!.root.findAll((node) => ['button', 'input', 'textarea', 'form', 'a', 'select', 'details'].includes(node.type) && !node.props['data-place']);
const handlers = () => tree!.root.findAll((node) => typeof node.type === 'string' && Object.keys(node.props).some((key) => /^on[A-Z]/.test(key)));
const chips = (brick: string) => tree!.root.findAll((node) => !!node.props['data-place']).map((node) => [JSON.parse(node.props['data-place']), said(node)] as const).filter(([place]) => place.brick === brick);
const rowsDrawn = () => tree!.root.findAllByType('li').map(said);

it('lists every pending request oldest first with what, why, agent and target, each with a chip that opens it, and answers nothing', async () => {
  await draw({ state: 'pending' }, 'primary');
  expect(text()).toContain('3 pending');
  expect(chips('approval')).toEqual([[{ brick: 'approval', params: { approval: 'a-house' } }, 'A household change'],
    [{ brick: 'approval', params: { approval: 'a-1' } }, 'What of a-1'], [{ brick: 'approval', params: { approval: 'a-2' } }, 'What of a-2']]);
  expect(chips('agent').map(([place]) => place.params)).toEqual([{ agent: 'art' }, { agent: 'art' }, { agent: 'art' }]);
  const [house, one, two] = rowsDrawn();
  for (const words of ['Why of a-1.', 'pending', 'command', 'Allows', 'command: pond/pump', 'pond', 'Nov 14, 2026']) expect(one, words).toContain(words);
  expect(two).toContain('merge: github:acme/app#12@abc');
  // A household change is said by its title and its reason; the other words stored with it are not shown.
  expect(house).toContain('Why of a-house.');
  for (const stored of ['stored ask', 'stored yes', 'stored no', 'stored-target', 'Allows']) expect(house, stored).not.toContain(stored);
  expect(text()).not.toContain('Answer');
  expect(controls()).toEqual([]);
  expect(handlers()).toEqual([]);
});

it('lists the answered ones newest first with the outcome and who answered', async () => {
  await draw({ state: 'answered' }, 'primary');
  expect(text()).toContain('3 answered');
  expect(chips('approval').map(([place]) => place.params.approval)).toEqual(['a-no', 'a-yes', 'a-house-done']);
  const [no, yes, house] = rowsDrawn();
  // An answer quoted from a conversation is said in the record's own words.
  for (const words of ['denied', 'Denied by Sam in Slack', 'Why of a-no.']) expect(no, words).toContain(words);
  for (const words of ['allowed', 'Answered by Sam']) expect(yes, words).toContain(words);
  // For a household change the desktop says the outcome and not who, to a member with no reading of it.
  expect(house).toContain('allowed');
  expect(house).not.toContain('Answered by');
  expect(controls()).toEqual([]);
  expect(handlers()).toEqual([]);
});

it('takes pending when it is given no state or an unknown one', async () => {
  for (const params of [{}, { state: 'history' }]) { await draw(params, 'side'); expect(text()).toContain('3 pending'); }
  world.approvals = [];
  await draw({ state: 'pending' }, 'primary');
  expect(text()).toBe('0 pendingNo approvals are waiting.');
  await draw({ state: 'answered' }, 'side');
  expect(text()).toBe('0 answeredNo answered approvals.');
});

it('draws the side form as the count and the first few, each a chip, and the compact form as one line of counts', async () => {
  world.approvals = [1, 2, 3, 4, 5, 6].map((n) => card('a-' + n, { askedAt: `2026-11-1${n}T15:00:00Z` }));
  await draw({ state: 'pending' }, 'side');
  expect(text()).toContain('6 pending');
  expect(chips('approval').map(([place]) => place.params.approval)).toEqual(['a-1', 'a-2', 'a-3', 'a-4']);
  expect(text()).toContain('and 2 more');
  expect(controls()).toEqual([]);
  world.approvals = [card('a-1'), card('a-2', { state: 'used' }), card('a-3', { state: 'expired' })];
  await draw({ state: 'answered' }, 'compact');
  const json = tree!.toJSON() as { type: string; props: { className: string } };
  expect([json.type, json.props.className]).toEqual(['p', 'board-brief']);
  expect(text()).toBe('1 pending · 2 answered');
  expect(controls()).toEqual([]);
  expect(chips('approval')).toEqual([]);
});

it('draws loading until the list answers and unavailable when the member may not read it', async () => {
  for (const form of ['primary', 'side', 'compact'] as const) {
    world.status = 'loading';
    await draw({ state: 'pending' }, form);
    expect(text(), form).toBe('Loading…');
    for (const status of ['offline', 'denied']) {
      world.status = status;
      await draw({ state: 'pending' }, form);
      expect(text(), form + status).toBe('This list of approvals is unavailable.');
      expect(controls()).toEqual([]);
    }
  }
});

it('heads the brick by its name and shows the state only in the small line', () => {
  for (const state of ['pending', 'answered']) {
    expect(bricks.approvals.title({ state })).toBe('Approvals');
    expect(bricks.approvals.sub({ state })).toBe(state);
  }
});

it('flags itself when a new request is waiting, and not when one is answered', async () => {
  await draw({ state: 'answered' }, 'side');
  expect(raised).not.toHaveBeenCalled();
  const pending = (n: number) => Array.from({ length: n }, (_, i) => card('a-p' + i));
  for (const [count, flag] of [[3, null], [2, null], [3, 'New approval'], [3, null], [0, null], [1, 'New approval']] as const) {
    raised.mockReset();
    world.approvals = [...pending(count), card('a-done', { state: 'allowed' })];
    await again({ state: 'answered' }, 'side');
    if (flag) expect(raised.mock.calls, String(count)).toEqual([[flag]]); else expect(raised, String(count)).not.toHaveBeenCalled();
  }
  expect(sent).not.toHaveBeenCalled();
  expect(reported).not.toHaveBeenCalled();
});
