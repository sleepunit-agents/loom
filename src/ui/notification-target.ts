/** Where a notification leads, and the few names the server, the service worker and the pages must agree on.
 * Stated here once. Plain values and functions: the server, the worker's source (next-pwa.ts) and the web pages
 * all import this file.
 *
 * A push always carries the desktop's address (`url`). When its Inbox item belongs to a thread it also carries
 * that thread's address on the boards page (`board`). Which of the two a click opens is decided on the device,
 * by the worker: the boards address when this device chose "open notifications in the boards page", or when the
 * only loom windows open are boards pages; the desktop's address otherwise, as before. */

/** The boards page's addresses: its home, one board, one thread. Each holds one id and nothing else. */
export const BOARDS_ADDRESS = /^\/app\/(boards|b\/[^/]+|t\/[^/]+)$/;
export const BOARDS_HOME = '/app/boards';
export const boardsThreadPath = (thread: string) => '/app/t/' + encodeURIComponent(thread);
/** The same thread in the desktop's Comms, as the desktop links it (web/src/pieces/comms/shared-query.ts). */
export const desktopThreadPath = (thread: string) => '/p/comms-preview/thread/' + encodeURIComponent(thread.replace(/^th:/, ''));

/** The device's own choices, kept in the browser's cache storage because a service worker can read nothing
 * else a page can write without a message. The worker never deletes this cache. */
export const DEVICE_CACHE = 'loom-device';
/** Present in DEVICE_CACHE: this device opens notifications in the boards page. Absent: in the desktop. */
export const OPEN_IN_BOARDS = '/device/notifications-open-in-boards';

/** A notification device's public reference is the SHA-256, in hex, of these words and its push endpoint. */
export const NOTIFICATION_DEVICE_REF = 'notification-device:';
