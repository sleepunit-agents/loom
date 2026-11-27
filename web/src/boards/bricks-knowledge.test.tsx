/** The `knowledge` brick (docs/specs/boards.md, "The first bricks"). The data hook is a fake and so is `fetch`:
 * what is checked is what is drawn, the request loom would receive, and what the board is told. */
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
const sent = vi.fn(), reported = vi.fn();
let answerOk = true;
beforeEach(() => {
  feed.mockReset(); sent.mockReset(); reported.mockReset(); answerOk = true;
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    sent(url, JSON.parse(init.body).input);
    return { ok: answerOk, status: answerOk ? 200 : 409, json: async () => (answerOk ? { ok: true, value: { slug: 'new-fact', slugs: ['new-fact'] } } : { ok: false }) };
  });
});
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; vi.unstubAllGlobals(); });

type Data = Record<string, unknown>;
const answer = (data: Data) => feed.mockImplementation((query: string) => {
  const name = /^query (\w+)/.exec(query)![1];
  return name in data ? (data[name] === undefined ? { status: 'loading' } : { status: 'live', data: data[name] }) : { status: 'live', data: {} };
});
async function draw(form: Form, params: Params = { show: 'all' }) {
  await act(async () => { tree?.unmount(); tree = create(h(brickView('knowledge').Body, { params, form, act: reported, raise: () => {} })); });
  return tree!;
}
const text = () => JSON.stringify(tree!.toJSON());
const said = (node: Node): string => node.children.map((child) => (typeof child === 'string' ? child : said(child))).join('');
const buttons = () => tree!.root.findAllByType('button').filter((b) => !b.props['data-place']);
const controls = () => tree!.root.findAll((node) => ['button', 'input', 'textarea', 'form', 'a'].includes(node.type) && !node.props['data-place']);
const placed = () => tree!.root.findAll((node) => !!node.props['data-place']).map((node) => JSON.parse(node.props['data-place']));
const press = (label: string) => act(async () => { await buttons().find((b) => said(b) === label)!.props.onClick(); });

const row = (slug: string, title: string, domain: string, fresh: string, updated: string, verified_at: string | null = null, recent: boolean | null = null) =>
  ({ slug, title, domain, updated, verified_at, fresh, by: null, recent });
const pages = [
  row('pump', 'How the pond pump runs', 'pond/pump', 'due', '2026-10-01T12:00:00Z', '2026-10-05T12:00:00Z'),
  row('liner', 'The pond liner', 'pond', 'fresh', '2026-11-20T12:00:00Z', '2026-11-25T12:00:00Z', true),
  row('boiler', 'Boiler service', 'house', 'due', '2026-09-01T12:00:00Z'),
  row('Old Page!', 'An old page', 'house notes', 'aging', '2026-08-01T12:00:00Z'),
];
const all = { allowed: true, canAdd: true, canVerify: true, canRecheck: true };
const world = (access: object | null = all, list = pages, found: unknown = undefined): Data => ({
  MemoryKnowledge: { memoryKnowledge: { timezone: 'America/Chicago', total: list.length, checkDays: 30, recentDays: 7, pages: list } },
  MemoryKnowledgeAccess: { memoryKnowledgeAccess: access }, ...(found === undefined ? {} : { BrickKnowledgeSearch: { rows: found } }) });
const shown = () => said(tree!.root as Node);
const pagesPlaced = () => placed().filter((p) => p.brick === 'knowledge-page').map((p) => p.params.page);
const type = (label: string, value: string) => act(async () => tree!.root.findAll((n) => (n.type === 'input' || n.type === 'textarea') && (n.props['aria-label'] === label)).at(0)!.props.onChange({ target: { value } }));
const field = (label: string) => tree!.root.findAllByType('label').find((l) => said(l) === label)!.findAll((n) => n.type === 'input' || n.type === 'textarea')[0];
const submit = (name: string) => act(async () => tree!.root.findAllByType('form').find((f) => f.props['aria-label'] === name || f.props.role === name)!.props.onSubmit({ preventDefault() {} }));

it('lists the pages as Knowledge does, newest first, each a chip that places its page, and counts those due a check', async () => {
  answer(world());
  await draw('primary');
  expect(shown()).toContain('All pages · 4 pages');
  expect(pagesPlaced()).toEqual(['liner', 'pump', 'boiler']);
  // A page whose slug no board can hold is named without a chip.
  expect(text()).toContain('An old page');
  expect(text()).toContain('Due a check'); expect(text()).toContain('Getting old'); expect(text()).toContain('verified Nov 25');
  expect(placed()).toContainEqual({ brick: 'knowledge', params: { show: 'due' } });
  // Its topics are chips that place this brick for one topic; one that is not shaped like an id is words.
  expect(placed().filter((p) => p.brick === 'knowledge' && p.params.domain).map((p) => p.params.domain)).toEqual(['house', 'pond', 'pond/pump']);
  expect(text()).toContain('house notes');
});

it('keeps to one topic and to one of Knowledge\'s lists, and orders what is due by the oldest check', async () => {
  answer(world());
  await draw('primary', { show: 'all', domain: 'pond' });
  expect(pagesPlaced()).toEqual(['liner', 'pump']);
  expect(placed()).toContainEqual({ brick: 'knowledge', params: { show: 'due', domain: 'pond' } });
  await draw('primary', { show: 'due' });
  expect(pagesPlaced()).toEqual(['boiler', 'pump']);
  expect(shown()).toContain('Due a check · 2 pages');
  await draw('primary', { show: 'recent' });
  expect(pagesPlaced()).toEqual(['liner']);
});

