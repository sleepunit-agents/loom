/** The served worker and the boards page (ui/notification-target.ts): which address a notification's click opens.
 * The worker's source is run as it is served, with the browser's objects faked; no browser and no push service. */
import { expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { nextWorker, MANIFEST, BOARDS_MANIFEST } from './next-pwa.js';
import { BOARDS_ADDRESS, BOARDS_HOME, DEVICE_CACHE, OPEN_IN_BOARDS, boardsThreadPath } from './ui/notification-target.js';

type Win = { url: string; navigate: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> };
const win = (path: string): Win => ({ url: 'https://loom.test' + path, navigate: vi.fn(async () => {}), focus: vi.fn(async () => {}) });
function worker(windows: Win[] = [], options: { chose?: boolean; caches?: 'none' | 'broken' } = {}) {
  const handlers: Record<string, (event: any) => void> = {};
  const show = vi.fn(async (_title: string, _options: any) => {}), open = vi.fn(async (_url: string) => {});
  const asked: string[][] = [], deleted: string[] = [];
  const caches = options.caches === 'none' ? undefined : {
    open: async (name: string) => { if (options.caches === 'broken') throw new Error('no storage'); return { match: async (key: string) => { asked.push([name, key]); return options.chose ? {} : undefined; } }; },
    keys: async () => ['loom-next-static-old', DEVICE_CACHE], delete: async (key: string) => { deleted.push(key); },
  };
  runInNewContext(nextWorker([]), {
    URL, location: { origin: 'https://loom.test' }, ...(caches ? { caches } : {}),
    self: { addEventListener: (name: string, fn: any) => { handlers[name] = fn; }, registration: { showNotification: show }, clients: { matchAll: async () => windows, openWindow: open, claim() {} } },
  });
  const run = async (name: string, event: object) => { let work: Promise<unknown> | undefined; handlers[name]({ ...event, waitUntil: (p: Promise<unknown>) => { work = p; } }); await work; };
  return {
    show, open, asked, deleted,
    push: (payload: unknown) => run('push', { data: { json: () => payload } }),
    click: (data: unknown) => run('notificationclick', { notification: { data, close() {} } }),
    activate: () => run('activate', {}),
  };
}
const desktop = 'https://loom.test/p/inbox-preview', thread = 'https://loom.test' + boardsThreadPath('th:pump');

it('names the boards addresses once, and a thread\'s address is one of them', () => {
  for (const path of [BOARDS_HOME, '/app/b/board-1', boardsThreadPath('th:pump'), boardsThreadPath('a/b')]) expect(BOARDS_ADDRESS.test(path), path).toBe(true);
  for (const path of ['/', '/app/', '/app/t/', '/app/t/a/b', '/p/inbox-preview', '/app/assets/x.js']) expect(BOARDS_ADDRESS.test(path), path).toBe(false);
});

it('keeps the thread\'s boards address beside the desktop\'s, and drops one that is not a boards address', async () => {
  const f = worker();
  await f.push({ tag: 'loom-inbox', url: '/p/inbox-preview', board: boardsThreadPath('th:pump') });
  expect(f.show.mock.lastCall![1].data).toEqual({ url: desktop, board: thread });
  for (const board of ['https://elsewhere.test/app/t/x', '//elsewhere.test/app/t/x', '/p/account-preview', '/app/t/a/b', 'javascript:alert(1)', 42, null, { path: '/app/boards' }]) {
    await f.push({ url: '/p/inbox-preview', board });
    expect(f.show.mock.lastCall![1].data, String(board)).toEqual({ url: desktop });
  }
});

it('a device that did not choose boards opens the desktop\'s address exactly as before, whatever the push names', async () => {
  for (const caches of [undefined, 'none', 'broken'] as const) {
    const none = worker([], { caches });
    await none.click({ url: desktop, board: thread });
    expect(none.open).toHaveBeenCalledExactlyOnceWith(desktop);
    const desk = win('/p/tasks-preview'), page = win('/app/b/board-1'), mixed = worker([desk, page], { caches });
    await mixed.click({ url: desktop, board: thread });
    expect(desk.navigate).toHaveBeenCalledExactlyOnceWith(desktop); expect(desk.focus).toHaveBeenCalledOnce();
    expect(page.navigate).not.toHaveBeenCalled(); expect(page.focus).not.toHaveBeenCalled(); expect(mixed.open).not.toHaveBeenCalled();
  }
  const f = worker(); await f.click({ url: desktop, board: thread });
  expect(f.asked).toEqual([[DEVICE_CACHE, OPEN_IN_BOARDS]]);
});

it('when the only loom windows open are boards pages, the click goes to one of them', async () => {
  const page = win('/app/b/board-1'), f = worker([page]);
  await f.click({ url: desktop, board: thread });
  expect(page.navigate).toHaveBeenCalledExactlyOnceWith(thread); expect(page.focus).toHaveBeenCalledOnce(); expect(f.open).not.toHaveBeenCalled();
  // No thread is named (an approval, a notice): the open page is shown as it stands, not loaded again.
  const still = win('/app/b/board-1'), g = worker([still]);
  await g.click({ url: desktop });
  expect(still.navigate).not.toHaveBeenCalled(); expect(still.focus).toHaveBeenCalledOnce(); expect(g.open).not.toHaveBeenCalled();
  // Already at the thread: focused, not loaded again.
  const there = win(boardsThreadPath('th:pump')), h = worker([there]);
  await h.click({ url: desktop, board: thread });
  expect(there.navigate).not.toHaveBeenCalled(); expect(there.focus).toHaveBeenCalledOnce();
});

it('a device that chose boards opens the thread there, or the boards home when the push names no thread', async () => {
  const none = worker([], { chose: true });
  await none.click({ url: desktop, board: thread });
  expect(none.open).toHaveBeenLastCalledWith(thread);
  await none.click({ url: desktop });
  expect(none.open).toHaveBeenLastCalledWith('https://loom.test' + BOARDS_HOME);
  await none.click({ url: desktop, board: 'https://elsewhere.test/app/t/x' });
  expect(none.open).toHaveBeenLastCalledWith('https://loom.test' + BOARDS_HOME);
  // An open boards page is preferred to a desktop window; a desktop window is taken to boards when it is all there is.
  const desk = win('/p/tasks-preview'), page = win('/app/boards'), both = worker([desk, page], { chose: true });
  await both.click({ url: desktop, board: thread });
  expect(page.navigate).toHaveBeenCalledExactlyOnceWith(thread); expect(page.focus).toHaveBeenCalledOnce(); expect(desk.navigate).not.toHaveBeenCalled();
  const only = win('/p/tasks-preview'), alone = worker([only], { chose: true });
  await alone.click({ url: desktop });
  expect(only.navigate).toHaveBeenCalledExactlyOnceWith('https://loom.test' + BOARDS_HOME); expect(only.focus).toHaveBeenCalledOnce();
  // A window that is closing is passed over.
  const closing = win('/app/boards'); closing.navigate.mockRejectedValue(new Error('closed'));
  const lost = worker([closing], { chose: true });
  await lost.click({ url: desktop, board: thread });
  expect(lost.open).toHaveBeenCalledExactlyOnceWith(thread);
});

it('a new worker removes old build caches and keeps the device\'s own choices', async () => {
  const f = worker(); await f.activate();
  expect(f.deleted).toEqual(['loom-next-static-old']);
});

it('the boards manifest opens at the boards page and leaves the desktop\'s manifest as it was', () => {
  const boards = JSON.parse(BOARDS_MANIFEST), desk = JSON.parse(MANIFEST);
  expect(boards).toMatchObject({ id: BOARDS_HOME, start_url: BOARDS_HOME, scope: '/', display: 'standalone' });
  expect(boards.icons).toEqual(desk.icons);
  expect(desk).toMatchObject({ id: '/', start_url: '/', scope: '/', display: 'standalone', orientation: 'portrait', name: 'loom' });
});
