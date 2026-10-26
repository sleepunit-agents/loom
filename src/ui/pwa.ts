/**
 * loom's page as an installable app: the manifest, and a service worker
 * (served at /sw.js, so its scope is the whole page).
 *
 * The worker keeps the last copy of each page loom showed this browser, and
 * shows it when loom can't be reached, marked with when it was saved
 * (body data-offline-from), so /app.js can say how old it is and hold the
 * actions. Everything else goes to the network untouched: actions (POST),
 * the page's own live checks, MCP. A service worker needs a secure context,
 * so on a plain-http address there is none, and no copy is kept.
 *
 * What it never keeps: the sign-in pages, a page carrying a one-time message
 * (?_flash=, which can hold a token shown once), and anything that isn't a
 * 200 HTML page. Signing out, or landing on the sign-in page because the
 * session ended, drops every copy.
 */

export const MANIFEST = JSON.stringify({
  name: 'loom',
  short_name: 'loom',
  description: 'Your agents: what needs you, what they did, and their pieces.',
  id: '/',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#0E0E0D',
  theme_color: '#0E0E0D',
  icons: [
    { src: '/icons/loom.svg', sizes: 'any', type: 'image/svg+xml' },
    { src: '/icons/loom-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icons/loom-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/icons/loom-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
});

/** Bumped when what the worker keeps changes shape; an old cache is dropped on activate. */
const VERSION = 'loom-1';

export const SW_JS = `'use strict';
const PAGES = '${VERSION}-pages', STATIC = '${VERSION}-static';
const SHELL = ['/app.js', '/fonts/instrument-sans-latin-wght-normal.woff2', '/fonts/jetbrains-mono-latin-wght-normal.woff2', '/icons/loom.svg'];
const NEVER = /^\\/(login|logout)(\\/|$)/;
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(STATIC).then((c) => c.addAll(SHELL)).catch(() => {}));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== PAGES && k !== STATIC).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
const forget = () => caches.delete(PAGES);
self.addEventListener('message', (e) => { if (e.data === 'forget') e.waitUntil(forget()); });
// A page's key: its address without the one-time message.
const keyOf = (u) => { const k = new URL(u); k.searchParams.delete('_flash'); return k.href; };
async function page(req) {
  const url = new URL(req.url);
  const ctl = new AbortController();
  const slow = setTimeout(() => ctl.abort(), 8000);
  let res;
  try { res = await fetch(req, { signal: ctl.signal }); }
  catch { clearTimeout(slow); return kept(url); }
  clearTimeout(slow);
  const landed = new URL(res.url || req.url);
  if (NEVER.test(landed.pathname)) { await forget(); return res; }
  const html = (res.headers.get('content-type') || '').startsWith('text/html');
  if (res.status === 200 && html && !NEVER.test(url.pathname) && !url.searchParams.has('_flash') && !res.redirected) {
    const body = await res.clone().arrayBuffer();
    const h = new Headers(res.headers);
    h.set('x-loom-saved-at', new Date().toISOString());
    caches.open(PAGES).then((c) => c.put(keyOf(req.url), new Response(body, { status: 200, headers: h }))).catch(() => {});
  }
  return res;
}
// The saved copy, marked with when it was saved; its own headers (the CSP among them) kept.
async function kept(url) {
  const c = await caches.open(PAGES);
  const hit = await c.match(keyOf(url.href));
  if (!hit) {
    return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>loom</title><body style="font:16px system-ui;padding:24px;background:#0E0E0D;color:#F2F1EC"><h1 style="font-size:22px">Can\\u2019t reach loom</h1><p>This page isn\\u2019t saved on this device. It will open when there\\u2019s a connection.</p><p><a href="/" style="color:#D4FF3A">Home, as last seen</a></p></body>',
      { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" } });
  }
  const at = hit.headers.get('x-loom-saved-at') || '';
  const text = (await hit.text()).replace('<body', '<body data-offline-from="' + at.replace(/[^0-9TZ:.-]/g, '') + '"');
  return new Response(text, { status: 200, headers: hit.headers });
}
async function shell(req) {
  const c = await caches.open(STATIC);
  try { const res = await fetch(req); if (res.ok) c.put(req, res.clone()).catch(() => {}); return res; }
  catch { const hit = await c.match(req); if (hit) return hit; throw new Error('offline'); }
}
// Push for Your call (push.ts): show it; a tap opens Home at that ask, never a piece's tab.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil(self.registration.showNotification(d.title || 'loom', {
    body: d.body || '', tag: d.tag, data: { url: d.url || '/' }, icon: '/icons/loom-192.png', badge: '/icons/loom-192.png',
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', location.origin);
  if (url.origin !== location.origin) return;
  e.waitUntil((async () => {
    for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
      if ('focus' in c) { if (c.navigate) await c.navigate(url.href).catch(() => {}); return c.focus(); }
    }
    return self.clients.openWindow(url.href);
  })());
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (req.mode === 'navigate') return e.respondWith(page(req));
  if (SHELL.includes(url.pathname) || url.pathname.startsWith('/icons/')) return e.respondWith(shell(req));
});
`;
