/** The `activity` brick (docs/specs/boards.md, "The first bricks"). The data hook is a fake. The brick is read-only:
 * a fake `fetch` stands by to show that nothing is ever sent. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer does not ship declarations.
import { act, create } from 'react-test-renderer';

const feed = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed }));
import { bricks, brickView, type Params } from './bricks';
import { changeOf, windowsFor } from './bricks-activity';
import type { Form } from './layout';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Node = { type: string; props: Record<string, any>; children: (Node | string)[]; findAll(match: (node: Node) => boolean): Node[]; findAllByType(type: string): Node[] };
let tree: { root: Node; toJSON(): unknown; update(element: unknown): void; unmount(): void } | undefined;
const sent = vi.fn(), reported = vi.fn();
let answerOk = true;
beforeEach(() => {
  feed.mockReset(); sent.mockReset(); reported.mockReset(); answerOk = true;
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    sent(url, JSON.parse(init.body).input);
    return { ok: answerOk, status: answerOk ? 200 : 409, json: async () => (answerOk ? { ok: true, value: { slugs: ['pump'] } } : { ok: false }) };
  });
});
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; vi.unstubAllGlobals(); });

type Data = Record<string, unknown>;
const answer = (data: Data) => feed.mockImplementation((query: string) => {
  const name = /^query (\w+)/.exec(query)![1];
  return name in data ? (data[name] === undefined ? { status: 'loading' } : { status: 'live', data: data[name] }) : { status: 'live', data: {} };
});
async function draw(form: Form, params: Params = { days: 1 }) {
  await act(async () => { tree?.unmount(); tree = create(h(brickView('activity').Body, { params, form, act: reported, raise: () => {} })); });
  return tree!;
}
const text = () => JSON.stringify(tree!.toJSON());
const said = (node: Node): string => node.children.map((child) => (typeof child === 'string' ? child : said(child))).join('');
const buttons = () => tree!.root.findAllByType('button').filter((b) => !b.props['data-place']);
const controls = () => tree!.root.findAll((node) => ['button', 'input', 'textarea', 'form', 'a'].includes(node.type) && !node.props['data-place']);
const placed = () => tree!.root.findAll((node) => !!node.props['data-place']).map((node) => JSON.parse(node.props['data-place']));
const press = (label: string) => act(async () => { await buttons().find((b) => said(b) === label)!.props.onClick(); });

const shown = () => said(tree!.root as Node);
const may = { allowed: true, agents: ['art', 'bo'], owner: 'Sam', timezone: 'America/Chicago', today: '2026-11-13', expires: 0,
  windows: ['2026-11-13', '2026-11-10', '2026-11-07', '2026-11-04', '2026-11-01', '2026-10-29', '2026-10-26', '2026-10-23', '2026-10-20', '2026-10-17', '2026-10-14'] };
const entry = (id: string, at: string, over: object = {}) => ({ id, agent: 'art', at, day: at.slice(0, 10), hour: 11, title: 'Household work', line: null as string | null, venue: 'terminal', where: 'Terminal', what: 'conversation', owner: null as boolean | null, expires: null, ...over });
const dayBefore = (day: string, n: number) => new Date(Date.parse(day + 'T12:00:00Z') - n * 86400000).toISOString().slice(0, 10);
const windowOf = (to: string, entries: object[], over: object = {}) => ({ id: to, to, days: [0, 1, 2].map((n) => dayBefore(to, n)), earlier: null, entries, conversations: 'available', episodes: 'available', truncated: false, expires: 0, ...over });
const today = [
  entry('d~art~one', '2026-11-13T18:00:00Z', { title: 'Fixed the pump for t-12', line: 'Closed t-12 and opened t-13', what: 'work', owner: true }),
  entry('e~bo~two', '2026-11-13T15:00:00Z', { agent: 'bo', title: 'Morning check', what: 'system', venue: 'wakes', where: 'Wakes' }),
  entry('c~art~old', '2026-11-12T15:00:00Z', { title: 'Yesterday talk' }),
];
/** Windows are answered by the day they end on; every read is recorded with its variables. */
function world(access: object | null | 'loading' = may, byTo: Record<string, object | null | undefined> = { '2026-11-13': windowOf('2026-11-13', today) }, opened?: object | null) {
  feed.mockImplementation((query: string, variables?: { to?: string }) => {
    const name = /^query (\w+)/.exec(query)![1];
    if (name === 'MemoryActivityAccess') return access === 'loading' ? { status: 'loading' } : { status: 'live', data: { memoryActivityAccess: access } };
    if (name === 'MemoryActivity') { const w = byTo[variables!.to!]; return w === undefined ? (variables!.to! in byTo ? { status: 'loading' } : { status: 'live', data: { memoryActivity: windowOf(variables!.to!, []) } }) : { status: 'live', data: { memoryActivity: w } }; }
    if (name === 'MemoryActivityEntry') return opened === undefined ? { status: 'loading' } : { status: 'live', data: { memoryActivityEntry: opened } };
    return { status: 'live', data: {} };
  });
}
const windowsAsked = () => [...new Set(feed.mock.calls.filter(([query]) => String(query).startsWith('query MemoryActivity(')).map(([, v]) => v.to))];

