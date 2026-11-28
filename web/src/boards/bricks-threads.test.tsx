/** The `threads` brick (docs/specs/boards.md, "The first bricks"): the member's conversations as Comms lists them.
 * The data hook is a fake, as in bricks-drawn.test.tsx. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer does not ship declarations.
import { act, create } from 'react-test-renderer';

const { feed, once, op } = vi.hoisted(() => ({ feed: vi.fn(), once: vi.fn(), op: vi.fn() }));
vi.mock('../data/graphql', () => ({ useDataQuery: feed, useDataOnce: once }));
vi.mock('../data/operation', () => ({ memberOperation: op }));
import { brickView, loadBricks, type Params } from './bricks';
import { Here } from './brick-kit';
import type { Form } from './layout';

// A brick's body is fetched when it is first drawn (./bricks.tsx). Here they are all fetched first, so each draws at once.
await loadBricks();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Node = { type: string; props: Record<string, any>; children: (Node | string)[]; findAll(match: (node: Node) => boolean): Node[]; findAllByType(type: string): Node[] };
let tree: { root: Node; toJSON(): unknown; unmount(): void } | undefined;
const reported = vi.fn(), raised = vi.fn(), sent = vi.fn();
beforeEach(() => { feed.mockReset(); once.mockReset().mockImplementation((_q: string, _v: unknown, o?: { pause?: boolean }) => (o?.pause ? { status: 'loading' } : { status: 'offline' })); op.mockReset().mockResolvedValue({ saved: true }); reported.mockReset(); raised.mockReset(); sent.mockReset(); vi.stubGlobal('fetch', sent); });
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; vi.unstubAllGlobals(); });
const said = (node: Node | string): string => (typeof node === 'string' ? node : node.children.map(said).join(''));
const draw = async (params: Params, form: Form) => { await act(async () => { tree?.unmount(); tree = create(h(brickView('threads').Body, { params, form, act: reported, raise: raised })); }); return tree!; };

const row = (id: string, over: object = {}) => ({ id, conversation: 'cv-' + id, venue: 'loom', title: 'About ' + id, agent: 'art', project: null, member: 'sam', pinned: false, archivedAt: null,
  lastAt: '2026-11-20T10:00:00Z', readSeq: 0, working: false, stopRequested: false, unread: false, ...over });
const open = [
  row('th:old', { lastAt: '2026-11-25T10:00:00Z', title: 'The gate' }),
  row('th:new', { lastAt: '2026-11-27T09:00:00Z', title: 'The pond', agent: 'mira', working: true, unread: true }),
  row('th:pin', { title: 'Standing orders', pinned: true }),
];
const gone = [row('th:gone', { title: 'Last winter', archivedAt: '2026-03-01T10:00:00Z' })];
/** Answers the list for the folder asked for, and records what was asked. */
const answer = (threads: Record<'false' | 'true', unknown[]> = { false: open, true: gone }) => feed.mockImplementation((query: string, variables?: { archived?: boolean }) =>
  /^query BoardsThreads\b/.test(query) ? { status: 'live', data: { homeComms: { member: 'sam', agents: ['art'] }, commsThreads: threads[String(!!variables?.archived) as 'true'] } } : { status: 'live', data: {} });
const links = () => tree!.root.findAllByType('a').map((a) => [a.props.href, said(a)]);

