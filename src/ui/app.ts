/**
 * The sign-in pages' script, served at /app.js (script-src 'self'; never inline). Every other page is the app
 * (web/, docs/specs/ui-app.md), which has its own; this one only does what landing on a sign-in page means for
 * this browser: the copies of pages it kept for offline (src/ui/pwa.ts) belong to a session that's over, so
 * they go.
 */
export const APP_JS = `'use strict';
if ('serviceWorker' in navigator && window.isSecureContext && location.pathname.startsWith('/login')) {
  if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage('forget');
  if (window.caches) caches.keys().then((ks) => ks.forEach((k) => { if (k.endsWith('-pages') || k.endsWith('-views')) caches.delete(k); }));
}
`;
