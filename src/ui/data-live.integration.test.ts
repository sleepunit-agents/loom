/** Exactly one browser proof: two windows, one in-process fixture loom, no live home. */
import { it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startLoom } from '../foundation.js';
import { FakeClock } from '../core/clock.js';
import { installFixture } from '../fixture.js';
const root = resolve(import.meta.dirname, '../../dist/web');
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', chromium.executablePath()].find(p => p && existsSync(p));
it.runIf(chrome && existsSync(join(root, 'index.html')))('a change in one window arrives in the other through /live', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-data-browser-'));
  const clock = new FakeClock();
  const loom = await startLoom({ home, clock, install: installFixture,
    authenticate: req => req.headers.cookie === 'fixture=jonathan' ? { viewer: { kind: 'member', id: 'jonathan' }, valid: () => true } : undefined });
  const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.grantPermissions(['local-network-access'], { origin: loom.url });
    await context.addCookies([{ name: 'fixture', value: 'jonathan', url: loom.url }]);
    // startLoom owns the real socket/API. Supply only built static assets, which the harness does not serve.
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/live' || url.pathname.startsWith('/api/')) return route.continue();
      const path = url.pathname.startsWith('/app/') ? resolve(root, url.pathname.slice(5)) : join(root, 'index.html');
      if (!path.startsWith(`${root}/`) || !existsSync(path)) return route.fulfill({ status: 404, body: '' });
      const contentType = ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2' } as Record<string, string>)[extname(path)] ?? 'application/octet-stream';
      await route.fulfill({ body: readFileSync(path), contentType });
    });
    const a = await context.newPage(), b = await context.newPage();
    await Promise.all([a.goto(`${loom.url}/_dev/live-example`), b.goto(`${loom.url}/_dev/live-example`)]);
    await expect.poll(() => a.getByRole('button', { name: 'Add record' }).isEnabled()).toBe(true);
    await expect.poll(() => b.getByRole('button', { name: 'Add record' }).isEnabled()).toBe(true);
    await a.getByLabel('Title').fill('Shared through the live feed');
    await a.getByRole('button', { name: 'Add record' }).click();
    await expect.poll(() => b.getByRole('button', { name: 'Shared through the live feed', exact: true }).count()).toBe(1);
    await expect.poll(() => a.getByRole('button', { name: 'Shared through the live feed', exact: true }).count()).toBe(1);
    expect(loom.db.prepare('SELECT count(*) AS n FROM example_records').get()).toEqual({ n: 1 });
  } finally { await browser.close(); await loom.close(); rmSync(home, { recursive: true, force: true }); }
}, 60_000);