it('lists the open conversations in Comms\' order, each an ordinary link to its address, with working and unread marks', async () => {
  answer();
  await draw({ scope: 'open' }, 'side');
  expect(links()).toEqual([['/app/t/th%3Apin', 'Standing orders Art'], ['/app/t/th%3Anew', 'The pond MiraWorkingUnread'], ['/app/t/th%3Aold', 'The gate Art']]);
  expect(said(tree!.root.findAllByType('p')[0])).toBe('3 conversations · 1 working · 1 unread');
  // An ordinary anchor: nothing of the page's own runs on it, and nothing is a chip or a button.
  for (const a of tree!.root.findAllByType('a')) expect(Object.keys(a.props).sort()).toEqual(['children', 'href']);
  expect(tree!.root.findAllByType('button')).toEqual([]);
  expect(feed.mock.calls.find(([query]) => /BoardsThreads/.test(query))![1]).toEqual({ archived: false });
});
it('reads the archived folder when that is its scope, and the open one with no scope', async () => {
  answer();
  await draw({ scope: 'archived' }, 'side');
  expect(links()).toEqual([['/app/t/th%3Agone', 'Last winter Art']]);
  expect(said(tree!.root.findAllByType('p')[0])).toBe('1 archived conversation · 0 working · 0 unread');
  await draw({}, 'side');
  expect(links()).toHaveLength(3);
});
it('the primary form shows every row and when each was last used; the side form the first six and how many more', async () => {
  const many = Array.from({ length: 9 }, (_, n) => row('th:' + n, { lastAt: `2026-11-1${n}T10:00:00Z` }));
  answer({ false: many, true: [] });
  await draw({ scope: 'open' }, 'side');
  expect(links()).toHaveLength(6);
  expect(JSON.stringify(tree!.toJSON())).toContain('more');
  expect(tree!.root.findAll((n) => n.props.className === 'board-note').map(said)).toContain('and 3 more');
  await draw({ scope: 'open' }, 'primary');
  expect(links()).toHaveLength(9);
  expect(links()[0][0]).toBe('/app/t/th%3A8');
  // When each was last used: one way of writing a time (brick-kit.tsx, Time).
  expect(tree!.root.findAllByType('time').map((t) => t.props.dateTime)).toHaveLength(9);
});
it('the compact form is one line of counts and no controls', async () => {
  answer();
  const json = (await draw({ scope: 'open' }, 'compact')).toJSON() as { type: string; props: { className: string }; children: string[] };
  expect(json.type).toBe('p'); expect(json.props.className).toBe('board-brief');
  expect(json.children.join('')).toBe('3 conversations · 1 working · 1 unread');
  expect(tree!.root.findAll((n) => ['a', 'button', 'input', 'form'].includes(n.type))).toEqual([]);
});
it('says when Comms holds more than its first page, and when there are none', async () => {
  answer({ false: Array.from({ length: 51 }, (_, n) => row('th:' + n)), true: [] });
  await draw({ scope: 'open' }, 'compact');
  expect(said(tree!.root.findAllByType('p')[0])).toBe('More than 50 conversations · 0 working · 0 unread');
  await draw({ scope: 'archived' }, 'side');
  expect(said(tree!.root)).toContain('No archived conversations.');
  answer({ false: [], true: [] });
  await draw({ scope: 'open' }, 'primary');
  expect(said(tree!.root)).toContain('No conversations yet.');
});
it('says loading while the read loads, and unavailable when it fails or the member has no mailbox', async () => {
  for (const form of ['compact', 'side', 'primary'] as const) {
    feed.mockReturnValue({ status: 'loading' });
    expect(said((await draw({ scope: 'open' }, form)).root)).toBe('Loading…');
    feed.mockReturnValue({ status: 'offline' });
    expect(said((await draw({ scope: 'open' }, form)).root)).toBe('This list of conversations is unavailable.');
    feed.mockReturnValue({ status: 'live', data: { homeComms: null, commsThreads: [] } });
    expect(said((await draw({ scope: 'open' }, form)).root)).toBe('This list of conversations is unavailable.');
  }
});
it('is headed by its name, never by a parameter, and calls no operation and reports nothing until pressed', async () => {
  answer();
  expect(brickView('threads').title({ scope: 'archived' })).toBe('Conversations');
  expect(brickView('threads').sub({ scope: 'archived' })).toBe('archived');
  await draw({ scope: 'open' }, 'primary');
  expect(sent).not.toHaveBeenCalled(); expect(op).not.toHaveBeenCalled(); expect(reported).not.toHaveBeenCalled(); expect(raised).not.toHaveBeenCalled();
  expect(once.mock.calls.every(([, , options]) => options?.pause)).toBe(true);
});

