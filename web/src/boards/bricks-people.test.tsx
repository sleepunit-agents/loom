/** The `people` brick (docs/specs/boards.md, "The first bricks"). The data hook is a fake and so is `fetch`:
 * what is checked is what is drawn, the request loom would receive, and what the board is told. */
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
const sent = vi.fn(), reported = vi.fn();
let answerOk = true;
beforeEach(() => {
  feed.mockReset(); sent.mockReset(); reported.mockReset(); answerOk = true;
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    sent(url, JSON.parse(init.body).input);
    return { ok: answerOk, status: answerOk ? 200 : 409, json: async () => (answerOk ? { ok: true, value: { slug: 'dana-new', slugs: ['dana-new'] } } : { ok: false }) };
  });
});
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; vi.unstubAllGlobals(); });

type Data = Record<string, unknown>;
const answer = (data: Data) => feed.mockImplementation((query: string) => {
  const name = /^query (\w+)/.exec(query)![1];
  return name in data ? (data[name] === undefined ? { status: 'loading' } : { status: 'live', data: data[name] }) : { status: 'live', data: {} };
});
async function draw(form: Form, params: Params = { folder: 'all' }) {
  await act(async () => { tree?.unmount(); tree = create(h(brickView('people').Body, { params, form, act: reported, raise: () => {} })); });
  return tree!;
}
const text = () => JSON.stringify(tree!.toJSON());
const said = (node: Node): string => node.children.map((child) => (typeof child === 'string' ? child : said(child))).join('');
const buttons = () => tree!.root.findAllByType('button').filter((b) => !b.props['data-place']);
const controls = () => tree!.root.findAll((node) => ['button', 'input', 'textarea', 'form', 'a'].includes(node.type) && !node.props['data-place']);
const placed = () => tree!.root.findAll((node) => !!node.props['data-place']).map((node) => JSON.parse(node.props['data-place']));
const press = (label: string) => act(async () => { await buttons().find((b) => said(b) === label)!.props.onClick(); });

const shown = () => said(tree!.root as Node);
const card = (slug: string, name: string, summary: string | null = null) => ({ slug, name, summary, where: [], how: [], may: [] });
const record = (id: string, name: string, kind: string, over: object = {}) => {
  const [source, slug] = id.split(':');
  return { id, slug, agent: source === 'commons' ? null : source, name, updated: '2026-11-01', synthesizedAt: null, kind, newer: 0, mergedFrom: null, card: card(slug, name), evidence: [], fields: [], projects: [], ownership: null, ...over };
};
const people = [
  record('commons:anton', 'Anton Avguchenko', 'person', { card: card('anton', 'Anton Avguchenko', 'Fits the pond liners.'), fields: [{ key: 'email', value: 'a@example.test', label: null, source: null, verifiedAt: null, state: 'stale' }] }),
  record('art:anton', 'Anton Avguchenko', 'person'),
  record('commons:sam', 'Sam Reed', 'person', { ownership: { owner: false, agents: ['art'] } }),
  record('commons:art', 'Art', 'agent'),
  record('commons:Bad Slug', 'Zed Oddly', 'person'),
];
const may = { allowed: true, directory: true, canAdd: true, agents: ['art'] };
const world = (access: object | null = may, list = people): Data => ({ MemoryPeopleAccess: { memoryPeopleAccess: access }, MemoryPeople: { memoryPeople: list } });
const type = (label: string, value: string) => act(async () => tree!.root.findAll((n) => (n.type === 'input' || n.type === 'textarea') && n.props['aria-label'] === label)[0].props.onChange({ target: { value } }));
const field = (label: string) => tree!.root.findAllByType('label').find((l) => said(l) === label)!.findAll((n) => n.type === 'input' || n.type === 'textarea')[0];
const submit = () => act(async () => tree!.root.findAllByType('form')[0].props.onSubmit({ preventDefault() {} }));

it('lists the directory as People does, by name, each person a chip for their person brick and each agent for its agent brick', async () => {
  answer(world());
  await draw('primary');
  expect(shown()).toContain('Everyone · 3 people · 1 agent');
  expect(placed()).toEqual([
    { brick: 'person', params: { person: 'contact:anton' } },
    { brick: 'agent', params: { agent: 'art' } },
    // A card that says what a member owns is that member's.
    { brick: 'person', params: { person: 'member:sam' } },
  ]);
  for (const words of ['Stale contact details', 'Known to art', 'No relationship cards available', 'Zed Oddly']) expect(shown(), words).toContain(words);
  expect(feed.mock.calls.find(([query]) => String(query).includes('MemoryPeople '))![0]).toContain('memoryPeople(includeRemovedAgents:false)');
});

