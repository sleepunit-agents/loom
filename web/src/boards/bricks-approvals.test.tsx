/** The `approvals` brick: the list of approval requests (docs/specs/boards.md, "The first bricks"). The data hook
 * is a fake and so is `fetch`, which nothing here should call: the list answers nothing. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer does not ship declarations.
import { act, create } from 'react-test-renderer';

const feed = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed }));
import { bricks, brickView, loadBricks, type Params } from './bricks';
import type { Form } from './layout';

// A brick's body is fetched when it is first drawn (./bricks.tsx). Here they are all fetched first, so each draws at once.
await loadBricks();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Node = { type: string; props: Record<string, any>; children: (Node | string)[]; findAll(match: (node: Node) => boolean): Node[]; findAllByType(type: string): Node[] };
let tree: { root: Node; toJSON(): unknown; update(element: unknown): void; unmount(): void } | undefined;
const sent = vi.fn(), reported = vi.fn(), raised = vi.fn();

const card = (id: string, over: object = {}) => ({ id, kind: 'command', target: 'pond/pump', actingFor: 'sam', operation: null, what: `What of ${id}`, why: `Why of ${id}.`, agent: 'art', project: 'pond',
  member: null, conversation: null, state: 'pending', ask: `What of ${id}?`, ifYes: 'yes', ifNo: 'no', details: '', changeSummary: null, askedAt: '2026-11-14T15:00:00Z', decidedBy: null, expiresAt: null, ...over });
const household = card('a-house', { kind: 'setting', operation: 'household.change', what: 'A household change', ask: 'stored ask', ifYes: 'stored yes', ifNo: 'stored no', target: 'stored-target', project: null, askedAt: '2026-11-13T15:00:00Z',
  details: JSON.stringify({ change: 'members.role', member: 'robin', role: 'owner' }) });
const world = { status: 'live', approvals: [] as ReturnType<typeof card>[], record: [] as object[], rules: [] as object[], notices: [] as object[] };
/** The reads the brick made, by their operation's name. */
const reads = () => feed.mock.calls.map((call) => /^query (\w+)/.exec(call[0])![1]);
beforeEach(() => {
  feed.mockReset(); sent.mockReset(); reported.mockReset(); raised.mockReset();
  Object.assign(world, { status: 'live', rules: [], notices: [], record: [{ seq: 4, at: '2026-11-11T16:00:00Z', event: 'deny', approval: 'a-no', agent: 'art', note: 'Denied by Sam in Slack' }],
    approvals: [card('a-2', { askedAt: '2026-11-14T16:00:00Z', kind: 'merge', target: 'github:acme/app#12@abc' }), card('a-1'), household,
      card('a-yes', { state: 'allowed', decidedBy: 'sam', askedAt: '2026-11-10T15:00:00Z' }), card('a-no', { state: 'denied', decidedBy: 'sam', askedAt: '2026-11-11T15:00:00Z' }),
      { ...household, id: 'a-house-done', state: 'allowed', decidedBy: 'lee', askedAt: '2026-11-09T15:00:00Z' }] });
  // Answers each read with only the lists it names, as loom would; the requests with only the fields it names.
  feed.mockImplementation((query: string) => {
    const name = /^query (\w+)/.exec(query)![1];
    if (!['BrickApprovals', 'BrickApprovalRules', 'BrickApprovalNotices'].includes(name)) throw new Error('A read the approvals brick should not make: ' + name);
    if (world.status !== 'live') return { status: world.status };
    const fields = /approvals \{([^}]*)\}/.exec(query)![1].trim().split(/\s+/);
    const lists: Record<string, unknown[]> = { approvals: world.approvals.map((a) => Object.fromEntries(fields.map((f) => [f, (a as Record<string, unknown>)[f]]))),
      approvalRules: world.rules, approvalNotices: world.notices, approvalRecord: world.record };
    return { status: 'live', data: Object.fromEntries(Object.entries(lists).filter(([list]) => new RegExp(`\\b${list} \\{`).test(query))) };
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
  for (const words of ['Why of a-1.', 'pending', 'command', 'Allows', 'command: pond/pump', 'pond', 'Nov 14']) expect(one, words).toContain(words);
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
  for (const state of ['pending', 'answered', 'rules', 'notices']) {
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

// ── The standing rules and the reported steps ────────────────────────────────────────────────────────────────────
const rule = (over: object = {}) => ({ kind: 'merge', scope: 'project:pond', person: '', tier: 'do', setBy: 'sam', setAt: '2026-11-12T15:00:00Z', ...over });
const notice = (id: string, at: string, over: object = {}) => ({ id, agent: 'art', kind: 'command', target: 'pond/pump', what: `Did ${id}`, at, ...over });

it('reads, in each state, only what that state draws', async () => {
  const lists = (query: string) => ['approvals', 'approvalRules', 'approvalNotices', 'approvalRecord'].filter((list) => new RegExp(`\\b${list} \\{`).test(query));
  const asked: Record<string, string[]> = {};
  for (const state of ['pending', 'answered', 'rules', 'notices']) {
    feed.mockClear();
    await draw({ state }, 'primary');
    asked[state] = lists(feed.mock.calls[0][0]);
  }
  expect(asked).toEqual({
    pending: ['approvals', 'approvalRecord'], answered: ['approvals', 'approvalRecord'],
    rules: ['approvals', 'approvalRules'], notices: ['approvals', 'approvalNotices', 'approvalRecord'],
  });
  // Of the requests, the rules read only their ids and states: enough to count those pending.
  feed.mockClear();
  await draw({ state: 'rules' }, 'primary');
  expect(/approvals \{([^}]*)\}/.exec(feed.mock.calls.at(-1)![0])![1].trim()).toBe('id state');
  expect(new Set(reads())).toEqual(new Set(['BrickApprovalRules']));
});

it('lists the standing rules with what, which kind, for whom, the answer and who set it, and changes none of them', async () => {
  world.rules = [rule(), rule({ kind: 'command', scope: '*', person: 'robin', tier: 'ask', setBy: 'lee' }), rule({ kind: 'setting', scope: 'pond/*', tier: 'tell' })];
  await draw({ state: 'rules' }, 'primary');
  expect(text()).toMatch(/^3 standing rules/);
  const [pond, all, pattern] = rowsDrawn();
  for (const words of ['Project pond', 'Merging a pull request', 'set by Sam', 'Nov 12', 'Just do it']) expect(pond, words).toContain(words);
  expect(pond).not.toContain(' · for ');
  for (const words of ['Everything', 'Running a command on a machine', 'for Robin', 'set by Lee', 'Ask me']) expect(all, words).toContain(words);
  for (const words of ['pond/*', 'Changing a setting', 'Tell me after']) expect(pattern, words).toContain(words);
  expect(text()).toContain('A standing rule is made, changed or removed by asking the agent.');
  expect(controls()).toEqual([]);
  expect(handlers()).toEqual([]);
  expect(chips('approval')).toEqual([]);
});

it('draws the rules small as the count and the first few, compact as one line, and says when there are none', async () => {
  world.rules = [1, 2, 3, 4, 5, 6].map((n) => rule({ scope: 'project:p' + n }));
  await draw({ state: 'rules' }, 'side');
  expect(rowsDrawn()).toHaveLength(4);
  expect(text()).toContain('and 2 more');
  expect(text()).not.toContain('set by');
  expect(text()).not.toContain('asking the agent');
  await draw({ state: 'rules' }, 'compact');
  expect(text()).toBe('6 standing rules · 3 pending');
  world.rules = [rule()];
  await draw({ state: 'rules' }, 'compact');
  expect(text()).toBe('1 standing rule · 3 pending');
  world.rules = [];
  for (const form of ['primary', 'side'] as const) {
    await draw({ state: 'rules' }, form);
    expect(text(), form).toContain('0 standing rules');
    expect(text(), form).toContain('No standing rules.');
  }
});

it('lists the reported steps newest first, with the answers and steps the desktop takes from the record, and does nothing', async () => {
  world.notices = [notice('n-old', '2026-11-01T15:00:00Z'), notice('n-new', '2026-11-13T15:00:00Z', { agent: 'moss', kind: 'setting', target: 'measuring' })];
  world.approvals = [...world.approvals, card('a-told', { state: 'used', member: 'sam', target: 'pond/heater' })];
  world.record = [...world.record, { seq: 9, at: '2026-11-12T15:00:00Z', event: 'use', approval: 'a-told', agent: 'art', note: 'Reported step: Heater holds 8 °C' }];
  await draw({ state: 'notices' }, 'primary');
  expect(text()).toMatch(/^4 reported steps/);
  const drawn = rowsDrawn();
  // n-new; the reported step on a-told; the answer quoted from Slack on a-no; n-old.
  expect(drawn).toHaveLength(4);
  for (const words of ['Did n-new', 'Moss · setting · measuring', 'Nov 13']) expect(drawn[0], words).toContain(words);
  for (const words of ['Heater holds 8 °C', 'Art · command · pond/heater']) expect(drawn[1], words).toContain(words);
  expect(drawn[2]).toContain('Denied by Sam in Slack');
  expect(drawn[3]).toContain('Did n-old');
  expect(controls()).toEqual([]);
  expect(handlers()).toEqual([]);
});

it('draws the reported steps small as the first few and compact as one line, says when there are none, and counts those past fifty', async () => {
  world.record = [];
  world.notices = Array.from({ length: 53 }, (_, i) => notice('n-' + String(i).padStart(2, '0'), `2026-11-01T15:${String(i).padStart(2, '0')}:00Z`));
  await draw({ state: 'notices' }, 'primary');
  expect(rowsDrawn()).toHaveLength(50);
  expect(rowsDrawn()[0]).toContain('Did n-52');
  expect(text()).toContain('and 3 earlier, not shown here');
  await draw({ state: 'notices' }, 'side');
  expect(rowsDrawn()).toHaveLength(4);
  expect(text()).toContain('and 49 more');
  await draw({ state: 'notices' }, 'compact');
  expect(text()).toBe('53 reported steps · 3 pending');
  world.notices = [];
  await draw({ state: 'notices' }, 'primary');
  expect(text()).toBe('0 reported stepsNo reported steps.');
});

it('flags itself for a new request in the rules and the steps too, and draws loading and unavailable as the lists do', async () => {
  for (const state of ['rules', 'notices']) {
    await draw({ state }, 'side');
    raised.mockReset();
    world.approvals = [...world.approvals, card('a-new-' + state)];
    await again({ state }, 'side');
    expect(raised.mock.calls, state).toEqual([['New approval']]);
    for (const status of ['loading', 'offline', 'denied']) {
      world.status = status;
      await draw({ state }, 'primary');
      expect(text(), state + status).toBe(status === 'loading' ? 'Loading…' : 'This list of approvals is unavailable.');
    }
    world.status = 'live';
  }
  expect(sent).not.toHaveBeenCalled();
});
