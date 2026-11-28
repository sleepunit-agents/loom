/** Where a notification leads, and the few names the server, the service worker and the pages must agree on.
 * Stated here once. Plain values and functions: the server, the worker's source (next-pwa.ts) and the web pages
 * all import this file.
 *
 * A click always opens the boards page, the only page after sign-in. A push carries the boards page's address in
 * `url`: the thread's when its item belongs to one of the member's own threads, the boards page's home otherwise.
 * It carries the thread's address in `board` too, as pushes did when there was a desktop; a worker installed before
 * the desktop was removed opens `url` unless the device chose the boards page, so it lands there too. */

/** The boards page's addresses: its home, one board, one thread. Each holds one id and nothing else. */
export const BOARDS_ADDRESS = /^\/app\/(boards|b\/[^/]+|t\/[^/]+)$/;
export const BOARDS_HOME = '/app/boards';
export const boardsThreadPath = (thread: string) => '/app/t/' + encodeURIComponent(thread);

/** A notification device's public reference is the SHA-256, in hex, of these words and its push endpoint. */
export const NOTIFICATION_DEVICE_REF = 'notification-device:';
