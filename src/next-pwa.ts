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
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || !ASSETS.includes(u.pathname) || u.search || r.mode === 'navigate') return;
  e.respondWith(caches.open(CACHE).then(async c => { const hit = await c.match(r); if (hit) return hit; const res = await fetch(r); if (res.ok) await c.put(r, res.clone()); return res; }));
});`;
}
