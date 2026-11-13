/** New Changes data path only. Run browsers in CI; never on loom's machine. */
import { it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve } from 'node:path';
import { chromium, type Route } from 'playwright-core';
import { startLoom } from '../foundation.js';
import { FakeClock } from '../core/clock.js';
import { fixture, installFixture, fixtureSharing } from '../fixture.js';
import { installChanges } from '../pieces/changes/index.js';
import { change } from '../pieces/changes/fixture.js';
import { replaceChanges } from '../pieces/changes/store.js';
const root = resolve(import.meta.dirname, '../../dist/web');
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', chromium.executablePath()].find(p => p && existsSync(p));
it.runIf(chrome && existsSync(join(root, 'index.html')))('Changes shares checks, citations and answers between windows, scopes projects, and expires merged rows', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-changes-browser-'));
  fixture(home);
  const clock = new FakeClock(Date.parse('2026-11-12T12:00:00Z'));
  let allowed = false;
  const loom = await startLoom({ home, clock, install: app => {
    installChanges(app.db, app.operations, app.live, fixtureSharing, {
      attribution: () => ({ agents: { art: { logins: ['art-bot'], branches: [] } }, ownerLogins: [] }),
      approvals: { rule: () => ({ tier: allowed ? 'do' : 'ask' }), answer: () => { allowed = true; return { ok: true, value: {} }; } },
    });
    installFixture(app);
  }, authenticate: req => {
    const id = req.headers.cookie?.includes('fixture=pollock') ? 'pollock' : req.headers.cookie?.includes('fixture=jonathan') ? 'jonathan' : undefined;
    return id ? { viewer: { kind: 'member', id }, valid: () => true } : undefined;
  } });
  let current = change({ project: 'pond', title: 'Keep shared changes current', body: 'Checks, reviews and task citations arrive in every window.\nThe owner answers the exact commit; the agent performs the merge.' });
  const hidden = change({ id: 'github:other/app#4', repo: 'github:other/app', project: 'other', title: 'Private other project change' });
  const publish = () => { replaceChanges(loom.db, [current, hidden]); loom.live.changed([{ type: 'change', id: current.id }]); };
  publish();
  const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  try {
    const staticFiles = async (route: Route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/live' || url.pathname.startsWith('/api/')) return route.continue();
      const path = url.pathname.startsWith('/app/') ? resolve(root, url.pathname.slice(5)) : join(root, 'index.html');
      if (!path.startsWith(`${root}/`) || !existsSync(path)) return route.fulfill({ status: 404, body: '' });
      await route.fulfill({ body: readFileSync(path), contentType: ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2' } as Record<string, string>)[extname(path)] ?? 'application/octet-stream' });
    };
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await context.grantPermissions(['local-network-access'], { origin: loom.url });
    await context.addCookies([{ name: 'fixture', value: 'jonathan', url: loom.url }]);
    await context.route('**/*', staticFiles);
    const a = await context.newPage(), b = await context.newPage();
    await Promise.all([a.goto(`${loom.url}/p/changes-preview`), b.goto(`${loom.url}/p/changes-preview`)]);
    const row = (page: typeof a, title = current.title) => page.locator('[data-split-row]').filter({ hasText: title });
    await expect.poll(() => row(b).count()).toBe(1);
    await row(a).click(); await row(b).click();
    await b.reload();
    await expect.poll(() => b.getByRole('heading', { name: current.title, exact: true }).count()).toBe(1);
    current = { ...current, checks: { state: 'failing', total: 2, failing: ['Typecheck'], running: [] } }; publish();
    for (const page of [a, b]) await expect.poll(() => page.getByText('Failing: Typecheck', { exact: true }).count()).toBe(1);
    const result = loom.operations.call('direct', { kind: 'member', id: 'jonathan' }, 'tasks.create', {
      title: 'Track the shared change', description: 'acme/app#3', project: 'pond', actor: 'art', at: new Date(clock.now()).toISOString(),
    }, 'browser:citation');
    expect(result.ok).toBe(true);
    for (const page of [a, b]) await expect.poll(() => page.getByText('Track the shared change', { exact: true }).count()).toBe(1);
    current = { ...current, checks: { state: 'passing', total: 2, failing: [], running: [] } }; publish();
    await expect.poll(() => b.getByText('passing · 2 checks', { exact: true }).count()).toBe(1);
    const shots = process.env.LOOM_TEST_SHOTS ?? resolve('artifacts/changes-piece'); mkdirSync(shots, { recursive: true });
    for (const look of ['neon', 'daylight']) for (const width of [390, 1280, 1920]) {
      await b.setViewportSize({ width, height: 900 });
      await b.evaluate(look => { document.documentElement.dataset.look = look; document.documentElement.dataset.mode = look === 'daylight' ? 'light' : 'dark'; document.documentElement.dataset.motion = 'reduce'; }, look);
      await expect.poll(() => b.locator('.loom-split').getAttribute('data-mode')).toBe(width < 640 ? 'one' : 'three');
      expect(await b.locator('.loom-split').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await b.screenshot({ path: join(shots, `changes-${look}-${width}.png`), fullPage: true, animations: 'disabled' });
    }
    const pollock = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
    await pollock.grantPermissions(['local-network-access'], { origin: loom.url });
    await pollock.addCookies([{ name: 'fixture', value: 'pollock', url: loom.url }]); await pollock.route('**/*', staticFiles);
    const p = await pollock.newPage(); await p.goto(`${loom.url}/p/changes-preview`);
    await expect.poll(() => row(p).count()).toBe(1);
    expect(await row(p, hidden.title).count()).toBe(0);
    await row(p).click();
    await p.getByRole('button', { name: 'Check merge answer', exact: true }).click();
    await expect.poll(() => p.getByText('Couldn’t check', { exact: true }).count()).toBe(1);
    expect(await p.getByRole('button', { name: 'Yes, merge it', exact: true }).count()).toBe(0);
    await pollock.close();
    await a.getByRole('button', { name: 'Check merge answer', exact: true }).click();
    await expect.poll(() => a.getByRole('button', { name: 'Yes, merge it', exact: true }).isEnabled()).toBe(true);
    await a.getByRole('button', { name: 'Yes, merge it', exact: true }).click();
    await expect.poll(() => b.getByText('do', { exact: true }).count()).toBe(1);
    expect(allowed).toBe(true);
    current = { ...current, state: 'merged', closed: new Date(clock.now()).toISOString() }; publish();
    await expect.poll(() => row(b).textContent()).toContain('Merged');
    clock.advance(7 * 86400_000);
    for (const page of [a, b]) await expect.poll(() => row(page).count()).toBe(0);
  } finally { await browser.close(); await loom.close(); rmSync(home, { recursive: true, force: true }); }
}, 60_000);
