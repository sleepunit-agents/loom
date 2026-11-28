/** The session brick's big form (./bricks-session.tsx) draws its Tools fact only when the session reports a tool count,
 * and a handed-off session's report as the last message of its conversation, only when there is one. */
import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import { act, create } from 'react-test-renderer';

const f = vi.hoisted(() => ({ tools: null as { name: string; count: number | null }[] | null, venue: 'direct', report: null as { words: string | null } | null }));
vi.mock('../data/graphql', () => ({ useDataQuery: (document: string) => {
  if (document.includes('BrickSessionReport')) return { status: 'live', data: { report: f.report } };
  if (document.includes('BrickSessionJob')) return { status: 'live', data: { rows: [{ brief: null, logTail: null, endedNote: null, claimedAt: null, endedAt: null }] } };
  if (document.includes('BrickSessionTrace') || document.includes('BrickSessionStep')) return { status: 'live', data: { steps: [], gone: false } };
  return { status: 'live', data: { jobs: [{ id: 'job-1', title: 'Fictional session', state: 'done', queuedAt: '2026-11-27T10:00:00.000Z', usage: { model: 'fictional-model', harness: 'claude', tools: f.tools } }], cv: { agent: 'art', label: 'Fictional session', venue: f.venue } } };
} }));
vi.mock('../data/operation', () => ({ memberOperation: vi.fn() }));
import { brickView, loadBricks } from './bricks';

await loadBricks();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
afterEach(async () => { await act(async () => tree?.unmount()); f.tools = null; f.venue = 'direct'; f.report = null; });

type Node = { type: string; children: (Node | string)[] };
const draw = async () => {
  await act(async () => { tree = create(h(brickView('session').Body, { params: { session: 'cv-1' }, form: 'primary', act: () => {}, raise: () => {} })); });
};
const text = (node: Node | string): string => (typeof node === 'string' ? node : node.children.map(text).join(''));
const labels = () => tree.root.findAll((node: Node) => node.type === 'dt').map(text);

it('draws no Tools label when the session reports no tool counts', async () => {
  for (const tools of [null, [], [{ name: 'Bash', count: 0 }, { name: 'Read', count: null }]]) {
    f.tools = tools;
    await draw();
    // The other facts still draw, so the big form is the one under test.
    expect(labels()).toContain('Running on');
    expect(labels()).not.toContain('Tools');
    await act(async () => tree.unmount());
  }
});

it('draws the Tools label and the count when the session reports one', async () => {
  f.tools = [{ name: 'Bash', count: 2 }, { name: 'Read', count: 0 }];
  await draw();
  expect(labels()).toContain('Tools');
  // A zero count is left out; the one real count is drawn beside its tool.
  const counts = tree.root.findAll((node: Node & { props: Record<string, unknown> }) => node.type === 'span' && node.props.className === 'board-tool-counts');
  expect(counts).toHaveLength(1);
  expect(text(counts[0])).toBe('Bash ×2');
});

const headings = () => tree.root.findAll((node: Node) => node.type === 'h3').map(text);

const reported = () => tree.root.findAll((node: Node & { props: Record<string, unknown> }) => node.props['data-session-report'] === '' && typeof node.type === 'string');
it('shows a handed-off session\'s report, as message words, as the last message of its conversation', async () => {
  f.venue = 'handoff'; f.report = { words: 'The fictional plan is **done**.' };
  await draw();
  expect(headings()).toEqual(['Conversation']);
  expect(reported()).toHaveLength(1);
  expect(text(reported()[0])).toContain('Art · Report');
  expect(text(reported()[0])).toContain('The fictional plan is');
  expect(reported()[0].findAll((node: Node) => node.type === 'strong').map(text)).toEqual(['done']);
  // It is last: nothing of the conversation follows it.
  const log = tree.root.find((node: Node & { props: Record<string, unknown> }) => node.props['data-session-trace'] === '');
  expect((log.children as unknown as { props: Record<string, unknown> }[]).at(-1)!.props['data-session-report']).toBe('');
});

it('draws nothing for the report when there is none', async () => {
  f.venue = 'handoff';
  for (const report of [null, { words: null }]) {
    f.report = report;
    await draw();
    expect(headings()).toEqual(['Conversation']);
    expect(reported()).toHaveLength(0);
    expect(text(tree.root)).not.toContain('Report');
    await act(async () => tree.unmount());
  }
});
