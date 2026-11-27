/** How a brick's body reaches the page (./bricks.tsx): fetched when it is first drawn, and drawn at once after. */
import { expect, it, vi } from 'vitest';
import { createElement as h, Suspense } from 'react';
// @ts-expect-error Renderer has no bundled declarations.
import { act, create } from 'react-test-renderer';

vi.mock('../data/graphql', () => ({ useDataQuery: () => ({ status: 'error' }) }));
import { brickView } from './bricks';
import { Loading } from './brick-kit';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const body = (name: string) => h(Suspense, { fallback: h(Loading) }, h(brickView(name).Body, { params: { ticket: 't-7' }, form: 'side', act() {}, raise() {} }));
const said = (tree: { toJSON(): { children: string[] } }) => tree.toJSON().children.join('');

it('draws the loading line until a brick\'s module has arrived, and from then on draws the brick at once', async () => {
  let tree!: { toJSON(): { children: string[] }; unmount(): void };
  // Drawn for the first time: the module is asked for, and the placement says so.
  act(() => { tree = create(body('ticket')); });
  expect(said(tree)).toBe('Loading…');
  await act(async () => { await brickView('ticket').load(); });
  expect(said(tree)).toBe('This ticket is unavailable.');
  act(() => tree.unmount());
  // Drawn again, as when a second board shows it: no loading line, in the same pass.
  act(() => { tree = create(body('ticket')); });
  expect(said(tree)).toBe('This ticket is unavailable.');
  act(() => tree.unmount());
});

it('draws a brick whose module was fetched beforehand at once, the first time', async () => {
  await brickView('comments').load();
  let tree!: { toJSON(): { children: string[] }; unmount(): void };
  act(() => { tree = create(body('comments')); });
  expect(said(tree)).toBe('This ticket is unavailable.');
  act(() => tree.unmount());
});

it('fetches a brick\'s module once however often it is asked for', () => {
  expect(brickView('pull').load()).toBe(brickView('pull').load());
});
