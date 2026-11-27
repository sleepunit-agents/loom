/** This device's choice of where a notification opens, kept where the service worker reads it. */
import { afterEach, expect, it, vi } from 'vitest';
import { opensInBoards, setOpensInBoards } from './notify-target';
import { DEVICE_CACHE, OPEN_IN_BOARDS } from '../../../src/ui/notification-target';

afterEach(() => { vi.unstubAllGlobals(); });
function storage() {
  const kept = new Map<string, Map<string, unknown>>();
  vi.stubGlobal('caches', { open: async (name: string) => {
    const cache = kept.get(name) ?? kept.set(name, new Map()).get(name)!;
    return { match: async (key: string) => cache.get(key), put: async (key: string, value: unknown) => { cache.set(key, value); }, delete: async (key: string) => cache.delete(key) };
  } });
  return kept;
}
it('is off until chosen, kept under the names the worker reads, and off again when unchosen', async () => {
  const kept = storage();
  expect(await opensInBoards()).toBe(false);
  await setOpensInBoards(true);
  expect([...kept.get(DEVICE_CACHE)!.keys()]).toEqual([OPEN_IN_BOARDS]);
  expect(await opensInBoards()).toBe(true);
  await setOpensInBoards(false);
  expect(await opensInBoards()).toBe(false);
});
it('a browser with no cache storage, or a broken one, reads as off and says the choice was not kept', async () => {
  expect(await opensInBoards()).toBe(false);
  await expect(setOpensInBoards(true)).rejects.toThrow();
  vi.stubGlobal('caches', { open: async () => { throw new Error('denied'); } });
  expect(await opensInBoards()).toBe(false);
  await expect(setOpensInBoards(true)).rejects.toThrow('denied');
});
