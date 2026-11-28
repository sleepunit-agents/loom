import { createHash } from 'node:crypto';
import { MANIFEST, BOARDS_MANIFEST } from './ui/pwa.js';
import { BOARDS_ADDRESS, BOARDS_HOME } from './ui/notification-target.js';
export { MANIFEST, BOARDS_MANIFEST };

/** Next mode keeps only public build assets. Operations, live records and sign-in never enter a cache. */
export function nextWorker(assets: readonly string[]): string {
  const tag = createHash('sha256').update(assets.join('\n')).digest('hex').slice(0, 16);
  return `const CACHE = 'loom-next-static-${tag}';
const ASSETS = ${JSON.stringify(assets)};
// Open pages still import chunks named by their original build. Let the browser
// activate this worker and remove the old cache after those clients close.
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => Promise.all(ASSETS.map(u => c.add(u).catch(() => {}))))); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
// Notifications never carry message words onto a locked screen. The signed-in
// destination resolves current records and authority when the person opens it.
const destination = value => {
  try {
    const u = new URL(typeof value === 'string' ? value : '/', location.origin);
    return u.origin === location.origin && !u.username && !u.password ? u.href : new URL('/', location.origin).href;
  } catch { return new URL('/', location.origin).href; }
};
// The boards page (ui/notification-target.ts), the only page after sign-in: every click opens it. A push names a
// thread's address there in \`board\`, and in \`url\`; one sent while there was a desktop may name the desktop's
// address in \`url\`, and opens the boards page's home, or the thread \`board\` names.
const BOARDS = ${BOARDS_ADDRESS};
const onBoards = value => { try { const u = new URL(value); return u.origin === location.origin && BOARDS.test(u.pathname); } catch { return false; } };
const boards = value => { const href = typeof value === 'string' ? destination(value) : ''; return onBoards(href) ? href : undefined; };
self.addEventListener('push', e => {
  let data;
  try { data = e.data && e.data.json(); } catch {}
  const d = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  e.waitUntil(self.registration.showNotification('loom', {
    body: '', ...(typeof d.tag === 'string' && d.tag.length <= 200 ? { tag: d.tag } : {}),
    data: { board: boards(d.board) || boards(d.url) || new URL(${JSON.stringify(BOARDS_HOME)}, location.origin).href }, icon: '/icons/loom-192.png', badge: '/icons/loom-192.png',
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};
  e.waitUntil((async () => {
    const open = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter(client => {
      try { return new URL(client.url).origin === location.origin && client.navigate && client.focus; } catch { return false; }
    });
    const pages = open.filter(client => onBoards(client.url));
    // An open boards page first, then any other loom window. A boards page is left where it is when the notification
    // names no thread, or the thread it is already at: the page is live, and going to an address loads it again.
    const home = new URL(${JSON.stringify(BOARDS_HOME)}, location.origin).href, board = boards(data.board) || boards(data.url) || home;
    for (const client of [...pages, ...open.filter(client => !pages.includes(client))]) {
      try { if (!pages.includes(client) || (board !== home && client.url !== board)) await client.navigate(board); return await client.focus(); } catch {}
    }
    return self.clients.openWindow(board);
  })());
});
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || !ASSETS.includes(u.pathname) || u.search || r.mode === 'navigate') return;
  e.respondWith(caches.open(CACHE).then(async c => { const hit = await c.match(r); if (hit) return hit; const res = await fetch(r); if (res.ok) await c.put(r, res.clone()); return res; }));
});`;
}