it('draws the side form as a short list and the compact form as one line, neither with a control', async () => {
  answer(world(all, [...pages, ...Array.from({ length: 4 }, (_, i) => row('extra-' + i, 'Extra ' + i, 'house', 'fresh', '2026-07-0' + (i + 1) + 'T12:00:00Z'))]));
  await draw('side');
  expect(pagesPlaced()).toHaveLength(4);
  expect(shown()).toContain('and 3 more');
  expect(controls()).toEqual([]);
  await draw('compact');
  const json = tree!.toJSON() as { type: string; props: { className: string }; children: string[] };
  expect(json.type).toBe('p'); expect(json.props.className).toBe('board-brief');
  expect(said(tree!.root as Node)).toBe('8 pages · 2 due a check');
  expect(controls()).toEqual([]);
});

it('says knowledge the member may not read is unavailable, and loading until it answers', async () => {
  for (const form of ['primary', 'side', 'compact'] as const) {
    answer({ MemoryKnowledge: { memoryKnowledge: null }, MemoryKnowledgeAccess: { memoryKnowledgeAccess: { allowed: false, canAdd: false, canVerify: false, canRecheck: false } } });
    await draw(form);
    expect(said(tree!.root as Node), form).toBe('This knowledge is unavailable.');
    expect(controls()).toEqual([]);
    answer({ MemoryKnowledge: undefined, MemoryKnowledgeAccess: undefined });
    await draw(form);
    expect(said(tree!.root as Node), form).toBe('Loading…');
  }
  expect(sent).not.toHaveBeenCalled();
});

it('is headed by its name, and a parameter is only in the small line', () => {
  expect(bricks.knowledge.title({ show: 'due', domain: 'pond' })).toBe('Knowledge');
  expect(bricks.knowledge.sub({ show: 'due', domain: 'pond' })).toBe('due · pond');
});

it('searches with loom\'s own search from a box inside the brick, and what is typed reaches no parameter and no act', async () => {
  answer(world(all, pages, [{ slug: 'pump', title: 'How the pond pump runs', domain: 'pond/pump', updated: '2026-10-01T12:00:00Z', verified_at: null }]));
  await draw('primary', { show: 'all', domain: 'pond' });
  const reads = () => feed.mock.calls.filter(([query]) => String(query).includes('BrickKnowledgeSearch')).at(-1)!;
  // Nothing is asked until the member searches.
  expect(reads()[2]).toMatchObject({ pause: true });
  await type('Search knowledge', '  dawn   timer ');
  expect(reads()[2]).toMatchObject({ pause: true });
  await submit('search');
  expect(reads()[1]).toEqual({ query: 'dawn timer', domain: 'pond', first: 30 });
  expect(reads()[2]).toMatchObject({ pause: false });
  expect(pagesPlaced()).toEqual(['pump']);
  expect(text()).toContain('Due a check');
  expect(reported).not.toHaveBeenCalled(); expect(sent).not.toHaveBeenCalled();
  await press('Show the list');
  expect(pagesPlaced()).toEqual(['liner', 'pump']);
  // No match, and a search loom cannot answer, each say so.
  answer(world(all, pages, []));
  await draw('primary'); await type('Search knowledge', 'zebra'); await submit('search');
  expect(text()).toContain('Nothing matches.');
  answer(world(all, pages, null));
  await draw('primary'); await type('Search knowledge', 'zebra'); await submit('search');
  expect(text()).toContain('Search is unavailable.');
});

it('adds a page with mind.knowledgeAdd, what Knowledge sends, and tells the board nothing that was typed', async () => {
  answer(world());
  await draw('primary', { show: 'all', domain: 'pond' });
  await press('Add a fact');
  expect(field('Topic').props.value).toBe('pond');
  await act(async () => field('Title').props.onChange({ target: { value: 'New fact' } }));
  await act(async () => field('What it says').props.onChange({ target: { value: 'The filter is cleaned monthly.' } }));
  await submit('Add a fact');
  expect(sent).toHaveBeenCalledWith('/api/mind/knowledgeAdd', { title: 'New fact', domain: 'pond', body: 'The filter is cleaned monthly.', source: '' });
  expect(reported).toHaveBeenCalledWith('add', {});
  expect(JSON.stringify(reported.mock.calls)).not.toContain('filter');
  expect(text()).toContain('Added to Knowledge');
  expect(placed()).toContainEqual({ brick: 'knowledge-page', params: { page: 'new-fact' } });
  // A refused save reports nothing and keeps the form.
  answerOk = false; reported.mockClear();
  await press('Add a fact');
  await act(async () => field('Title').props.onChange({ target: { value: 'Another' } }));
  await act(async () => field('What it says').props.onChange({ target: { value: 'Words.' } }));
  await submit('Add a fact');
  expect(reported).not.toHaveBeenCalled();
  expect(text()).toContain('That did not save.');
  expect(field('Title').props.value).toBe('Another');
});

it('offers "Add a fact" only to a member Knowledge lets add, and only when big', async () => {
  answer(world({ allowed: true, canAdd: false, canVerify: true, canRecheck: true }));
  await draw('primary');
  expect(buttons().map(said)).toEqual(['Search']);
  answer(world());
  await draw('side');
  expect(buttons()).toEqual([]);
});