it('keeps to one of People\'s folders', async () => {
  answer(world());
  await draw('primary', { folder: 'agent' });
  expect(placed()).toEqual([{ brick: 'agent', params: { agent: 'art' } }]);
  expect(shown()).toContain('Agents · 1');
  await draw('primary', { folder: 'person' });
  expect(placed().map((p) => p.params.person)).toEqual(['contact:anton', 'member:sam']);
});

it('searches as People does from a box inside the brick; what is typed reaches no read, no parameter and no act', async () => {
  answer(world());
  await draw('primary');
  const reads = feed.mock.calls.length;
  await type('Search people', 'liners');
  expect(placed()).toEqual([{ brick: 'person', params: { person: 'contact:anton' } }]);
  await type('Search people', 'zebra');
  expect(placed()).toEqual([]); expect(shown()).toContain('Nothing matches.');
  expect(JSON.stringify(feed.mock.calls.slice(reads))).not.toContain('zebra');
  expect(reported).not.toHaveBeenCalled(); expect(sent).not.toHaveBeenCalled();
});

it('draws the side form as a short list and the compact form as one line, neither with a control', async () => {
  answer(world(may, [...people, ...Array.from({ length: 5 }, (_, i) => record('commons:extra-' + i, 'Extra ' + i, 'person'))]));
  await draw('side');
  expect(placed()).toHaveLength(6);
  expect(shown()).toContain('and 3 more');
  expect(controls()).toEqual([]);
  await draw('compact');
  const json = tree!.toJSON() as { type: string; props: { className: string } };
  expect(json.type).toBe('p'); expect(json.props.className).toBe('board-brief');
  expect(shown()).toBe('8 people · 1 agent');
  expect(controls()).toEqual([]);
});

it('says a directory the member may not read is unavailable, and loading until loom answers', async () => {
  for (const form of ['primary', 'side', 'compact'] as const) {
    for (const data of [world({ allowed: false, directory: false, canAdd: false, agents: [] }, []), world(null, [])]) {
      answer(data);
      await draw(form);
      expect(shown(), form).toBe('This directory is unavailable.');
      expect(controls()).toEqual([]);
    }
    answer({ MemoryPeopleAccess: undefined, MemoryPeople: undefined });
    await draw(form);
    expect(shown(), form).toBe('Loading…');
  }
  expect(sent).not.toHaveBeenCalled();
});

it('is headed by its name, and its folder is only in the small line', () => {
  expect(bricks.people.title({ folder: 'agent' })).toBe('People');
  expect(bricks.people.sub({ folder: 'agent' })).toBe('agent');
});

it('adds a person with mind.personAdd, what People sends, and tells the board nothing that was typed', async () => {
  answer(world());
  await draw('primary');
  await press('Add a person');
  await act(async () => field('Name').props.onChange({ target: { value: 'Dana New' } }));
  await act(async () => field('Who they are').props.onChange({ target: { value: 'Mends pumps.' } }));
  await press('email');
  await act(async () => field('Their handle or address').props.onChange({ target: { value: 'dana@example.test' } }));
  await submit();
  expect(sent).toHaveBeenCalledWith('/api/mind/personAdd', { name: 'Dana New', summary: 'Mends pumps.', channel: 'email', handle: 'dana@example.test' });
  expect(reported).toHaveBeenCalledWith('add', {});
  expect(JSON.stringify(reported.mock.calls)).not.toMatch(/Dana|pumps|example/);
  expect(shown()).toContain('Added to People');
  expect(placed()).toContainEqual({ brick: 'person', params: { person: 'contact:dana-new' } });
  // A refused save reports nothing and keeps what was typed.
  answerOk = false; reported.mockClear();
  await press('Add a person');
  await act(async () => field('Name').props.onChange({ target: { value: 'Anton Avguchenko' } }));
  await submit();
  expect(reported).not.toHaveBeenCalled();
  expect(shown()).toContain('That did not save.');
  expect(field('Name').props.value).toBe('Anton Avguchenko');
  // No name, nothing sent.
  sent.mockClear();
  await act(async () => field('Name').props.onChange({ target: { value: '  ' } }));
  await submit();
  expect(sent).not.toHaveBeenCalled();
});

it('offers "Add a person" only to a member People lets add, with People\'s hint otherwise, and only when big', async () => {
  answer(world({ allowed: true, directory: true, canAdd: false, agents: ['art'] }));
  await draw('primary');
  expect(buttons()).toEqual([]);
  expect(shown()).toContain('Ask an agent in Comms to set your household’s default agent before adding a person.');
  answer(world({ allowed: true, directory: true, canAdd: false, agents: [] }));
  await draw('primary');
  expect(shown()).toContain('Add a household agent and choose it as the default before adding a person.');
  answer(world());
  await draw('side');
  expect(buttons()).toEqual([]);
});
