import { createHash } from 'node:crypto';
import { MANIFEST } from './ui/pwa.js';
export { MANIFEST };

/** Next mode keeps only public build assets. Operations, live records and sign-in never enter a cache. */
export function nextWorker(assets: readonly string[]): string {
  const tag = createHash('sha256').update(assets.join('\n')).digest('hex').slice(0, 16);
  return `const CACHE = 'loom-next-static-${tag}';
const ASSETS = ${JSON.stringify(assets)};
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => Promise.all(ASSETS.map(u => c.add(u).catch(() => {}))))); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
// Notifications never carry message words onto a locked screen. The signed-in
// destination resolves current records and authority when the person opens it.
const destination = value => {
  try {
    const u = new URL(typeof value === 'string' ? value : '/', location.origin);
    return u.origin === location.origin && !u.username && !u.password ? u.href : new URL('/', location.origin).href;
  } catch { return new URL('/', location.origin).href; }
};
self.addEventListener('push', e => {
  let data;
  try { data = e.data && e.data.json(); } catch {}
  const d = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  e.waitUntil(self.registration.showNotification('loom', {
    body: '', ...(typeof d.tag === 'string' && d.tag.length <= 200 ? { tag: d.tag } : {}),
    data: { url: destination(d.url) }, icon: '/icons/loom-192.png', badge: '/icons/loom-192.png',
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = destination(e.notification.data && e.notification.data.url);
  e.waitUntil((async () => {
    for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
      if (new URL(client.url).origin !== location.origin || !client.navigate || !client.focus) continue;
      try { await client.navigate(url); return await client.focus(); } catch {}
    }
    return self.clients.openWindow(url);
  })());
});
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || !ASSETS.includes(u.pathname) || u.search || r.mode === 'navigate') return;
  e.respondWith(caches.open(CACHE).then(async c => { const hit = await c.match(r); if (hit) return hit; const res = await fetch(r); if (res.ok) await c.put(r, res.clone()); return res; }));
});`;
}
