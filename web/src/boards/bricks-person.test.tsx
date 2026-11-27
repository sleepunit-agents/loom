/** The fuller `person` brick (docs/specs/boards.md, "The first bricks"): a contact as People's reader shows them, and a
 * member by their card and their open tickets. The data hook is a fake. The brick has no action, so nothing is sent. */
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
    return { ok: answerOk, status: answerOk ? 200 : 409, json: async () => (answerOk ? { ok: true, value: { slugs: ['pump'] } } : { ok: false }) };
  });
});
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; vi.unstubAllGlobals(); });

type Data = Record<string, unknown>;
const answer = (data: Data) => feed.mockImplementation((query: string) => {
  const name = /^query (\w+)/.exec(query)![1];
  return name in data ? (data[name] === undefined ? { status: 'loading' } : { status: 'live', data: data[name] }) : { status: 'live', data: {} };
});
async function draw(form: Form, params: Params = { person: 'contact:anton' }) {
  await act(async () => { tree?.unmount(); tree = create(h(brickView('person').Body, { params, form, act: reported, raise: () => {} })); });
  return tree!;
}
const text = () => JSON.stringify(tree!.toJSON());
const said = (node: Node): string => node.children.map((child) => (typeof child === 'string' ? child : said(child))).join('');
const buttons = () => tree!.root.findAllByType('button').filter((b) => !b.props['data-place']);
const controls = () => tree!.root.findAll((node) => ['button', 'input', 'textarea', 'form', 'a'].includes(node.type) && !node.props['data-place']);
const placed = () => tree!.root.findAll((node) => !!node.props['data-place']).map((node) => JSON.parse(node.props['data-place']));
const press = (label: string) => act(async () => { await buttons().find((b) => said(b) === label)!.props.onClick(); });

const shown = () => said(tree!.root as Node);
const card = (over: object = {}) => ({ slug: 'anton', name: 'Anton Avguchenko', summary: 'Fits the pond liners.', where: [{ key: 'email', value: { text: 'anton@example.test', number: null, boolean: null, strings: null }, label: 'work', source: 'his card', verified_at: '2026-10-02', stale_after_days: null }],
  how: [{ key: 'prefers', value: { text: 'mornings', number: null, boolean: null, strings: null } }], may: [], ...over });
const contact = { id: 'commons:anton', slug: 'anton', agent: null as string | null, name: 'Anton Avguchenko', updated: '2026-11-01', synthesizedAt: null, kind: 'person', newer: 0, mergedFrom: 'tony',
  card: card(), evidence: [] as object[],
  fields: [{ key: 'email', value: 'anton@example.test', label: 'work', source: 'his card', verifiedAt: '2026-10-02T00:00:00Z', state: 'fresh' }],
  projects: [{ agent: 'art', slug: 'pond', name: 'Pond', status: 'active', href: '/p/work/notes/project/art%3Apond' }], ownership: null as object | null,
  sightings: [{ platform: 'slack', workspace: 'T1', account: 'U7', label: 'anton', seenAt: '2026-11-20T15:00:00Z' }],
  conversations: { available: true, rows: [{ id: 'cv-liner-1', title: 'Liner quote', href: '/p/comms-preview/conversation/cv-liner-1' }] }, history: [] };
const relationship = { ...contact, id: 'art:anton', agent: 'art', updated: '2026-11-10T00:00:00Z', newer: 2, mergedFrom: null, fields: [], projects: [], sightings: undefined, conversations: undefined,
  card: card({ summary: 'Quick to answer.', where: [], how: [{ key: 'tone', value: { text: 'plain', number: null, boolean: null, strings: null } }], may: [{ text: 'May be asked for quotes', source: 'sam, 2026-10' }] }),
  evidence: [{ created: '2026-11-09T00:00:00Z', category: 'user', title: 'Quoted the liner', content: 'He quoted 400 for the liner.' }] };
const other = { ...relationship, id: 'art:bea', slug: 'bea', name: 'Bea', card: card({ slug: 'bea', name: 'Bea', summary: 'Someone else.', where: [], how: [] }), evidence: [] };
const tickets = { BrickAssigned: { rows: [{ id: 't-7', title: 'Order a filter', status: 'open' }] } };
const world = (person: object | null = contact, people: object[] = [contact, relationship, other]): Data => ({ MemoryPerson: { memoryPerson: person }, MemoryPeople: { memoryPeople: people }, ...tickets });

it('draws a contact big as People\'s reader does: reach, last seen, facts, each agent\'s relationship and its notes, projects and conversations', async () => {
  answer(world());
  await draw('primary');
  expect(feed.mock.calls[0][1]).toEqual({ id: 'commons:anton' });
  for (const words of ['Anton Avguchenko', 'Fits the pond liners.', 'tony was merged into anton.', 'email: work · anton@example.test · fresh · verified 2026-10-02 · Source: his card',
    'Slack: anton', 'T1 · U7', 'prefers: mornings', 'Updated 2026-11-10 · 2 memories newer than this card', 'Quick to answer.', 'tone: plain',
    'Recorded permissions: May be asked for quotes · sam, 2026-10. These records do not grant access.', 'Quoted the liner · 2026-11-09', 'He quoted 400 for the liner.',
    'Contact details and relationship notes do not grant access.']) expect(shown(), words).toContain(words);
  // Another person's relationship card is not drawn here.
  expect(shown()).not.toContain('Someone else.');
  expect(placed()).toEqual([
    { brick: 'agent', params: { agent: 'art' } },
    { brick: 'project', params: { project: 'pond' } },
    { brick: 'session', params: { session: 'cv-liner-1' } },
  ]);
  // An address People links is a link here too; nothing on the brick changes anything.
  expect(tree!.root.findAllByType('a').map((a) => a.props.href)).toEqual(['mailto:anton%40example.test']);
  expect(buttons()).toEqual([]); expect(tree!.root.findAllByType('form')).toEqual([]); expect(tree!.root.findAllByType('input')).toEqual([]);
  expect(sent).not.toHaveBeenCalled();
});

