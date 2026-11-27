/** This device's choice of where a notification opens: the boards page, or the desktop as before. Kept in the
 * browser's cache storage, where the service worker reads it when a notification is clicked (src/next-pwa.ts);
 * the names are stated once in src/ui/notification-target.ts. A device's choice, not a member's: a phone keeps the
 * phone's app while a desk opens boards, and loom's records are not touched. */
import { DEVICE_CACHE, OPEN_IN_BOARDS } from '../../../src/ui/notification-target';

export async function opensInBoards(): Promise<boolean> {
  try { return typeof caches !== 'undefined' && !!(await (await caches.open(DEVICE_CACHE)).match(OPEN_IN_BOARDS)); } catch { return false; }
}
/** Throws when the browser keeps no cache storage here: the choice was not kept, and the caller says so. */
export async function setOpensInBoards(on: boolean): Promise<void> {
  const cache = await caches.open(DEVICE_CACHE);
  if (on) await cache.put(OPEN_IN_BOARDS, new Response('1'));
  else await cache.delete(OPEN_IN_BOARDS);
}
