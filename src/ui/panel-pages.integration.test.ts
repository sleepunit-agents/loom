/**
 * A long panel pages like a list (docs/extensions.md, "Panels"): a piece's panel of 40 rows is drawn 15 at a time with
 * numbered pages, a short one whole, and nothing is wider than a phone. Jonathan, 2026-11-05: "we have a bunch of
 * stuff that's fine if you've got 1 of something and a nightmare if you exceed that" (the Secrets page: one panel,
 * 61 rows).
 *
 * Runs where the app is built (npm run build) and a Chrome is installed (GitHub's runners have one).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { clearPieceCache } from './pieces.js';

const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);
const TOKEN = 'panel-pages-token';

const rows = (n: number, what: string) => Array.from({ length: n }, (_, i) => ({ label: `${what} ${i + 1}`, value: `the ${what} numbered ${i + 1}`, page: `x/${i + 1}` }));
const PAGE = { title: 'Lots', sections: [
  { id: 'long', title: 'Long', blocks: [{ type: 'panel', rows: rows(40, 'Secret'), action: { action: 'add', label: 'Add one' } }] },
  { id: 'short', title: 'Short', blocks: [{ type: 'panel', rows: rows(3, 'Rule') }] },
] };

describe.runIf(built && chrome)('a long panel', () => {
  let tmp: string;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    clearPieceCache();
    tmp = await mkdtemp(join(tmpdir(), 'loom-panel-pages-'));
    for (const k of ['LOOM_HOME', 'XDG_CONFIG_HOME', 'PATH']) saved[k] = process.env[k];
    process.env.LOOM_HOME = join(tmp, 'home');
    process.env.XDG_CONFIG_HOME = join(tmp, 'xdg');
    // A piece on PATH whose page has one long panel and one short one.
    await mkdir(join(tmp, 'path'));
    await writeFile(join(tmp, 'page.json'), JSON.stringify(PAGE));
    await writeFile(join(tmp, 'path', 'loom-lots'), `#!/bin/sh\ncase "$1 $2" in\n  "ui --json") echo '${JSON.stringify({ v: 2, tab: { label: 'Lots' }, asks: [] })}' ;;\n  "ui page") cat "${join(tmp, 'page.json')}" ;;\n  *) exit 1 ;;\nesac\n`);
    await chmod(join(tmp, 'path', 'loom-lots'), 0o755);
    process.env.PATH = `${join(tmp, 'path')}${delimiter}${process.env.PATH}`;
    const stack = join(tmp, 'stack');
    await mkdir(stack);
    await writeFile(join(stack, 'IDENTITY.md'), '# Art E Fish\n\nCreed.');
    handle = await startHttpServer({ contextDir: stack, host: '127.0.0.1', port: 0, token: TOKEN });
    base = `http://127.0.0.1:${handle.port}`;
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await handle?.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it('draws 15 rows and numbered pages; page 2 is rows 16 to 30; a short panel is whole; nothing is wider than the phone', async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    await ctx.request.post(`${base}/login`, { form: { token: TOKEN }, maxRedirects: 0 });
    const page = await ctx.newPage();
    await page.goto(`${base}/p/lots`);
    await page.waitForSelector('[data-slot="panel"]', { timeout: 20_000 });
    const panels = page.locator('[data-slot="panel"]');
    const labels = (i: number) => panels.nth(i).locator('ul').first().locator(':scope > li').evaluateAll((ls) => ls.map((l) => (l.textContent ?? '').match(/^(Secret|Rule) \d+/)?.[0]));
    // Before (panels drew every row): 40 rows. After: the first 15, then the pager, then the panel's action.
    expect(await labels(0)).toEqual(Array.from({ length: 15 }, (_, i) => `Secret ${i + 1}`));
    const pager = panels.nth(0).getByRole('navigation', { name: 'Pages of this list' });
    await expect.poll(() => pager.count()).toBe(1);
    expect(await panels.nth(0).getByRole('button', { name: 'Add one' }).count()).toBe(1);
    await pager.getByText('2', { exact: true }).click();
    await expect.poll(() => labels(0)).toEqual(Array.from({ length: 15 }, (_, i) => `Secret ${i + 16}`));
    // A short panel: whole, no pager.
    expect(await labels(1)).toEqual(['Rule 1', 'Rule 2', 'Rule 3']);
    expect(await panels.nth(1).getByRole('navigation').count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await ctx.close();
  }, 60_000);
});
