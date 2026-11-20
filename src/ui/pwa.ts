import { createHash } from 'node:crypto';
/**
 * loom's page as an installable app: the manifest, and a service worker
 * (served at /sw.js, so its scope is the whole page).
 *
 * Every page is the app (web/, docs/specs/ui-app.md): a page load is its one
 * HTML page, and the page's data is the same path asked for as JSON. The
 * worker keeps the app's page (so any address opens while loom can't be
 * reached), its built files under /app/assets/ once fetched (their names
 * change with their content), and the last copy of each page's data, with
 * the time it was saved (x-loom-saved-at), which the app shows. Everything
 * else goes to the network untouched: actions (POST), MCP. A service worker
 * needs a secure context, so on a plain-http address there is none.
 *
 * The app's built files are kept the moment the worker installs (the server names them in the worker it sends,
 * so a new build is a new worker) and answered from the worker after that; the household's pixel faces and icons
 * (asked with ?v=) are kept by version. Copies of pages belong to a session: loom's answers carry a hash of it
 * (x-loom-who), and an answer under another one drops every copy before it's kept (t-1925 F).
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
  // A phone's app holds one way up (Jonathan, 2026-11-05: an OS, not a web page). iOS's home screen ignores this.
  orientation: 'portrait',
  // Neon Noir's canvas (web/src/looks/looks.css --v-canvas): the look loom opens in, so its splash is already it.
  background_color: '#07070C',
  theme_color: '#07070C',
  icons: [
    { src: '/icons/loom-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icons/loom-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/icons/loom-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
});

/** Bumped when what the worker keeps changes shape; an old cache is dropped on activate. */
// loom-4 (t-1881): drops the copies of Comms threads' live reads the worker kept before it stopped keeping them.
// loom-5 (t-1925 F): the built app's files are kept ahead (BUILT) and answered from the worker; the household's pixel
// art (faces, icons) is kept by version (MEDIA); and every copy of a page belongs to the session it came with.
const VERSION = 'loom-5';

/**
 * The worker, for a build: `built` is the app's own files (/app/assets/…, named by their content), kept the moment the
 * worker installs, so an app opened the first time opens without asking for them, and a new build is a new worker.
 */
export function swJs(built: readonly string[] = []): string {
  const tag = createHash('sha256').update(built.join('\n')).digest('base64url').slice(0, 10);
  return SW_JS.replace("'__BUILT__'", () => JSON.stringify(built)).replace('__TAG__', () => tag);
}

