// A look at loom's two sign-in pages without a loom behind them: node scripts/preview-signin.mjs <port> <state>.
// It serves the built app (dist/web, from `cd web && npx vite build`) the way loom does, the app at /app/ and the
// page at every other path, and answers GET /auth/session by the state:
//   out         nobody is signed in: the passkey button
//   connecting  the answer never comes
//   down        loom cannot be read (HTTP 500)
//   link        not the app at all: the page the server renders for a one-time link (src/core/signin/page.ts), under
//               the policy the server sends with it; pressing Sign in answers a plain "signed in"
// Everything else loom would answer is a 404 here, the service worker included, so nothing is kept between looks.
// /preview/look/<neon|lowlight|daylight|system> and /preview/motion/<on|off|follow> set this browser's kept copy of a
// look or of Reduce motion and go back to the page. No dependencies; for a person's eyes on a private network only.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '192.168.6.30';
const STATES = ['out', 'connecting', 'down', 'link'];
const [port, state] = [Number(process.argv[2]), process.argv[3]];
if (process.argv.length !== 4 || !Number.isInteger(port) || port < 1 || port > 65535 || !STATES.includes(state)) {
  console.error(`usage: node scripts/preview-signin.mjs <port> <${STATES.join('|')}>`);
  process.exit(2);
}

const root = fileURLToPath(new URL('../dist/web', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.map': 'application/json' };
const send = (res, status, type, body, headers = {}) => res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers }).end(body);
const json = (res, status, value) => send(res, status, 'application/json', JSON.stringify(value));
const file = async (res, path) => {
  const at = resolve(root, '.' + path);
  if (!at.startsWith(root + sep)) return send(res, 404, 'text/plain', 'Not found');
  try { send(res, 200, TYPES[extname(at)] ?? 'application/octet-stream', await readFile(at)); } catch { send(res, 404, 'text/plain', 'Not found'); }
};
// A page that sets one kept choice in this browser and returns to the sign-in page.
const KEPT = { look: ['neon', 'lowlight', 'daylight', 'system'], motion: ['on', 'off', 'follow'] };
const keep = (res, what, value) => send(res, 200, TYPES['.html'], `<!doctype html><title>loom preview</title><script>
  ${value === 'system' ? "localStorage.removeItem('loom-look');localStorage.removeItem('loom-mode');" : `localStorage.setItem('loom-${what}', '${value}');`}
  ${what === 'look' && value !== 'system' ? `localStorage.setItem('loom-mode', '${value === 'daylight' ? 'light' : 'dark'}');` : ''}
  location.replace('/');</script>`);

const link = state === 'link' ? await import('../src/core/signin/page.ts') : undefined;
const waiting = new Set();

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://preview').pathname;
  if (link) {
    if (req.method === 'POST') return send(res, 200, 'text/plain; charset=utf-8', 'signed in\n');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'Method not allowed');
    return send(res, 200, TYPES['.html'], link.signinLinkPage(), { 'referrer-policy': 'strict-origin', 'content-security-policy': link.SIGNIN_PAGE_POLICY });
  }
  if (path === '/auth/session' && req.method === 'GET') {
    if (state === 'out') return json(res, 200, { viewer: null, csrf: '' });
    if (state === 'down') return send(res, 500, 'text/plain', 'loom is not here');
    waiting.add(res); res.on('close', () => waiting.delete(res)); return;
  }
  // What loom itself answers at an address that is not its passkey address, so the button shows the error line.
  if (req.method === 'POST' && path.startsWith('/login/passkey')) return json(res, 404, { error: 'Passkeys unavailable at this address' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 404, { error: 'Not in the preview' });
  const kept = /^\/preview\/(look|motion)\/([a-z]+)$/.exec(path);
  if (kept && KEPT[kept[1]].includes(kept[2])) return keep(res, kept[1], kept[2]);
  if (path.startsWith('/app/')) return file(res, path.slice(4));
  if (extname(path) || /^\/(graphql|api|auth|appearance|assets|icons|fonts|faces|pixel-icons)(\/|$)/.test(path)) return send(res, 404, 'text/plain', 'Not found');
  return file(res, '/next.html');
});
server.listen(port, HOST, () => console.log(`loom sign-in preview (${state}): http://${HOST}:${port}/`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { for (const res of waiting) res.destroy(); server.close(() => process.exit(0)); server.closeAllConnections(); });
