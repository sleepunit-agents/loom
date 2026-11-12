import { expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ token: undefined as undefined | (() => string) }));
vi.mock('../../web/src/collections/transport', () => ({ pageTransport: (csrf: () => string) => { h.token = csrf; return {}; } }));
vi.mock('../../web/src/collections/adapter', () => ({ makeRuntime: () => ({ runtime: { isCleared: () => false }, stores: {} }) }));
import { collectionsRuntime } from '../../web/src/page';
it('the first shared transport uses the latest caller’s credential after rotation', async () => {
  const first = await collectionsRuntime(() => 'first'); const retainedGetter = h.token!;
  expect(retainedGetter()).toBe('first');
  expect(await collectionsRuntime(() => 'second')).toBe(first);
  expect(h.token).toBe(retainedGetter); expect(retainedGetter()).toBe('second');
});
