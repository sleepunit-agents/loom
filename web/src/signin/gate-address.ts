/** The sign-in gate and the boards page hand a visitor to each other by address (docs/specs/boards.md, "Sign-in").
 * Plain functions, no React: the gate (shell/main.tsx) and the boards page (boards/main.tsx) both import this file.
 *
 * The gate is the page loom serves at every address that is not the boards page's (src/shared-web.ts): the root, and
 * every address the desktop had. Signed out, it is the sign-in page. Signed in, it goes on to the boards page:
 * - to the boards address it was sent from (`?to=`), when the boards page sent a signed-out visitor there;
 * - to a thread's boards address, when it is at the desktop's address for that thread, as an old link or bookmark
 *   still names it (`/p/comms-preview/thread/<id>`, which held the thread's id without its `th:`);
 * - to the boards page's home otherwise. */
import { BOARDS_ADDRESS, BOARDS_HOME, boardsThreadPath } from '../../../src/ui/notification-target';

/** The gate's address for a signed-out visitor at `path` on the boards page: it comes back there once signed in. */
export function gateFor(path: string): string {
  return BOARDS_ADDRESS.test(path) && path !== BOARDS_HOME ? '/?to=' + encodeURIComponent(path) : '/';
}

/** Where the gate goes once the visitor is signed in, from its own address. Only ever one of the boards page's. */
export function afterSignin(pathname: string, search: string): string {
  let to: string | null = null;
  try { to = new URLSearchParams(search).get('to'); } catch { /* no usable query */ }
  if (to && BOARDS_ADDRESS.test(to)) return to;
  const thread = /^\/p\/comms-preview\/thread\/([^/]+)$/.exec(pathname)?.[1];
  if (thread) {
    try { return boardsThreadPath('th:' + decodeURIComponent(thread)); } catch { /* a malformed id: the home */ }
  }
  return BOARDS_HOME;
}
