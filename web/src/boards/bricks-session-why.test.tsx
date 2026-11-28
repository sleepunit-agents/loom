/** The session brick's "Why it failed": the plain words loom built for a failed job's reason, the last message of its
 * conversation (./bricks-session.tsx, ./session-trace.tsx). */
import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import { act, create } from 'react-test-renderer';

const f = vi.hoisted(() => ({ state: 'failed', failedWhy: null as string | null | undefined, asked: [] as string[] }));
vi.mock('../data/graphql', () => ({ useDataQuery: (document: string) => {
  f.asked.push(document);
  if (document.includes('BrickSessionJob')) return { status: 'live', data: { rows: [{ brief: null, logTail: null, endedNote: null, claimedAt: null, endedAt: null, ...(f.failedWhy === undefined ? {} : { failedWhy: f.failedWhy }) }] } };
  if (document.includes('BrickSessionTrace') || document.includes('BrickSessionStep')) return { status: 'live', data: { steps: [], gone: false } };
  return { status: 'live', data: { jobs: [{ id: 'job-1', title: 'Fictional session', state: f.state, queuedAt: '2026-11-27T10:00:00.000Z', usage: null }], cv: { agent: 'art', label: 'Fictional session', venue: 'handoff' } } };
} }));
vi.mock('../data/operation', () => ({ memberOperation: vi.fn() }));
import { brickView, loadBricks } from './bricks';

await loadBricks();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReturnType<typeof create>;
afterEach(async () => { await act(async () => tree?.unmount()); f.state = 'failed'; f.failedWhy = null; f.asked.length = 0; });

type Node = { type: string; children: (Node | string)[] };
const draw = async (form = 'primary') => {
  await act(async () => { tree = create(h(brickView('session').Body, { params: { session: 'cv-1' }, form, act: () => {}, raise: () => {} })); });
};
const text = (node: Node | string): string => (typeof node === 'string' ? node : node.children.map(text).join(''));
const failure = () => tree.root.findAll((node: Node & { props: Record<string, unknown> }) => node.props['data-session-failure'] === '' && typeof node.type === 'string').map(text);
const facts = () => Object.fromEntries(tree.root.findAll((node: Node) => node.type === 'dt').map((label: Node & { parent: Node }) => [text(label), text(label.parent).slice(text(label).length)]));

it('says why a failed session failed, in the words loom built from its reason', async () => {
  f.failedWhy = 'the model\'s usage limit was reached; it resets Nov 27, 7:00 PM';
  await draw();
  expect(failure()).toEqual(['Why it failedThe model\'s usage limit was reached; it resets Nov 27, 7:00 PM.']);
  expect(Object.keys(facts())).not.toContain('Why it failed');
  // Read with the rest of the job's detail, from the read the brick already makes.
  expect(f.asked.find((document) => document.includes('BrickSessionJob'))).toContain('failedWhy');
});
it('draws no such message for a failure with no reason kept, a session that did not fail, or a small form', async () => {
  for (const [state, failedWhy] of [['failed', null], ['failed', undefined], ['done', 'the session ran out of memory'], ['running', 'the session ran out of memory'], ['stopped', 'the session ran out of memory']] as const) {
    f.state = state; f.failedWhy = failedWhy;
    await draw();
    expect(failure()).toEqual([]);
    await act(async () => tree.unmount());
  }
  f.state = 'failed'; f.failedWhy = 'the session ran out of memory';
  for (const form of ['side', 'compact']) { await draw(form); expect(JSON.stringify(tree.toJSON())).not.toContain('Why it failed'); await act(async () => tree.unmount()); }
});