const SW_JS = `'use strict';
const PAGES = '${VERSION}-pages', VIEWS = '${VERSION}-views', MEDIA = '${VERSION}-media', STATIC = '${VERSION}-static', BUILT = '${VERSION}-built-__TAG__';
const SHELL = ['/app.js', '/fonts/instrument-sans-latin-wght-normal.woff2', '/fonts/jetbrains-mono-latin-wght-normal.woff2', '/icons/loom-32.png'];
const AHEAD = '__BUILT__';
const NEVER = /^\\/(login|logout)(\\/|$)/;
// Views never kept on this device: the desktop's Comms summary carries the first line of a reply (docs/specs/agent-desk.md).
const UNKEPT = /^\\/comms\\/agents$/;
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(Promise.all([caches.open(STATIC).then((c) => c.addAll(SHELL)).catch(() => {}),
    // One by one, so a file that's gone (a build replaced mid-install) doesn't keep the rest out.
    caches.open(BUILT).then((c) => Promise.all(AHEAD.map((u) => c.match(u).then((hit) => hit || c.add(u)).catch(() => {}))))]));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => ![PAGES, VIEWS, MEDIA, STATIC, BUILT].includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// What's a session's (its pages, the household's pictures) goes when it ends, or when another one shows up.
const forget = () => Promise.all([caches.delete(PAGES), caches.delete(VIEWS), caches.delete(MEDIA)]);
// Whose the kept copies are: the session tag loom's last answer carried (x-loom-who, a hash of the session, never it).
const WHO = new URL('/__who', location.origin).href;
let who = null;
async function whose(res) {
  const tag = res.headers.get('x-loom-who');
  if (!tag) return;
  const c = await caches.open(STATIC);
  const was = who ?? await c.match(WHO).then((r) => r && r.text());
  who = tag;
  if (was === tag) return;
  if (was) await forget();
  await c.put(WHO, new Response(tag));
}
// A copy is kept only while its session is still the one answering: one that lands after another session's answer
// (two in flight across a switch) is dropped, not kept under the new one.
const mine = (res) => { const tag = res.headers.get('x-loom-who'); return !tag || !who || tag === who; };
self.addEventListener('message', (e) => { if (e.data === 'forget') e.waitUntil(forget()); });
// A page's key: its address without the one-time message.
const keyOf = (u) => { const k = new URL(u); k.searchParams.delete('_flash'); return k.href; };
// The app's one page, whatever address it was loaded at.
const APP = new URL('/__app', location.origin).href;
async function page(req) {
  const url = new URL(req.url);
  const ctl = new AbortController();
  const slow = setTimeout(() => ctl.abort(), 8000);
  let res;
  try { res = await fetch(req, { signal: ctl.signal }); }
  catch { clearTimeout(slow); return kept(); }
  clearTimeout(slow);
  const landed = new URL(res.url || req.url);
  if (NEVER.test(landed.pathname)) { await forget(); return res; }
  const html = (res.headers.get('content-type') || '').startsWith('text/html');
  if (res.status === 200 && html && !NEVER.test(url.pathname) && !UNKEPT.test(url.pathname) && !url.searchParams.has('_flash') && !res.redirected) {
    const body = await res.clone().arrayBuffer();
    const h = new Headers(res.headers);
    h.set('x-loom-saved-at', new Date().toISOString());
    caches.open(PAGES).then((c) => c.put(APP, new Response(body, { status: 200, headers: h }))).catch(() => {});
  }
  return res;
}
// The app's page, kept from the last load; it then asks for the page's data, which view() answers from VIEWS.
async function kept() {
  const hit = await (await caches.open(PAGES)).match(APP);
  if (hit) return hit;
  return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>loom</title><body style="font:16px system-ui;padding:24px;background:#07070C;color:#F2F1EC"><h1 style="font-size:22px">Can\\u2019t reach loom</h1><p>loom isn\\u2019t saved on this device yet. It opens when there\\u2019s a connection.</p></body>',
    { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" } });
}
// The app's view of a page (Accept: application/json): the network first; the kept copy, stamped, when loom can't be reached.
async function view(req) {
  const url = new URL(req.url);
  const ctl = new AbortController();
  const slow = setTimeout(() => ctl.abort(), 8000);
  let res;
  try { res = await fetch(req, { signal: ctl.signal }); }
  catch {
    clearTimeout(slow);
    const hit = await (await caches.open(VIEWS)).match(keyOf(url.href));
    if (!hit) throw new Error('offline');
    return hit;
  }
  clearTimeout(slow);
  await whose(res);
  if (res.status === 200 && res.type === 'basic' && (res.headers.get('content-type') || '').startsWith('application/json') && !NEVER.test(url.pathname) && !UNKEPT.test(url.pathname) && !url.searchParams.has('_flash') && !res.redirected) {
    const body = await res.clone().arrayBuffer();
    const h = new Headers(res.headers);
    h.set('x-loom-saved-at', new Date().toISOString());
    caches.open(VIEWS).then((c) => { if (mine(res)) return c.put(keyOf(req.url), new Response(body, { status: 200, headers: h })); }).catch(() => {});
  }
  return res;
}
// The app's built files and the household's versioned pictures never change under their name: the kept copy, at once.
async function built(req, name) {
  const c = await caches.open(name);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.type === 'basic') c.put(req, res.clone()).catch(() => {});
  return res;
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
  // A Comms thread's live reads (since, before) are its state now, never a kept copy (t-1881): an old one would say a
  // message is still on its way, or not delivered, when it isn't.
  if (/^\\/comms\\/[^/]+\\/(since|before)\\//.test(url.pathname)) return;
  // Whether an Inbox ask is still open (t-1925) is asked of loom, never answered from a kept copy.
  if (url.pathname === '/inbox/open') return;
  if (url.pathname.startsWith('/app/assets/')) return e.respondWith(built(req, BUILT));
  if (/^\\/(faces|pixel-icons)\\//.test(url.pathname) && url.searchParams.has('v')) return e.respondWith(built(req, MEDIA));
  if (SHELL.includes(url.pathname) || url.pathname.startsWith('/icons/')) return e.respondWith(shell(req));
  if ((req.headers.get('accept') || '').startsWith('application/json') && !NEVER.test(url.pathname)) return e.respondWith(view(req));
});
`;
