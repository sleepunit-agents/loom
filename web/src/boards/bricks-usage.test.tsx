/** The `usage` brick (docs/specs/boards.md, "The first bricks"). The data hook is a fake and so is `fetch`, which
 * nothing here should call: the brick is read-only. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer does not ship declarations.
import { act, create } from 'react-test-renderer';

const feed = vi.hoisted(() => vi.fn());
vi.mock('../data/graphql', () => ({ useDataQuery: feed }));
import { bricks, brickView, loadBricks, type Params } from './bricks';
import type { Form } from './layout';

await loadBricks();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Node = { type: string; props: Record<string, any>; children: (Node | string)[]; findAll(match: (node: Node) => boolean): Node[]; findAllByType(type: string): Node[] };
let tree: { root: Node; toJSON(): unknown; unmount(): void } | undefined;
const sent = vi.fn(), reported = vi.fn();
const group = (key: string | null, title: string | null, totalTokens: number | null, over: object = {}) => ({ key, title, totalTokens, jobCount: 2, retryCount: 1, largestContext: 812, jobsWithLargestContext: 1, ...over });
const rollup = [group('cv-small', 'Small talk', 10), group('cv-large', 'Large talk', 9990), group(null, null, null, { jobCount: 1 }), group('not a ref!', 'Odd key', 5)];
const job = { id: 'j-one', title: 'Inspect parser', runKind: 'subagent', linkedWakeJob: 'j-wake', state: 'done', observations: ['Large context with no tool calls.'],
  usage: { harness: 'codex', model: 'test-model', source: 'report', tokensIn: 1200, tokensOut: 34, cacheRead: null, cacheWritten: 0, modelCalls: 3, toolCalls: 2, tools: [{ name: 'shell', count: 2 }], firstContext: 100, largestContext: 812, wallMs: 4000 } };
let world: { status: string; rows: object[] };
beforeEach(() => {
  feed.mockReset(); sent.mockReset(); reported.mockReset(); world = { status: 'live', rows: rollup };
  feed.mockImplementation((query: string) => {
    if (world.status !== 'live') return { status: world.status };
    if (query.startsWith('query UsageConversations')) return { status: 'live', data: { jobUsageRollup: world.rows } };
    if (query.startsWith('query UsageJobs')) return { status: 'live', data: { conversationJobUsage: [job, { id: 'j-two', title: '', runKind: null, linkedWakeJob: null, state: 'running', observations: [], usage: null }] } };
    throw new Error('A read the usage brick should not make: ' + query);
  });
  vi.stubGlobal('fetch', async (url: string) => { sent(url); return { ok: false, status: 500, json: async () => ({ ok: false }) }; });
});
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; vi.unstubAllGlobals(); });

async function draw(form: Form, params: Params = { days: 7 }) {
  await act(async () => { tree?.unmount(); tree = create(h(brickView('usage').Body, { params, form, act: reported, raise: () => {} })); });
}
const said = (node: Node): string => node.children.map((child) => (typeof child === 'string' ? child : said(child))).join('');
const shown = () => said(tree!.root as Node);
const buttons = () => tree!.root.findAllByType('button').filter((b) => !b.props['data-place']);
const controls = () => tree!.root.findAll((node) => ['button', 'input', 'textarea', 'form', 'a', 'select'].includes(node.type) && !node.props['data-place']);
const placed = () => tree!.root.findAll((node) => !!node.props['data-place']).map((node) => [JSON.parse(node.props['data-place']), said(node)]);
const rollupCall = () => feed.mock.calls.filter(([query]) => String(query).startsWith('query UsageConversations')).at(-1)!;

it('lists conversations by reported tokens as Job usage does, each with a conversation a session chip', async () => {
  await draw('primary');
  // The total leads; the rest of the count is the quiet line under it.
  for (const words of [`${(10005).toLocaleString()} tokens reported`, '7 jobs · 4 conversations · the last 7 days']) expect(shown(), words).toContain(words);
  expect(placed()).toEqual([[{ brick: 'session', params: { session: 'cv-large' } }, 'Large talk'], [{ brick: 'session', params: { session: 'cv-small' } }, 'Small talk']]);
  const text = shown();
  expect(text.indexOf('Large talk')).toBeLessThan(text.indexOf('Small talk'));
  expect(text.indexOf('Odd key')).toBeLessThan(text.indexOf('Jobs without a conversation'));
  for (const words of ['1 retries · peak context 812 (1 of 2 measured)', 'Unknown tokens']) expect(text, words).toContain(words);
});

it('asks for the last day, seven days or thirty local days, ending at the next local midnight', async () => {
  for (const days of [1, 7, 30]) {
    await draw('side', { days });
    const { from, to } = rollupCall()[1] as { from: string; to: string };
    const end = new Date(); end.setHours(0, 0, 0, 0); end.setDate(end.getDate() + 1);
    const start = new Date(end); start.setDate(start.getDate() - days);
    expect([from, to], String(days)).toEqual([start.toISOString(), end.toISOString()]);
  }
});

it('lists one picked conversation\'s jobs in the same range, and a picked job\'s measurements under Job usage\'s names', async () => {
  await draw('primary');
  const jobsButtons = buttons().filter((b) => said(b) === 'Jobs');
  expect(jobsButtons).toHaveLength(4);
  await act(async () => jobsButtons[0].props.onClick());
  const call = feed.mock.calls.find(([query]) => String(query).startsWith('query UsageJobs'))!;
  expect(call[1]).toEqual({ ...(rollupCall()[1] as object), conversation: 'cv-large' });
  for (const words of ['Inspect parser', 'Subagent · done', `${(1200).toLocaleString()} in · 34 out`, 'j-two', 'Unknown in · Unknown out']) expect(shown(), words).toContain(words);
  await act(async () => buttons().find((b) => said(b) === 'Inspect parser')!.props.onClick());
  for (const words of ['Job ID', 'j-one', 'Woke job', 'j-wake', 'Harness', 'codex', 'test-model', 'Input tokens', 'Cache read', 'Unknown', 'Wall time (ms)', 'shell × 2', 'Source', 'report', 'Large context with no tool calls.'])
    expect(shown(), words).toContain(words);
  // The jobs with no conversation are asked for with none.
  await act(async () => buttons().filter((b) => said(b) === 'Jobs')[3].props.onClick());
  expect(feed.mock.calls.filter(([query]) => String(query).startsWith('query UsageJobs')).at(-1)![1]).toMatchObject({ conversation: null });
  expect(reported).not.toHaveBeenCalled(); expect(sent).not.toHaveBeenCalled();
});

it('draws the side form as a short list and the compact form as one line, neither with a control', async () => {
  world.rows = Array.from({ length: 9 }, (_, i) => group('cv-' + i, 'Talk ' + i, 100 - i));
  await draw('side');
  expect(placed()).toHaveLength(4);
  expect(shown()).toContain('and 5 more');
  expect(controls()).toEqual([]);
  await draw('compact', { days: 1 });
  const json = tree!.toJSON() as { type: string; props: { className: string } };
  expect(json.type).toBe('p'); expect(json.props.className).toBe('board-brief');
  expect(shown()).toBe('864 tokens reported · 18 jobs · 9 conversations · today');
  expect(controls()).toEqual([]);
  world.rows = [];
  await draw('compact');
  expect(shown()).toBe('No jobs in the last 7 days');
});

it('says the report is unavailable when loom does not answer it, and loading until it does', async () => {
  for (const form of ['primary', 'side', 'compact'] as const) {
    world.status = 'error';
    await draw(form);
    expect(shown(), form).toBe('This usage report is unavailable.');
    expect(controls()).toEqual([]);
    world.status = 'loading';
    await draw(form);
    expect(shown(), form).toBe('Loading…');
  }
});

it('is headed by its name, and its days are only in the small line', () => {
  expect(bricks.usage.title({ days: 30 })).toBe('Job usage');
  expect(bricks.usage.sub({ days: 30 })).toBe('30 days');
  expect(bricks.usage.sub({ days: 1 })).toBe('1 day');
});
