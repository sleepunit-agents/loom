/** loom's page as an installable app: the manifest. The service worker it is served with is src/next-pwa.ts. */
import { BOARDS_HOME } from './notification-target.js';

const icons = [
  { src: '/icons/loom-192.png', sizes: '192x192', type: 'image/png' },
  { src: '/icons/loom-512.png', sizes: '512x512', type: 'image/png' },
  { src: '/icons/loom-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];

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
  icons,
});

/** The boards page installed as its own app: it opens at the boards page. A second manifest, with its own id, so
 * the app above (the desktop and the phone's) is exactly what it was. Its scope is the whole origin: sign-in and
 * every link out of a board stay inside the installed window. No orientation: it is a desktop's window. */
export const BOARDS_MANIFEST = JSON.stringify({
  name: 'loom boards',
  short_name: 'loom',
  description: 'A conversation with your agent, beside a board it fills.',
  id: BOARDS_HOME,
  start_url: BOARDS_HOME,
  scope: '/',
  display: 'standalone',
  background_color: '#07070C',
  theme_color: '#07070C',
  icons,
});
