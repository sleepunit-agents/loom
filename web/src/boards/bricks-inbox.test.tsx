/** The `inbox` brick: the member's Inbox as a list (docs/specs/boards.md, "The first bricks"). The data hook is a
 * fake; the member's operations go to a fake fetch, so what is checked is the request loom would receive. */
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
let ok = true;

const row = (id: string, over: object = {}) => ({ id, canAnswer: true, source: 'thread', agent: 'art', project: 'pond', at: '2026-11-14T20:00:00Z', state: 'waiting', volume: 'full', answers: 'yes-no',
  read: true, refs: [], body: { words: `Words of ${id}?`, why: `Why of ${id}.` }, ...over });
const counts = { needs: 3, alerts: 1, answered: 7, fyi: 2, all: 12, agents: [{ id: 'art', count: 9 }] };
const world = { status: 'live', items: [] as object[], folders: counts, results: [] as object[], approvals: [] as object[], titles: [] as object[] };
beforeEach(() => {
  feed.mockReset(); sent.mockReset(); reported.mockReset(); raised.mockReset(); ok = true;
  Object.assign(world, { status: 'live', folders: counts, results: [], approvals: [], titles: [],
    items: [row('in-old', { at: '2026-11-13T08:00:00Z' }), row('in-new', { at: '2026-11-14T15:00:00Z', read: false, agent: null, fromId: 'sam' }), row('in-quiet', { at: '2026-11-12T08:00:00Z', volume: 'dim', body: { words: 'First line\nSecond line', why: 'Quiet why.' } }),
      row('in-hidden', { volume: 'mute' })] });
  feed.mockImplementation((query: string, variables: Record<string, unknown>, options?: { pause?: boolean }) => {
    const name = /^query (\w+)/.exec(query)![1];
    if (name === 'Inbox') return world.status === 'live' ? { status: 'live', data: { ...(variables.onlyErrors ? {} : { inboxItems: world.items }), inboxFolders: world.folders, inboxActionResults: world.results } } : { status: world.status };
    if (name === 'InboxApprovals') return options?.pause ? { status: 'loading' } : { status: 'live', data: { approvals: world.approvals } };
    if (name === 'InboxProposalTitles') return options?.pause ? { status: 'loading' } : { status: 'live', data: { inboxProposalTitles: world.titles } };
    throw new Error('A read the inbox brick should not make: ' + name);
  });
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    sent(url, JSON.parse(init.body).input);
    return { ok, status: ok ? 200 : 409, json: async () => (ok ? { ok: true, value: { saved: true } } : { ok: false }) };
  });
});
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; vi.unstubAllGlobals(); });

const element = (params: Params, form: Form) => h(brickView('inbox').Body, { params, form, act: reported, raise: raised });
async function draw(params: Params, form: Form) { await act(async () => { tree?.unmount(); tree = create(element(params, form)); }); }
const again = (params: Params, form: Form) => act(async () => { tree!.update(element(params, form)); });
const said = (node: Node): string => node.children.map((child) => (typeof child === 'string' ? child : said(child))).join('');
/** Every word drawn, as one string. */
const text = () => said(tree!.root as Node);
const buttons = () => tree!.root.findAllByType('button').filter((b) => !b.props['data-place']);
const controls = () => tree!.root.findAll((node) => ['button', 'input', 'textarea', 'form', 'a', 'select'].includes(node.type) && !node.props['data-place']);
const chips = () => tree!.root.findAll((node) => !!node.props['data-place']).map((node) => [JSON.parse(node.props['data-place']), said(node)]);
const press = (label: string) => act(async () => { await buttons().find((b) => said(b) === label)!.props.onClick(); });
const asked = () => feed.mock.calls.filter(([query]) => query.startsWith('query Inbox(')).at(-1)![1];

it('reads the folder with the Inbox\'s own selection and lists its items newest first: words, who asked, when, state, and a chip that places the question', async () => {
  await draw({ folder: 'needs' }, 'primary');
  expect(asked()).toEqual({ folder: 'needs', search: '', agent: null, offset: 0, onlyErrors: false });
  expect(chips().filter(([place]) => place.brick === 'question')).toEqual([
    [{ brick: 'question', params: { item: 'in-new' } }, 'Words of in-new?'], [{ brick: 'question', params: { item: 'in-old' } }, 'Words of in-old?'],
    // A quiet item is one line; a hidden one is left out, as in the Inbox.
    [{ brick: 'question', params: { item: 'in-quiet' } }, 'First line']]);
  for (const words of ['Needs you: 3', 'Needs you 3', 'Alerts 1', 'Answered 7', 'FYI 2', 'All items 12', 'Errors 0', 'Why of in-new.', 'sam', 'open', 'Unread', 'Read', 'Quiet', 'Nov 14, 2026']) expect(text(), words).toContain(words);
  for (const never of ['in-hidden', 'Second line', 'Quiet why.']) expect(text(), never).not.toContain(never);
  // Who asked is a chip where it is an agent.
  expect(chips().filter(([place]) => place.brick === 'agent').map(([place]) => place.params)).toEqual([{ agent: 'art' }, { agent: 'art' }]);
  // Nothing here answers an item.
  expect(buttons().map(said)).toEqual(['Mark read']);
  expect(tree!.root.findAllByType('input')).toEqual([]);
});

