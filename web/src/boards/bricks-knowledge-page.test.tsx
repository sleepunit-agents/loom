/** The `knowledge-page` brick (docs/specs/boards.md, "The first bricks"). The data hook is a fake and so is `fetch`:
 * what is checked is what is drawn, the request loom would receive, and what the board is told. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer does not ship declarations.
import { act, create } from 'react-test-renderer';

const feed = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed }));
import { bricks, brickView, type Params } from './bricks';
import { annotationWord } from './bricks-knowledge-page';
import { knowledgeAnnotations } from '../../../src/core/boards/bricks';
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
const params: Params = { page: 'pump' };
async function draw(form: Form) {
  await act(async () => { tree?.unmount(); tree = create(h(brickView('knowledge-page').Body, { params, form, act: reported, raise: () => {} })); });
  return tree!;
}
const text = () => JSON.stringify(tree!.toJSON());
const said = (node: Node): string => node.children.map((child) => (typeof child === 'string' ? child : said(child))).join('');
const buttons = () => tree!.root.findAllByType('button').filter((b) => !b.props['data-place']);
const controls = () => tree!.root.findAll((node) => ['button', 'input', 'textarea', 'form', 'a'].includes(node.type) && !node.props['data-place']);
const placed = () => tree!.root.findAll((node) => !!node.props['data-place']).map((node) => JSON.parse(node.props['data-place']));
const press = (label: string) => act(async () => { await buttons().find((b) => said(b) === label)!.props.onClick(); });

const page = { slug: 'pump', title: 'How the pond pump runs', domain: 'pond/pump', updated: '2026-10-01T12:00:00Z', verified_at: '2026-10-20T12:00:00Z', fresh: 'due', by: 'art', recent: null,
  archiveCandidate: false, routineCheckDays: 30, body: 'The pump runs at dawn.\n\nSee [[liner|the liner page]] and [[Bad Slug!]].\n\nThird line.\n\nFourth line, only when big.', sourcing: 'sourced',
  sources: [{ claim: 'Runs at dawn', kind: 'web', locator: 'manual p.4', href: 'https://example.test/manual', excerpt: '', retrievedAt: '2026-10-01', createdAt: '2026-10-01' }],
  citedBy: [{ slug: 'pond-care', title: 'Pond care' }], annotations: [{ id: 3, kind: 'note', actor: 'sam', words: 'Checked the timer.', evidence: '', created: '2026-10-21T12:00:00Z' }],
  checked: { at: '2026-10-20T12:00:00Z', outcome: 'confirmed', by: 'sam' }, checks: [{ at: '2026-10-20T12:00:00Z', outcome: 'confirmed', by: 'sam' }, { at: '2026-09-20T12:00:00Z', outcome: 'stale', by: null }], history: [] };
const all = { allowed: true, canAdd: true, canVerify: true, canRecheck: true };
const world = (access: object | null = all, over: object = {}): Data => ({ MemoryKnowledgePage: { memoryKnowledgePage: { ...page, ...over } }, MemoryKnowledgeAccess: { memoryKnowledgeAccess: access } });

it('draws the page big: title, topic, state, its words, checks, annotations, sources and the pages that cite it', async () => {
  answer(world());
  await draw('primary');
  for (const words of ['How the pond pump runs', 'Due a check', 'verified Oct 20', 'Routine check every 30 days', 'Last check by sam', 'The pump runs at dawn.', 'Fourth line, only when big.',
    'Still true', 'Asked to check again', 'Checked the timer.', 'Runs at dawn', 'manual p.4', 'sourced', 'Written by']) expect(text()).toContain(words);
  // A link to another page is its label in the words and a chip under them. What Knowledge does not read as a link stays as written.
  expect(text()).toContain('See the liner page and [[Bad Slug!]].');
  expect(text()).not.toContain('[[liner');
  expect(placed()).toEqual([
    { brick: 'knowledge', params: { domain: 'pond/pump' } },
    { brick: 'knowledge-page', params: { page: 'liner' } },
    { brick: 'knowledge-page', params: { page: 'pond-care' } },
  ]);
});

it('draws the side form with the title, the state and the first lines, and the compact form as one line with no control', async () => {
  answer(world());
  await draw('side');
  expect(text()).toContain('How the pond pump runs');
  expect(text()).toContain('Due a check');
  expect(text()).toContain('Third line.');
  expect(text()).not.toContain('Fourth line');
  expect(text()).not.toContain('Runs at dawn');
  expect(tree!.root.findAllByType('form')).toEqual([]);
  expect(buttons().map(said)).toEqual(['Still true', 'Check again']);
  await draw('compact');
  const json = tree!.toJSON() as { type: string; props: { className: string } };
  expect(json.type).toBe('p'); expect(json.props.className).toBe('board-brief');
  expect(text()).toContain('How the pond pump runs'); expect(text()).toContain('Due a check');
  expect(controls()).toEqual([]);
  // The compact form does not ask what the member may do.
  expect(feed.mock.calls.filter(([query]) => String(query).includes('MemoryKnowledgeAccess'))).toHaveLength(1);
});

it('says a page that is not there, or that the member may not read, is unavailable, and loading until it answers', async () => {
  for (const form of ['primary', 'side', 'compact'] as const) {
    answer({ MemoryKnowledgePage: { memoryKnowledgePage: null }, MemoryKnowledgeAccess: { memoryKnowledgeAccess: all } });
    await draw(form);
    expect(said(tree!.root as Node), form).toBe('This knowledge page is unavailable.');
    expect(controls()).toEqual([]);
    answer({ MemoryKnowledgePage: undefined, MemoryKnowledgeAccess: undefined });
    await draw(form);
    expect(said(tree!.root as Node), form).toBe('Loading…');
  }
  expect(sent).not.toHaveBeenCalled();
});

it('is headed by its name, with the slug only in the small line', () => {
  expect(bricks['knowledge-page'].title(params)).toBe('Knowledge page');
  expect(bricks['knowledge-page'].sub(params)).toBe('pump');
});

it('Still true and Check again call Knowledge\'s own operations with the slug and report an empty detail', async () => {
  answer(world());
  await draw('side');
  await press('Still true');
  expect(sent).toHaveBeenLastCalledWith('/api/mind/knowledgeVerify', { slug: 'pump' });
  expect(reported).toHaveBeenLastCalledWith('verify', {});
  expect(text()).toContain('Check saved');
  await press('Check again');
  expect(sent).toHaveBeenLastCalledWith('/api/mind/knowledgeRecheck', { slug: 'pump' });
  expect(reported).toHaveBeenLastCalledWith('recheck', {});
});

it('annotating sends the kind and the trimmed words to mind.knowledgeAnnotate and tells the board the kind only', async () => {
  answer(world());
  await draw('primary');
  expect(Object.keys(annotationWord)).toEqual([...knowledgeAnnotations]);
  await press('Out of date');
  const input = tree!.root.findAllByType('input')[0];
  await act(async () => input.props.onChange({ target: { value: '  The timer moved to dusk.  ' } }));
  await act(async () => tree!.root.findAllByType('form')[0].props.onSubmit({ preventDefault() {} }));
  expect(sent).toHaveBeenCalledWith('/api/mind/knowledgeAnnotate', { slug: 'pump', kind: 'outdated', words: 'The timer moved to dusk.' });
  expect(reported).toHaveBeenCalledWith('annotate', { kind: 'outdated' });
  expect(JSON.stringify(reported.mock.calls)).not.toContain('dusk');
  expect(tree!.root.findAllByType('input')[0].props.value).toBe('');
  // Nothing typed, nothing sent.
  sent.mockClear();
  await act(async () => tree!.root.findAllByType('form')[0].props.onSubmit({ preventDefault() {} }));
  expect(sent).not.toHaveBeenCalled();
});

it('reports nothing when the operation fails, and says it did not save', async () => {
  answer(world()); answerOk = false;
  await draw('primary');
  await press('Still true');
  expect(sent).toHaveBeenCalledTimes(1);
  expect(reported).not.toHaveBeenCalled();
  expect(text()).toContain('That did not save.');
});

it('offers a member only what Knowledge says they may do', async () => {
  answer(world({ allowed: true, canAdd: false, canVerify: false, canRecheck: true }));
  await draw('primary');
  expect(buttons().map((b) => [said(b), b.props.disabled])).toEqual([['Still true', true], ['Check again', false]]);
  expect(tree!.root.findAllByType('form')).toEqual([]);
  // Until loom has said what the member may do, there is no control.
  answer({ ...world(), MemoryKnowledgeAccess: undefined });
  await draw('primary');
  expect(buttons()).toEqual([]);
  expect(text()).toContain('How the pond pump runs');
});