it('draws today\'s timeline big, newest first, each row with its agent as a chip and the tickets its words name', async () => {
  world();
  await draw('primary');
  expect(shown()).toContain('2 entries today');
  expect(shown()).not.toContain('Yesterday talk');
  expect(shown().indexOf('Fixed the pump')).toBeLessThan(shown().indexOf('Morning check'));
  for (const words of ['12:00 PM', 'Terminal · with you · Closed t-12 and opened t-13', 'Work done', 'System', 'Wakes', '2026-11-13']) expect(shown(), words).toContain(words);
  expect(placed()).toEqual([
    { brick: 'agent', params: { agent: 'art' } }, { brick: 'ticket', params: { ticket: 't-12' } }, { brick: 'ticket', params: { ticket: 't-13' } },
    { brick: 'agent', params: { agent: 'bo' } },
  ]);
  // One window holds a day.
  expect(windowsAsked()).toEqual(['2026-11-13']);
  expect(sent).not.toHaveBeenCalled();
});

it('reads as many of Activity\'s three-day windows as the range needs, and keeps to the newest days of the range', async () => {
  expect([1, 7, 30].map(windowsFor)).toEqual([1, 3, 10]);
  const old = (day: string) => entry('c~art~' + day, day + 'T15:00:00Z', { title: 'Talk on ' + day });
  world(may, { '2026-11-13': windowOf('2026-11-13', today), '2026-11-10': windowOf('2026-11-10', [old('2026-11-08')]), '2026-11-07': windowOf('2026-11-07', [old('2026-11-07'), old('2026-11-06')]) });
  await draw('primary', { days: 7 });
  expect(windowsAsked()).toEqual(['2026-11-13', '2026-11-10', '2026-11-07']);
  // Seven days end on the 7th: the 6th is in the last window read and is left out.
  expect(shown()).toContain('5 entries in 7 days');
  expect(shown()).toContain('Talk on 2026-11-07'); expect(shown()).not.toContain('Talk on 2026-11-06');
  feed.mockClear();
  await draw('side', { days: 30 });
  expect(windowsAsked()).toEqual(may.windows.slice(0, 10));
  expect(shown()).toContain('6 entries in 30 days');
});

it('opens an entry inside the brick: what was asked, what happened, what was decided, its tickets and pull requests as chips', async () => {
  world(may, undefined, { ...today[0], asked: ['Fix the pump'], decided: ['Ordered a filter'], story: 'The **impeller** was jammed.', needs: 'Your yes on the order',
    steps: [{ label: 'Read the manual', state: 'done', tool: 'Read' }], more: [],
    tasks: [{ label: 't-12', href: '/p/work/backlog/task/t-12' }, { label: 'Pump reads low', href: '/p/work/project/pond/backlog/task/t-41' }, { label: 'A note', href: 'javascript:alert(1)' }],
    prs: [{ label: 'app#12', href: 'https://github.com/Acme/App/pull/12' }, { label: 'Read twice', href: '/p/work/changes/change/github%3Aacme%2Fapp%2313' }, { label: 'elsewhere#1', href: 'https://example.test/pr/1' }],
    links: [{ label: 'The memory', href: '/p/activity-preview/memory/art%3Am-1' }] });
  await draw('primary');
  await press('Fixed the pump for t-12');
  expect(feed.mock.calls.find(([query]) => String(query).includes('MemoryActivityEntry('))![1]).toEqual({ id: 'd~art~one' });
  for (const words of ['Needs you', 'Your yes on the order', 'What was asked', 'Fix the pump', 'What happened', 'impeller', 'What was decided', 'Ordered a filter', 'Read the manual · done', 'Read more', 'with you'])
    expect(shown(), words).toContain(words);
  const entryNode = tree!.root.findAll((n) => n.props['data-entry'] === 'd~art~one')[0];
  expect(entryNode.findAll((n) => !!n.props['data-place']).map((n) => JSON.parse(n.props['data-place']))).toEqual([
    { brick: 'ticket', params: { ticket: 't-12' } }, { brick: 'ticket', params: { ticket: 't-41' } },
    { brick: 'pull', params: { change: 'github:acme/app#12' } }, { brick: 'pull', params: { change: 'github:acme/app#13' } },
  ]);
  // A link that is no record is a link if it is safe to follow, and words if not.
  expect(entryNode.findAllByType('a').map((a) => [said(a), a.props.href, a.props.target])).toEqual([['elsewhere#1', 'https://example.test/pr/1', '_blank'], ['The memory', '/p/activity-preview/memory/art%3Am-1', '_blank']]);
  expect(shown()).toContain('A note');
  await press('Fixed the pump for t-12');
  expect(tree!.root.findAll((n) => n.props['data-entry'] === 'd~art~one')).toEqual([]);
  // An entry that has gone says so.
  world(may, undefined, null);
  await draw('primary'); await press('Morning check');
  expect(shown()).toContain('This entry is no longer available.');
  expect(sent).not.toHaveBeenCalled(); expect(reported).not.toHaveBeenCalled();
});