it('takes its folder from the desktop\'s fixed list, and the one that holds what waits when it is given none', async () => {
  for (const [folder, sentAs, label] of [['needs', 'needs', 'Needs you: 3'], ['alerts', 'alerts', 'Alerts: 1'], ['answered', 'answered', 'Answered: 7'], ['fyi', 'fyi', 'FYI: 2'], ['all', 'all', 'All items: 12']]) {
    world.items = [];
    await draw({ folder }, 'side');
    expect(asked()).toMatchObject({ folder: sentAs, onlyErrors: false });
    expect(text(), folder).toContain(label);
    expect(text(), folder).toContain('No items here.');
  }
  await draw({}, 'side');
  expect(asked()).toMatchObject({ folder: 'needs' });
  await draw({ folder: 'agent:art' }, 'side');
  expect(asked()).toMatchObject({ folder: 'needs', agent: null });
  // Rows are filtered by the Inbox's own rule for the folder, whatever came back.
  world.items = [row('in-done', { state: 'answered' }), row('in-open')];
  await draw({ folder: 'answered' }, 'primary');
  expect(chips().filter(([place]) => place.brick === 'question').map(([place]) => place.params.item)).toEqual(['in-done']);
});

it('draws the side form as the count and the first few items, each a chip, and the compact form as one line of counts with no controls', async () => {
  world.items = [1, 2, 3, 4, 5, 6].map((n) => row('in-' + n, { at: `2026-11-1${n}T08:00:00Z`, read: false }));
  await draw({ folder: 'needs' }, 'side');
  expect(text()).toContain('Needs you: 3');
  expect(chips().map(([place]) => place)).toEqual([6, 5, 4, 3].map((n) => ({ brick: 'question', params: { item: 'in-' + n } })));
  expect(text()).toContain('and 2 more');
  expect(controls()).toEqual([]);
  await draw({ folder: 'needs' }, 'compact');
  const json = tree!.toJSON() as { type: string; props: { className: string } };
  expect([json.type, json.props.className]).toEqual(['p', 'board-brief']);
  expect(said(tree!.root as Node)).toBe('3 need you · 1 alerts · 2 FYI · 7 answered');
  expect(controls()).toEqual([]);
  expect(chips()).toEqual([]);
});

it('draws loading until the Inbox answers and unavailable when it cannot be read or is not what the Inbox reads', async () => {
  for (const form of ['primary', 'side', 'compact'] as const) {
    world.status = 'loading';
    await draw({ folder: 'needs' }, form);
    expect(said(tree!.root as Node), form).toBe('Loading…');
    for (const status of ['offline', 'denied']) {
      world.status = status;
      await draw({ folder: 'needs' }, form);
      expect(said(tree!.root as Node), form + status).toBe('This inbox is unavailable.');
      expect(controls()).toEqual([]);
    }
    Object.assign(world, { status: 'live', folders: { needs: 'many' } });
    await draw({ folder: 'needs' }, form);
    expect(said(tree!.root as Node), form).toBe('This inbox is unavailable.');
    world.folders = counts;
  }
  expect(sent).not.toHaveBeenCalled();
});

it('heads the brick by its name and shows the folder only in the small line', () => {
  for (const folder of ['needs', 'alerts', 'answered', 'fyi', 'all', 'errors']) {
    expect(bricks.inbox.title({ folder })).toBe('Inbox');
    expect(bricks.inbox.sub({ folder })).toBe(folder);
  }
});

it('marks an unread item read through inbox.read, then tells the board "read" with nothing in its detail', async () => {
  await draw({ folder: 'needs' }, 'primary');
  await press('Mark read');
  expect(sent.mock.calls).toEqual([['/api/inbox/read', { item: 'in-new' }]]);
  expect(reported.mock.calls).toEqual([['read', {}]]);
  // A refused write is said and the board is told nothing.
  ok = false; sent.mockClear(); reported.mockClear();
  await press('Mark read');
  expect(sent).toHaveBeenCalledTimes(1);
  expect(reported).not.toHaveBeenCalled();
  expect(tree!.root.findAll((node) => node.props.role === 'alert').map(said)).toEqual(['Could not save. Try again.']);
});