const buttons = () => tree!.root.findAllByType('button');
const press = (label: string) => act(async () => { await buttons().find((b) => b.props['aria-label'] === label || said(b) === label)!.props.onClick(); });
const alerts = () => tree!.root.findAll((n) => n.props.role === 'alert').map(said);
describe('pin, unpin and delete, in the primary form', () => {
  it('each row of the member\'s has Pin or Unpin and Delete…, named for the row; the side and compact forms have none', async () => {
    answer();
    await draw({ scope: 'open' }, 'primary');
    expect(buttons().map((b) => b.props['aria-label'] ?? said(b))).toEqual(['Search', 'Unpin Standing orders', 'Delete Standing orders…', 'Pin The pond', 'Delete The pond…', 'Pin The gate', 'Delete The gate…']);
    // A row's controls are quiet (the kit's RowTools: seen when the row is pointed at or holds the keyboard), never
    // taken from the keyboard or a screen reader: each row has one named group of real buttons, none hidden or skipped.
    const tools = tree!.root.findAll((n) => n.type === 'span' && n.props.className === 'board-row-tools');
    expect(tools.map((t) => [t.props.role, t.props['aria-label']])).toEqual([['group', 'Change Standing orders'], ['group', 'Change The pond'], ['group', 'Change The gate']]);
    for (const b of tools.flatMap((t) => t.findAllByType('button'))) expect([b.props.tabIndex, b.props.hidden, b.props['aria-hidden']]).toEqual([undefined, undefined, undefined]);
    await draw({ scope: 'open' }, 'side');
    expect(buttons()).toEqual([]);
  });
  it('pins and unpins with comms.change, and tells the board pin or unpin with nothing in the detail', async () => {
    answer();
    await draw({ scope: 'open' }, 'primary');
    await press('Pin The pond');
    expect(op.mock.calls).toEqual([['comms.change', { thread: 'th:new', change: 'pin', pinned: true }]]);
    expect(reported.mock.calls).toEqual([['pin', {}]]);
    await press('Unpin Standing orders');
    expect(op.mock.calls[1]).toEqual(['comms.change', { thread: 'th:pin', change: 'pin', pinned: false }]);
    expect(reported.mock.calls[1]).toEqual(['unpin', {}]);
  });
  it('says so under the row when a pin is refused or fails, and tells the board nothing', async () => {
    answer();
    await draw({ scope: 'open' }, 'primary');
    op.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }));
    await press('Pin The pond');
    expect(alerts()).toEqual(['Could not save. Try again.']);
    expect(reported).not.toHaveBeenCalled();
  });
  it('asks before deleting, naming the conversation, and cancelling sends nothing', async () => {
    answer();
    await draw({ scope: 'open' }, 'primary');
    await press('Delete The pond…');
    expect(op).not.toHaveBeenCalled();
    const question = tree!.root.findAll((n) => n.props.role === 'group' && n.props['aria-label'] === 'Delete conversation The pond')[0];
    expect(said(question.findAllByType('p')[0])).toBe('Delete “The pond” and its private words? It cannot be undone.');
    await press('Keep it');
    expect(op).not.toHaveBeenCalled(); expect(reported).not.toHaveBeenCalled();
    expect(buttons().map((b) => b.props['aria-label'] ?? said(b))).toContain('Delete The pond…');
    await press('Delete The pond…'); await press('Delete conversation');
    expect(op.mock.calls).toEqual([['comms.change', { thread: 'th:new', change: 'delete' }]]);
    expect(reported.mock.calls).toEqual([['delete', {}]]);
  });
  it('keeps the question open and says so when a delete is refused or fails', async () => {
    answer();
    await draw({ scope: 'open' }, 'primary');
    await press('Delete The gate…');
    op.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }));
    await press('Delete conversation');
    expect(alerts()).toEqual(['Could not delete the conversation. Try again.']);
    expect(buttons().filter((b) => ['Delete conversation', 'Keep it'].includes(said(b))).map((b) => [said(b), !!b.props.disabled])).toEqual([['Delete conversation', false], ['Keep it', false]]);
    expect(tree!.root.findAll((n) => n.props.role === 'group' && n.props['aria-label'] === 'Delete conversation The gate')).toHaveLength(1);
    expect(reported).not.toHaveBeenCalled();
  });
});