it('names a pull request only by an id loom writes', () => {
  expect(changeOf({ label: 'x', href: 'https://github.com/Acme/App/pull/12/files' })).toBe('github:acme/app#12');
  for (const href of [undefined, 'https://github.com/acme/app/issues/12', 'https://github.com/acme/app/pull/0', 'https://evil.test/github.com/acme/app/pull/1', '/p/work/changes/change/c-1', '/p/work/changes/change/%E0%A4%A', '/p/work/changes/change/github%3Aacme%2Fapp%2313%20merge'])
    expect(changeOf({ label: 'x', href }), String(href)).toBeUndefined();
});

it('draws the side form as the newest few rows and the compact form as one line, neither with a control', async () => {
  world(may, { '2026-11-13': windowOf('2026-11-13', [...today, ...Array.from({ length: 6 }, (_, i) => entry('c~art~x' + i, `2026-11-13T0${i}:00:00Z`, { title: 'Early ' + i }))]) });
  await draw('side');
  expect(shown()).toContain('8 entries today');
  expect(tree!.root.findAllByType('li')).toHaveLength(5);
  expect(shown()).toContain('and 3 more');
  expect(controls()).toEqual([]);
  await draw('compact');
  const json = tree!.toJSON() as { type: string; props: { className: string } };
  expect(json.type).toBe('p'); expect(json.props.className).toBe('board-brief');
  expect(shown()).toBe('8 entries today · latest from art: Fixed the pump for t-12');
  expect(controls()).toEqual([]);
});

it('says what Activity says when a source is missing or the day is quiet', async () => {
  world(may, { '2026-11-13': windowOf('2026-11-13', [], { conversations: 'unavailable', episodes: 'error', truncated: true }) });
  await draw('primary');
  for (const words of ['0 entries today', 'Conversations and digests are not available yet.', 'Some episode stores couldn’t load.', 'Showing the newest 600 entries per window.', 'Quiet']) expect(shown(), words).toContain(words);
  await draw('compact');
  expect(shown()).toBe('0 entries today');
});

it('says activity the member may not read is unavailable, and loading until loom answers', async () => {
  for (const form of ['primary', 'side', 'compact'] as const) {
    for (const access of [null, { ...may, allowed: false, agents: [] }]) {
      feed.mockClear(); world(access);
      await draw(form);
      expect(shown(), form).toBe('This activity is unavailable.');
      expect(controls()).toEqual([]);
      // No window is asked for by someone who may not read Activity.
      expect(windowsAsked()).toEqual([]);
    }
    world('loading');
    await draw(form);
    expect(shown(), form).toBe('Loading…');
    world(may, { '2026-11-13': undefined });
    await draw(form);
    expect(shown(), form).toBe('Loading…');
    world(may, { '2026-11-13': null });
    await draw(form);
    expect(shown(), form).toBe(form === 'compact' ? '0 entries today' : '0 entries todayQuiet');
  }
  expect(sent).not.toHaveBeenCalled();
});

it('is headed by its name, and its range is only in the small line', () => {
  expect(bricks.activity.title({ days: 7 })).toBe('Activity');
  expect(bricks.activity.sub({ days: 7 })).toBe('7 days');
  expect(bricks.activity.sub({ days: 1 })).toBe('1 day');
});
