/** The session brick's big form draws its Tools fact only when the session reports a tool count (./bricks-session.tsx). */
import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import { act, create } from 'react-test-renderer';

const f = vi.hoisted(() => ({ tools: null as { name: string; count: number | null }[] | null }));
vi.mock('../data/graphql', () => ({ useDataQuery: (document: string) => {
  if (document.includes('BrickSessionJob')) return { status: 'live', data: { rows: [{ brief: null, logTail: null, endedNote: null, claimedAt: null, endedAt: null }] } };
  if (document.includes('BrickSessionTrace') || document.includes('BrickSessionStep')) return { status: 'live', data: { steps: [], gone: false } };
  return { status: 'live', data: { jobs: [{ id: 'job-1', title: 'Fictional session', state: 'done', queuedAt: '2026-11-27T10:00:00.000Z', usage: { model: 'fictional-model', harness: 'claude', tools: f.tools } }], cv: { agent: 'art', label: 'Fictional session', venue: 'direct' } } };
} }));
vi.mock('../data/operation', () => ({ memberOperation: vi.fn() }));
import { brickView, loadBricks } from './bricks';

await loadBricks();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
afterEach(async () => { await act(async () => tree?.unmount()); f.tools = null; });

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
  const counts = tree.root.findAll((node: Node & { props: Record<string, unknown> }) => node.type === 'span' && node.props.className === 'board-tools');
  expect(counts).toHaveLength(1);
  expect(text(counts[0])).toBe('Bash ×2');
});