it('lists the outcomes of the member\'s own actions where the Inbox does, and dismisses one through inbox.dismissResult', async () => {
  world.results = [{ id: 'r-1', at: '2026-11-14T21:00:00Z', ok: true, text: 'Pump schedule saved', page: '/p/settings', readAt: null }, { id: 'r-2', at: '2026-11-14T22:00:00Z', ok: false, text: 'Could not rename the pond', readAt: null },
    { id: 'r-3', at: '2026-11-14T23:00:00Z', ok: false, text: 'Already dismissed', readAt: '2026-11-14T23:30:00Z' }];
  await draw({ folder: 'needs' }, 'primary');
  expect(text()).not.toContain('Pump schedule saved');
  expect(text()).toContain('Errors 1');
  for (const folder of ['fyi', 'all']) {
    await draw({ folder }, 'primary');
    for (const words of ['Pump schedule saved', 'Could not rename the pond', 'Saved', 'Error']) expect(text(), folder + words).toContain(words);
    expect(text()).not.toContain('Already dismissed');
  }
  // Errors holds the failed outcomes and no items; it reads no rows.
  await draw({ folder: 'errors' }, 'primary');
  expect(asked()).toMatchObject({ folder: 'all', onlyErrors: true });
  expect(text()).toContain('Errors: 1');
  expect(text()).toContain('Could not rename the pond');
  expect(text()).not.toContain('Pump schedule saved');
  expect(chips()).toEqual([]);
  expect(buttons().map(said)).toEqual(['Dismiss']);
  await press('Dismiss');
  expect(sent.mock.calls).toEqual([['/api/inbox/dismissResult', { id: 'r-2' }]]);
  expect(reported.mock.calls).toEqual([['dismissResult', {}]]);
  // The side form lists them as words, with no control.
  await draw({ folder: 'errors' }, 'side');
  expect(text()).toContain('Could not rename the pond');
  expect(controls()).toEqual([]);
});

it('pages through a long folder fifty at a time, in the big form', async () => {
  world.items = Array.from({ length: 51 }, (_, n) => row('in-' + n, { at: new Date(Date.UTC(2026, 10, 14, 0, 51 - n)).toISOString() }));
  await draw({ folder: 'all' }, 'primary');
  expect(chips().filter(([place]) => place.brick === 'question')).toHaveLength(50);
  expect(buttons().map((b) => [said(b), b.props.disabled])).toEqual([['Newer', true], ['Older', false]]);
  world.items = [row('in-last')];
  await press('Older');
  expect(asked()).toMatchObject({ folder: 'all', offset: 50 });
  expect(buttons().map((b) => [said(b), b.props.disabled])).toEqual([['Newer', false], ['Older', true]]);
  await press('Newer');
  expect(asked()).toMatchObject({ offset: 0 });
  expect(sent).not.toHaveBeenCalled();
});

it('says an approval\'s item as its card says it now: a household change by its plain title, never the stored words', async () => {
  world.items = [row('in-ap', { source: 'approval', waitsOnKind: 'approval', waitsOnId: 'a-9', body: { words: 'stored words of the filing agent' } }), row('in-merge', { source: 'approval', waitsOnKind: 'approval', waitsOnId: 'a-8', body: { words: 'Merge the pump fix?' } })];
  world.approvals = [{ id: 'a-9', operation: 'household.change', what: 'stored', details: '{}' }, { id: 'a-8', operation: null, what: 'Merge the pump fix', details: '' }];
  world.titles = [{ approval: 'a-9', title: 'Make Robin an owner' }];
  await draw({ folder: 'needs' }, 'primary');
  expect(feed.mock.calls.filter(([query]) => query.startsWith('query InboxApprovals')).at(-1)![1]).toEqual({ ids: ['a-8', 'a-9'] });
  expect(feed.mock.calls.filter(([query]) => query.startsWith('query InboxProposalTitles')).at(-1)![1]).toEqual({ ids: ['a-9'] });
  expect(chips().filter(([place]) => place.brick === 'question').map(([, words]) => words).sort()).toEqual(['Make Robin an owner', 'Merge the pump fix?']);
  expect(text()).not.toContain('stored words of the filing agent');
});

it('flags itself when more waits on the member than before, and for nothing else', async () => {
  await draw({ folder: 'fyi' }, 'side');
  expect(raised).not.toHaveBeenCalled();
  for (const [needs, flag] of [[3, null], [2, null], [4, 'New item'], [4, null], [1, null], [2, 'New item']] as const) {
    raised.mockReset();
    world.folders = { ...counts, needs, fyi: 9 };
    await again({ folder: 'fyi' }, 'side');
    if (flag) expect(raised.mock.calls, String(needs)).toEqual([[flag]]); else expect(raised, String(needs)).not.toHaveBeenCalled();
  }
});
