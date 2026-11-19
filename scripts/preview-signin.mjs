// A look at loom's two sign-in pages without a loom behind them:
//   node scripts/preview-signin.mjs <port> <state> [address]
// The address to listen on is this machine's own (127.0.0.1) unless one is given. It serves the built app (dist/web,
// from `cd web && npx vite build`) the way loom does, the app at /app/ and the page at every other path, and answers
// GET /auth/session by the state:
//   out         nobody is signed in: the passkey button
//   connecting  the answer never comes
//   down        loom cannot be read (HTTP 500)
//   link        not the app at all: the page the server renders for a one-time link (src/core/signin/page.ts), under
//               the policy the server sends with it; pressing Sign in answers a plain "signed in"
// The app's page is served here WITHOUT loom's Content-Security-Policy; only the link state carries its real policy.
// So a preview shows how a page looks, and is not proof that the app's page works under loom's own headers.
// The link state imports a TypeScript module as it is, which needs a Node that strips types on import: 22.18 or
// later (23.6 or later on the 23 line). An older Node is told so and the script stops.
// Everything else loom would answer is a 404 here, the service worker included, so nothing is kept between looks.
// /preview/look/<neon|lowlight|daylight|system> and /preview/motion/<on|off|follow> set this browser's kept copy of a
// look or of Reduce motion and go back to the page. No dependencies; for a person's eyes on a private network only.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STATES = ['out', 'connecting', 'down', 'link'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.map': 'application/json' };
const send = (res, status, type, body, headers = {}) => res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers }).end(body);
const json = (res, status, value) => send(res, status, 'application/json', JSON.stringify(value));
// A page that sets one kept choice in this browser and returns to the sign-in page.
const KEPT = { look: ['neon', 'lowlight', 'daylight', 'system'], motion: ['on', 'off', 'follow'] };
const keep = (res, what, value) => send(res, 200, TYPES['.html'], `<!doctype html><title>loom preview</title><script>
  ${value === 'system' ? "localStorage.removeItem('loom-look');localStorage.removeItem('loom-mode');" : `localStorage.setItem('loom-${what}', '${value}');`}
  ${what === 'look' && value !== 'system' ? `localStorage.setItem('loom-mode', '${value === 'daylight' ? 'light' : 'dark'}');` : ''}
  location.replace('/');</script>`);

/** The preview's server for one state, not yet listening. `root` is the built app's directory: nothing outside it is
 * ever read. `link` is the link page's module (signinLinkPage, SIGNIN_PAGE_POLICY), for the link state. */
export function previewServer(state, root, link) {
  const waiting = new Set();
  // One file from the build, by the path after /app. The path is never decoded, and a place outside the build is refused.
  const file = async (res, path) => {
    const at = resolve(root, '.' + path);
    if (!at.startsWith(root + sep)) return send(res, 404, 'text/plain', 'Not found');
    try { send(res, 200, TYPES[extname(at)] ?? 'application/octet-stream', await readFile(at)); } catch { send(res, 404, 'text/plain', 'Not found'); }
  };
  const answer = async (req, res) => {
    let path;
    try { path = new URL(req.url ?? '/', 'http://preview').pathname; } catch { return send(res, 400, 'text/plain', 'Bad request'); }
    if (state === 'link') {
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
  };
  // Whatever one request does, the preview goes on answering the next.
  const server = createServer((req, res) => {
    answer(req, res).catch(() => { if (res.headersSent) res.destroy(); else send(res, 500, 'text/plain', 'The preview could not answer'); });
  });
  server.on('close', () => { for (const res of waiting) res.destroy(); });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fail = (line, code) => { console.error(line); process.exit(code); };
  const [port, state, address = '127.0.0.1'] = [Number(process.argv[2]), process.argv[3], process.argv[4]];
  if (process.argv.length < 4 || process.argv.length > 5 || !Number.isInteger(port) || port < 1 || port > 65535 || !STATES.includes(state))
    fail(`usage: node scripts/preview-signin.mjs <port> <${STATES.join('|')}> [address]`, 2);
  if (state === 'link' && !process.features.typescript)
    fail(`preview-signin: the link state needs Node 22.18 or later (23.6 or later on the 23 line) to read src/core/signin/page.ts; this is ${process.version}`, 1);
  const link = state === 'link' ? await import('../src/core/signin/page.ts') : undefined;
  const server = previewServer(state, fileURLToPath(new URL('../dist/web', import.meta.url)), link);
  server.on('error', error => fail(`preview-signin: could not listen on ${address} port ${port}: ${error.message}`, 1));
  server.listen(port, address, () => console.log(`loom sign-in preview (${state}): http://${address.includes(':') ? `[${address}]` : address}:${port}/`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(() => process.exit(0)); server.closeAllConnections(); });
}
