/**
 * The app shell (Claude Design, 2026-10-26): the bottom bar and rail on every
 * page, and the scope and Places sheets, which are also pages so they work
 * with no script. Choosing a scope sets a cookie and goes to that scope's home.
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

  it('every page carries the rail, the bottom bar and both sheets; account controls live in the scope sheet', async () => {
    const cookie = await login();
    const html = await (await get('/', cookie)).text();
    expect(html).toContain('<aside class="rail"');
    expect(html).toContain('<nav class="bottom" aria-label="Main">');
    expect(html).toContain('aria-label="Home" aria-current="page"');
    expect(html).toContain('href="/places" aria-label="Places" data-sheet="places"');
    expect(html).toContain('<dialog class="sheet" id="sheet-scope"');
    expect(html).toContain('<dialog class="sheet" id="sheet-places"');
    // The agent's mark: its initial on its color.
    expect(html).toMatch(/<span class="mark" style="[^"]*background:#B8A6FF;color:#1D1240"[^>]*>A<\/span>/);
    // Passkeys and Sign out are in the sheet (and the rail's foot), not the page header.
    expect(html).not.toContain('<header class="top">');
    expect(html.match(/action="\/logout"/g)?.length).toBe(2);
  });

  it('the sheets are pages too, and Find filters places by name', async () => {
    const cookie = await login();
    for (const [path, title] of [['/scope', 'Show me'], ['/places', 'Places'], ['/find', 'Find']] as const) {
      const r = await get(path, cookie);
      expect(r.status).toBe(200);
      expect(await r.text()).toContain(`<h1>${title}</h1>`);
    }
    const found = /<h2 class="label">Go to<\/h2>([\s\S]*?)<\/section>/.exec(await (await get('/find?q=pass', cookie)).text())?.[1] ?? '';
    expect(found).toContain('<span>Passkeys</span>');
    expect(found).not.toContain('<span>Manage pieces</span>');
    expect(await (await get('/find?q=%3Cscript%3E', cookie)).text()).toContain('value="&lt;script&gt;"');
  });

  it('choosing a scope sets it and goes to its home; one that names no agent is the household', async () => {
    const cookie = await login();
    const r = await get('/scope/household', cookie);
    expect([r.status, r.headers.get('location')]).toEqual([303, '/']);
    expect(r.headers.get('set-cookie')).toMatch(/^loom_scope=household; Path=\/; HttpOnly; SameSite=Strict/);
    const bogus = await get('/scope/nobody', cookie);
    expect(bogus.headers.get('set-cookie')).toMatch(/^loom_scope=household/);
    expect((await get('/scope/Bad..Name', cookie)).status).not.toBe(303);
  });
});