describe('the conversation open on the page', () => {
  const drawHere = async (thread: string) => { await act(async () => { tree?.unmount(); tree = create(h(Here.Provider, { value: { thread } }, h(brickView('threads').Body, { params: { scope: 'open' }, form: 'primary', act: reported, raise: raised }))); }); };
  it('has no Delete on its own row: deleting it would leave the page on a thread that is gone; the other rows keep theirs', async () => {
    answer();
    await drawHere('th:new');
    expect(buttons().map((b) => b.props['aria-label'] ?? said(b))).toEqual(['Search', 'Unpin Standing orders', 'Delete Standing orders…', 'Pin The pond', 'Pin The gate', 'Delete The gate…']);
    // It can still be pinned; and it is still a link, marked as the one open.
    await press('Pin The pond');
    expect(op.mock.calls).toEqual([['comms.change', { thread: 'th:new', change: 'pin', pinned: true }]]);
    await press('Delete The gate…'); await press('Delete conversation');
    expect(op.mock.calls[1]).toEqual(['comms.change', { thread: 'th:old', change: 'delete' }]);
    expect(op.mock.calls.some(([, input]) => input.thread === 'th:new' && input.change === 'delete')).toBe(false);
  });
  it('has no Delete on its row among search results either', async () => {
    answer();
    once.mockImplementation((_q: string, _v: unknown, o?: { pause?: boolean }) => (o?.pause ? { status: 'loading' } : { status: 'live', data: { homeComms: { member: 'sam' }, commsThreads: [row('th:new', { title: 'The pond' }), row('th:old', { title: 'The gate' })] } }));
    await drawHere('th:new');
    await act(async () => tree!.root.findAll((n) => n.type === 'input' && n.props['aria-label'] === 'Search conversations')[0].props.onChange({ target: { value: 'the' } }));
    await act(async () => tree!.root.findAll((n) => n.type === 'form' && n.props.role === 'search')[0].props.onSubmit({ preventDefault() {} }));
    expect(buttons().map((b) => b.props['aria-label'] ?? said(b)).filter((l) => l.startsWith('Delete'))).toEqual(['Delete The gate…']);
  });
});

describe('search, in the primary form', () => {
  const found = (rows: object[]) => ({ status: 'live', data: { homeComms: { member: 'sam' }, commsThreads: rows } });
  const asked = () => once.mock.calls.filter(([, , options]) => !options?.pause).map(([query, variables]) => [/query (\w+)/.exec(query)![1], variables]);
  const typed = (words: string) => act(async () => tree!.root.findAll((n) => n.type === 'input' && n.props['aria-label'] === 'Search conversations')[0].props.onChange({ target: { value: words } }));
  const submit = () => act(async () => tree!.root.findAll((n) => n.type === 'form' && n.props.role === 'search')[0].props.onSubmit({ preventDefault() {} }));
  it('asks Comms\' search in the brick\'s folder once on submit, never per keystroke, and lists what it found', async () => {
    answer();
    once.mockImplementation((_q: string, _v: unknown, o?: { pause?: boolean }) => (o?.pause ? { status: 'loading' } : found([row('th:new', { title: 'The pond', archivedAt: '2026-11-01T10:00:00Z' })])));
    await draw({ scope: 'archived' }, 'primary');
    await typed('p'); await typed('po'); await typed(' pond  ');
    expect(asked()).toEqual([]);
    await submit();
    expect(new Set(asked().map((a) => JSON.stringify(a)))).toEqual(new Set([JSON.stringify(['BoardsThreadSearch', { archived: true, search: 'pond' }])]));
    expect(links()).toEqual([['/app/t/th%3Anew', 'The pond Art']]);
    // What was typed is the drawn brick's alone: the board is told nothing and nothing places a brick with it.
    expect(reported).not.toHaveBeenCalled(); expect(raised).not.toHaveBeenCalled();
    expect(JSON.stringify(tree!.root.findAll((n) => n.props['data-place'] !== undefined).map((n) => n.props['data-place']))).not.toContain('pond');
  });
  it('says when nothing matches, and when the search failed', async () => {
    answer();
    once.mockImplementation((_q: string, _v: unknown, o?: { pause?: boolean }) => (o?.pause ? { status: 'loading' } : found([])));
    await draw({ scope: 'open' }, 'primary');
    await typed('nothing'); await submit();
    expect(said(tree!.root)).toContain('No conversations match.');
    once.mockImplementation((_q: string, _v: unknown, o?: { pause?: boolean }) => (o?.pause ? { status: 'loading' } : { status: 'offline' }));
    await draw({ scope: 'open' }, 'primary');
    await typed('pond'); await submit();
    expect(alerts()).toEqual(['Search is unavailable. Try again.']);
    expect(links()).toEqual([]);
  });
  it('after a pin or a delete among the results, asks the search again; Show the list goes back', async () => {
    answer();
    once.mockImplementation((_q: string, _v: unknown, o?: { pause?: boolean }) => (o?.pause ? { status: 'loading' } : found([row('th:new', { title: 'The pond' })])));
    await draw({ scope: 'open' }, 'primary');
    await typed('pond'); await submit();
    const before = asked().length;
    await press('Pin The pond');
    expect(reported.mock.calls).toEqual([['pin', {}]]);
    expect(asked().length).toBeGreaterThan(before);
    await press('Show the list');
    expect(links()).toHaveLength(3);
  });
});
