/** The served worker and the boards page (ui/notification-target.ts): a notification's click opens the boards page,
 * the only page after sign-in. The worker's source is run as it is served, with the browser's objects faked; no
 * browser and no push service. */
import { expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { nextWorker, MANIFEST, BOARDS_MANIFEST } from './next-pwa.js';
import { BOARDS_ADDRESS, BOARDS_HOME, boardsThreadPath } from './ui/notification-target.js';

type Win = { url: string; navigate: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> };
const win = (path: string): Win => ({ url: 'https://loom.test' + path, navigate: vi.fn(async () => {}), focus: vi.fn(async () => {}) });
function worker(windows: Win[] = []) {
  const handlers: Record<string, (event: any) => void> = {};
  const show = vi.fn(async (_title: string, _options: any) => {}), open = vi.fn(async (_url: string) => {});
  const deleted: string[] = [];
  const caches = { keys: async () => ['loom-next-static-old', 'loom-device'], delete: async (key: string) => { deleted.push(key); } };
  runInNewContext(nextWorker([]), {
    URL, location: { origin: 'https://loom.test' }, caches,
    self: { addEventListener: (name: string, fn: any) => { handlers[name] = fn; }, registration: { showNotification: show }, clients: { matchAll: async () => windows, openWindow: open, claim() {} } },
  });
  const run = async (name: string, event: object) => { let work: Promise<unknown> | undefined; handlers[name]({ ...event, waitUntil: (p: Promise<unknown>) => { work = p; } }); await work; };
  return {
    show, open, deleted,
    push: (payload: unknown) => run('push', { data: { json: () => payload } }),
    click: (data: unknown) => run('notificationclick', { notification: { data, close() {} } }),
    activate: () => run('activate', {}),
  };
}
const home = 'https://loom.test' + BOARDS_HOME, thread = 'https://loom.test' + boardsThreadPath('th:pump');

it('names the boards addresses once, and a thread\'s address is one of them', () => {
  for (const path of [BOARDS_HOME, '/app/b/board-1', boardsThreadPath('th:pump'), boardsThreadPath('a/b')]) expect(BOARDS_ADDRESS.test(path), path).toBe(true);
  for (const path of ['/', '/app/', '/app/t/', '/app/t/a/b', '/p/inbox-preview', '/app/assets/x.js']) expect(BOARDS_ADDRESS.test(path), path).toBe(false);
});

it('keeps the thread\'s boards address, from either field, and takes anything else to the boards page\'s home', async () => {
  const f = worker();
  await f.push({ tag: 'loom-inbox', url: boardsThreadPath('th:pump'), board: boardsThreadPath('th:pump') });
  expect(f.show.mock.lastCall![1].data).toEqual({ board: thread });
  // A push sent while there was a desktop: the desktop's address in `url`, the thread's in `board`.
  await f.push({ tag: 'loom-inbox', url: '/p/inbox-preview', board: boardsThreadPath('th:pump') });
  expect(f.show.mock.lastCall![1].data).toEqual({ board: thread });
  await f.push({ url: BOARDS_HOME });
  expect(f.show.mock.lastCall![1].data).toEqual({ board: home });
  for (const board of ['https://elsewhere.test/app/t/x', '//elsewhere.test/app/t/x', '/p/account-preview', '/app/t/a/b', 'javascript:alert(1)', 42, null, { path: '/app/boards' }]) {
    await f.push({ url: '/p/inbox-preview', board });
    expect(f.show.mock.lastCall![1].data, String(board)).toEqual({ board: home });
  }
});

it('with no loom window open, a click opens the boards page: the thread, or its home', async () => {
  const f = worker();
  await f.click({ board: thread });
  expect(f.open).toHaveBeenLastCalledWith(thread);
  await f.click({});
  expect(f.open).toHaveBeenLastCalledWith(home);
  await f.click({ board: 'https://elsewhere.test/app/t/x' });
  expect(f.open).toHaveBeenLastCalledWith(home);
  // A notification shown by a worker from before the desktop was removed: its data held the desktop's address.
  await f.click({ url: 'https://loom.test/p/inbox-preview' });
  expect(f.open).toHaveBeenLastCalledWith(home);
  await f.click({ url: 'https://loom.test/p/comms-preview/thread/pump', board: thread });
  expect(f.open).toHaveBeenLastCalledWith(thread);
});

it('an open boards page is preferred, and left where it is unless the click names another thread', async () => {
  const page = win('/app/b/board-1'), other = win('/'), f = worker([other, page]);
  await f.click({ board: thread });
  expect(page.navigate).toHaveBeenCalledExactlyOnceWith(thread); expect(page.focus).toHaveBeenCalledOnce();
  expect(other.navigate).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
  // No thread is named (an approval, a notice): the open page is shown as it stands, not loaded again.
  const still = win('/app/b/board-1'), g = worker([still]);
  await g.click({ board: home });
  expect(still.navigate).not.toHaveBeenCalled(); expect(still.focus).toHaveBeenCalledOnce(); expect(g.open).not.toHaveBeenCalled();
  // Already at the thread: focused, not loaded again.
  const there = win(boardsThreadPath('th:pump')), h = worker([there]);
  await h.click({ board: thread });
  expect(there.navigate).not.toHaveBeenCalled(); expect(there.focus).toHaveBeenCalledOnce();
});

it('takes any other loom window to the boards page when no boards page is open, and passes over a closing one', async () => {
  const gate = win('/'), f = worker([gate]);
  await f.click({ board: home });
  expect(gate.navigate).toHaveBeenCalledExactlyOnceWith(home); expect(gate.focus).toHaveBeenCalledOnce();
  const closing = win('/app/boards'); closing.navigate.mockRejectedValue(new Error('closed'));
  const lost = worker([closing]);
  await lost.click({ board: thread });
  expect(lost.open).toHaveBeenCalledExactlyOnceWith(thread);
});

it('a new worker removes every old cache, the device choice a desktop-era page kept among them', async () => {
  const f = worker(); await f.activate();
  expect(f.deleted).toEqual(['loom-next-static-old', 'loom-device']);
});

it('both manifests open at the boards page; the first keeps the id it was installed with', () => {
  const boards = JSON.parse(BOARDS_MANIFEST), first = JSON.parse(MANIFEST);
  expect(boards).toMatchObject({ id: BOARDS_HOME, start_url: BOARDS_HOME, scope: '/', display: 'standalone' });
  expect(boards.icons).toEqual(first.icons);
  expect(first).toMatchObject({ id: '/', start_url: BOARDS_HOME, scope: '/', display: 'standalone', orientation: 'portrait', name: 'loom' });
});