it('says so where a contact has no relationship card the member may read, no project and no conversation', async () => {
  answer(world({ ...contact, mergedFrom: null, fields: [], projects: [], sightings: [], conversations: { available: true, rows: [] }, card: card({ where: [], how: [] }) }, [contact]));
  await draw('primary');
  for (const words of ['No contact details recorded.', 'No relationship cards available to you.', 'No linked projects.', 'No conversations of yours with this contact.']) expect(shown(), words).toContain(words);
  expect(placed()).toEqual([]);
  answer(world({ ...contact, conversations: { available: false, rows: [] } }));
  await draw('primary');
  expect(shown()).toContain('Conversation service is not available yet.');
});

it('draws a contact small with who they are, where they are reached, who knows them and their projects, and no control', async () => {
  answer(world());
  await draw('side');
  for (const words of ['Anton Avguchenko', 'Fits the pond liners.', 'email: work · anton@example.test · fresh', 'Known to', 'Pond · active · art']) expect(shown(), words).toContain(words);
  for (const words of ['He quoted 400', 'Last seen', 'verified 2026-10-02', 'do not grant access']) expect(shown(), words).not.toContain(words);
  expect(placed()).toEqual([{ brick: 'agent', params: { agent: 'art' } }, { brick: 'project', params: { project: 'pond' } }]);
  expect(controls()).toEqual([]);
  await draw('compact');
  const json = tree!.toJSON() as { type: string; props: { className: string } };
  expect(json.type).toBe('p'); expect(json.props.className).toBe('board-brief');
  expect(shown()).toBe('Anton Avguchenko · Fits the pond liners.');
  expect(controls()).toEqual([]);
});

it('says a contact who is not there, or whom the member may not read, is unavailable, and loading until loom answers', async () => {
  for (const form of ['primary', 'side', 'compact'] as const) {
    answer(world(null));
    await draw(form);
    expect(shown(), form).toBe('This person is unavailable.');
    expect(controls()).toEqual([]);
    answer({ MemoryPerson: undefined, MemoryPeople: undefined });
    await draw(form);
    expect(shown(), form).toBe('Loading…');
  }
});

it('draws a member by their card, which is the shared card under their member id, with their open tickets under it', async () => {
  const sam = { ...contact, id: 'commons:sam', slug: 'sam', name: 'Sam Reed', mergedFrom: null, card: card({ slug: 'sam', name: 'Sam Reed', summary: 'Keeps the pond.' }), ownership: { owner: false, agents: ['art'] } };
  answer(world(sam, [sam, { ...relationship, id: 'art:sam', slug: 'sam' }]));
  await draw('primary', { person: 'member:sam' });
  expect(feed.mock.calls[0][1]).toEqual({ id: 'commons:sam' });
  for (const words of ['Sam Reed', 'Keeps the pond.', 'Owns', 'Quick to answer.', 'Open tickets', '1 open ticket.']) expect(shown(), words).toContain(words);
  expect(placed()).toContainEqual({ brick: 'ticket', params: { ticket: 't-7' } });
  expect(feed.mock.calls.find(([query]) => String(query).includes('BrickAssigned'))![1]).toEqual({ ref: 'sam' });
  await draw('side', { person: 'member:sam' });
  expect(shown()).toContain('Sam Reed'); expect(shown()).toContain('1 open ticket.');
  // An owner's card says what an owner owns.
  answer(world({ ...sam, ownership: { owner: true, agents: [] } }));
  await draw('primary', { person: 'member:sam' });
  expect(shown()).toContain('The household and every agent');
});

it('draws a member who has no card, or whose card is still loading, by their open tickets alone, and the compact form never asks for the card', async () => {
  for (const data of [world(null), { ...world(), MemoryPerson: undefined }]) {
    answer(data);
    await draw('side', { person: 'member:sam' });
    expect(shown()).toBe('1 open ticket.t-7');
    expect(placed()).toEqual([{ brick: 'ticket', params: { ticket: 't-7' } }]);
  }
  feed.mockClear(); answer(world());
  await draw('compact', { person: 'member:sam' });
  expect(shown()).toBe('1 open ticket');
  expect(feed.mock.calls.map(([query]) => /^query (\w+)/.exec(String(query))![1]).filter((name) => name.startsWith('Memory') && name !== 'MemoryIdle')).toEqual([]);
});

it('is headed by its name and can be big', () => {
  expect(bricks.person.title({ person: 'contact:anton' })).toBe('Person');
  expect(bricks.person.sub({ person: 'contact:anton' })).toBe('contact:anton');
  expect(bricks.person.fits.primary!.height).toBeGreaterThan(bricks.person.fits.side.height);
});
