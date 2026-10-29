/**
 * The app shell (Claude Design, 2026-10-26): every page's chrome carries what
 * the app draws its bottom bar, rail and sheets from, and the sheets (Scope,
 * Places, Find, Setup) are pages too. The app is installable, and an old
 * scope link goes home and clears the old cookie.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';

const TOKEN = 'shell-test-token';

describe('the app shell', () => {
  let tmp: string;
  let handle: HttpServeHandle;
  let base: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'loom-shell-'));
    for (const k of ['LOOM_HOME', 'XDG_CONFIG_HOME', 'PATH']) saved[k] = process.env[k];
    process.env.LOOM_HOME = join(tmp, 'home');
    process.env.XDG_CONFIG_HOME = join(tmp, 'xdg');
    process.env.PATH = '/usr/bin:/bin';
    const stack = join(tmp, 'stack');
    await mkdir(stack);
    await writeFile(join(stack, 'IDENTITY.md'), '# Art E Fish\n\nCreed.');
    handle = await startHttpServer({ contextDir: stack, host: '127.0.0.1', port: 0, token: TOKEN });
    base = `http://127.0.0.1:${handle.port}`;
  });
  afterEach(async () => {
    await handle.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(tmp, { recursive: true, force: true });
  });

  async function login(): Promise<string> {
    const res = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${TOKEN}`, redirect: 'manual' });
    return (res.headers.get('set-cookie') ?? '').split(';')[0];
  }
  const get = (path: string, cookie: string) => fetch(`${base}${path}`, { headers: { cookie }, redirect: 'manual' });
  // A page's data, as the app asks for it (docs/specs/ui-app.md): the same path, as JSON.
  const view = async (path: string, cookie: string) =>
    (await fetch(`${base}${path}`, { headers: { cookie, accept: 'application/json' }, redirect: 'manual' })).json() as Promise<any>;

  it('every page carries the shell: the agent, its mark, the places and the account controls\' token', async () => {
    const cookie = await login();
    const home = await view('/', cookie);
    expect(home.view).toBe('home');
    const sh = home.chrome.shell;
    // The bottom bar's and rail's data: Home is the current tab, and goes home.
    expect(sh).toMatchObject({ tab: 'home', home: '/', household: false, scope: 'agent' });
    // The agent's mark: its initial on its color.
    expect(sh.agents).toEqual([expect.objectContaining({ label: 'Art E Fish', bg: '#B8A6FF', fg: '#1D1240', href: '/', current: true })]);
    expect(sh.core.map((c: { label: string }) => c.label)).toEqual(['Mind', 'People']);
    // Sign out (the app's form posts it with the session's form token) needs that token on every page.
    expect(home.chrome.csrf).toMatch(/^[0-9a-f]{64}$/);
    expect((await view('/people', cookie)).chrome.shell).toMatchObject({ tab: '', home: '/' });
    expect((await view('/places', cookie)).chrome.shell.tab).toBe('places');
  });

  it('is an installable app: manifest, icons and a service worker, open to anyone; signing out drops what it kept', async () => {
    const m = await fetch(`${base}/manifest.webmanifest`);
    expect(m.status).toBe(200);
    expect(m.headers.get('content-type')).toBe('application/manifest+json');
    const man = await m.json() as { start_url: string; display: string; icons: Array<{ src: string; purpose?: string }> };
    expect(man).toMatchObject({ start_url: '/', display: 'standalone' });
    for (const i of man.icons) {
      const r = await fetch(`${base}${i.src}`);
      expect(r.status, i.src).toBe(200);
      expect((await r.arrayBuffer()).byteLength).toBeGreaterThan(100);
    }
    expect(man.icons.some((i) => i.purpose === 'maskable')).toBe(true);
    expect((await fetch(`${base}/icons/../package.json`)).status).not.toBe(200);
    const sw = await fetch(`${base}/sw.js`);
    expect(sw.headers.get('content-type')).toContain('text/javascript');
    const swText = await sw.text();
    // It never keeps sign-in pages or a page with a one-time message.
    expect(swText).toContain("searchParams.has('_flash')");
    expect(swText).toMatch(/NEVER = .*login\|logout/);
    // What it keeps changed shape (the app's one page, under one key): a new cache, the old one dropped.
    expect(swText).toContain("'loom-3-pages'");
    expect(swText).toContain("const APP = new URL('/__app', location.origin).href");
    expect(swText).toContain('c.put(APP,');
    // The app's JSON views are kept the same way, and dropped with the pages.
    expect(swText).toContain("caches.delete(VIEWS)");
    expect(swText).toMatch(/startsWith\('application\/json'\) && !NEVER\.test/);
    const cookie = await login();
    const page = await get('/', cookie);
    const html = await page.text();
    expect(html).toContain('<div id="root">');
    expect(html).toMatch(/<link rel="manifest" href="\/manifest\.webmanifest"\s*\/?>/);
    // The favicon and the apple-touch-icon aren't in the manifest: each one the head names is served.
    const heads = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon)" href="([^"]+)"/g)].map((x) => x[1]);
    expect(heads).toEqual(expect.arrayContaining(['/icons/loom-32.png', '/icons/loom-180.png']));
    for (const src of heads) expect((await fetch(`${base}${src}`)).headers.get('content-type'), src).toBe('image/png');
    expect(page.headers.get('content-security-policy')).toContain("manifest-src 'self'; worker-src 'self'");
    const csrf = (await view('/', cookie)).chrome.csrf as string;
    const out = await fetch(`${base}/logout`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: `_csrf=${csrf}` });
    expect(out.headers.get('clear-site-data')).toBe('"cache", "storage"');
  });

  it('push: the key and the subscription need a signed-in browser and its token; only real push services', async () => {
    expect((await fetch(`${base}/push/key`, { redirect: 'manual' })).status).toBe(303);   // signed out: to the sign-in page
    const cookie = await login();
    const key = await (await get('/push/key', cookie)).json() as { publicKey: string };
    expect(key.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    // The app draws the push switch on Passkeys, posting with the page's form token.
    const page = await view('/passkeys', cookie);
    expect(page.view).toBe('passkeys');
    const csrf = page.ctx.csrf as string;
    expect(csrf).toMatch(/^[0-9a-f]{64}$/);
    const post = (body: unknown) => fetch(`${base}/push/subscribe`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const good = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } };
    expect((await post({ sub: good })).status).toBe(403);                                   // no token
    expect((await post({ _csrf: '0'.repeat(64), sub: good })).status).toBe(403);            // not this session's token
    expect((await post({ _csrf: csrf, sub: { ...good, endpoint: 'https://10.0.0.5/x' } })).status).toBe(400);   // not a push service
    expect((await post({ _csrf: csrf, sub: good })).status).toBe(200);
  });

  it('the sheets are pages too; Find carries its query as data, never markup', async () => {
    const cookie = await login();
    for (const which of ['scope', 'places', 'find', 'setup'] as const) {
      const r = await fetch(`${base}/${which}`, { headers: { cookie, accept: 'application/json' }, redirect: 'manual' });
      expect(r.status, which).toBe(200);
      expect(await r.json(), which).toMatchObject({ view: 'sheet', which, chrome: { shell: { tab: which } } });
    }
    // A search: what it found, by group (a lone agent has no asks to match).
    const found = await view('/find?q=pass', cookie);
    expect(found).toMatchObject({ q: 'pass', found: { do: [], knowledge: [], people: [], memories: [] } });
    // A query that looks like markup reaches the app as the string it is; the app's page carries none of it.
    expect((await view('/find?q=%3Cscript%3E', cookie)).q).toBe('<script>');
    expect(await (await get('/find?q=%3Cscript%3E', cookie)).text()).toBe(await (await get('/', cookie)).text());
  });

  it('an old scope link goes home (or to the agent) and clears the old cookie', async () => {
    const cookie = await login();
    const r = await get('/scope/household', cookie);
    expect([r.status, r.headers.get('location')]).toEqual([303, '/']);
    expect(r.headers.get('set-cookie')).toMatch(/^loom_scope=; Path=\/; HttpOnly; SameSite=Strict; Max-Age=0/);
    const bogus = await get('/scope/nobody', cookie);
    expect(bogus.headers.get('location')).toBe('/');
    expect((await get('/scope/Bad..Name', cookie)).status).not.toBe(303);
  });
});
