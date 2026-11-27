/** The `threads` brick (docs/specs/boards.md, "The first bricks"): the member's conversations as Comms lists them.
 * The data hook is a fake, as in bricks-drawn.test.tsx. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer does not ship declarations.
import { act, create } from 'react-test-renderer';

const feed = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed }));
import { brickView, loadBricks, type Params } from './bricks';
import type { Form } from './layout';

// A brick's body is fetched when it is first drawn (./bricks.tsx). Here they are all fetched first, so each draws at once.
await loadBricks();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Node = { type: string; props: Record<string, any>; children: (Node | string)[]; findAll(match: (node: Node) => boolean): Node[]; findAllByType(type: string): Node[] };
let tree: { root: Node; toJSON(): unknown; unmount(): void } | undefined;
const reported = vi.fn(), raised = vi.fn(), sent = vi.fn();
beforeEach(() => { feed.mockReset(); reported.mockReset(); raised.mockReset(); sent.mockReset(); vi.stubGlobal('fetch', sent); });
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
  expect(said(tree!.root.findAll((n) => n.props.className === 'text-muted-foreground')[0])).toBe('and 3 more');
  await draw({ scope: 'open' }, 'primary');
  expect(links()).toHaveLength(9);
  expect(links()[0][0]).toBe('/app/t/th%3A8');
  expect(tree!.root.findAll((n) => n.props.className === 'board-line').every((line) => line.findAllByType('span').some((s) => /\d/.test(said(s))))).toBe(true);
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
it('is headed by its name, never by a parameter, calls no operation and reports nothing', async () => {
  answer();
  expect(brickView('threads').title({ scope: 'archived' })).toBe('Conversations');
  expect(brickView('threads').sub({ scope: 'archived' })).toBe('archived');
  await draw({ scope: 'open' }, 'primary');
  expect(sent).not.toHaveBeenCalled(); expect(reported).not.toHaveBeenCalled(); expect(raised).not.toHaveBeenCalled();
});
