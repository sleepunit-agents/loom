/** The board's header row by itself (./board-head.tsx): how many chips its width shows, a chip's words, and the one
 * mark for the whole board. What the page puts in it, and what pressing does, is in ./page.test.tsx. */
import { afterEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import { act, create } from 'react-test-renderer';
import { attentionWords, BoardHead, chipsShown, CHIP_ROOM, MORE_ROOM } from './board-head';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
type Node = { type: string; props: Record<string, any>; findAll(test: (n: Node) => boolean): Node[] };
let tree: { root: Node; unmount(): void } | undefined;
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; });

it('shows every chip that fits, else as many as fit beside a +N, else none and a count', () => {
  expect(chipsShown(1200, 0)).toEqual({ shown: 0, counted: false });
  expect(chipsShown(1200, 5)).toEqual({ shown: 5, counted: false });
  expect(chipsShown(5 * CHIP_ROOM, 5)).toEqual({ shown: 5, counted: false });
  expect(chipsShown(1200, 9)).toEqual({ shown: Math.floor((1200 - MORE_ROOM) / CHIP_ROOM), counted: false });
  expect(chipsShown(CHIP_ROOM + MORE_ROOM, 2)).toEqual({ shown: 1, counted: false });
  expect(chipsShown(CHIP_ROOM + MORE_ROOM - 1, 2)).toEqual({ shown: 0, counted: true });
  expect(chipsShown(0, 1)).toEqual({ shown: 0, counted: true });
});

it('says a chip as the brick\'s name, its reference and its flag word', () => {
  expect(attentionWords({ id: 'p-1', title: 'Pull request', sub: '#2361', flag: 'Look here' })).toBe('Pull request #2361 · look here');
  expect(attentionWords({ id: 'p-2', title: 'Session', sub: '', flag: 'Failed' })).toBe('Session · failed');
});

it('draws one quiet getting-new-data mark for the whole board, and only while something is getting it', async () => {
  const draw = (getting: boolean) => h(BoardHead, { heading: 'Garden', attention: [], onJump() {}, notices: true, stale: false, reload() {}, lost: 0, onTryAll() {}, getting, closed: false, onClose() {}, onReopen() {} });
  await act(async () => { tree = create(draw(false), { createNodeMock: () => ({ clientWidth: 800 }) }); });
  const marks = () => tree!.root.findAll((n) => n.props.className === 'boards-getting');
  expect(marks()).toEqual([]);
  await act(async () => (tree as unknown as { update(e: unknown): void }).update(draw(true)));
  expect(marks().map((m) => [m.props.role, m.props['aria-label']])).toEqual([['status', 'Getting new data']]);
});
