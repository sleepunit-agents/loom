/**
 * Home off loom's bare "something changed" (t-2028; docs/specs/collections.md, "each agent's card"): its cards, what's
 * moving and what needs you are live records, and so now is the bar's ticker and each agent's "active N ago"
 * (agent-status 1.2). A job and its step reach an open Home, on a desktop and on a phone, in every look, without Home's
 * page being asked again (before: once for each change). Its timer still asks, for its chrome (the tiles' stats, the
 * backup and Boxes alerts), at 60 s while the stream is open.
 *
 * Runs where the app is built (npm run build) and a Chrome is installed (GitHub's runners have one).
 */
import { describe, it, expect as vexpect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright-core';
import { deskHome, type DeskHome } from './agent-desk.fixture.js';

vi.setConfig({ testTimeout: 90_000 });
const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/local/bin/chrome-headless-shell'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);
const expect = Object.assign(((v: unknown, m?: string) => vexpect(v, m)) as typeof vexpect, vexpect,
  { poll: (f: () => unknown, o?: { timeout?: number }) => vexpect.poll(f, { timeout: 30_000, ...o }) }) as typeof vexpect;

describe.runIf(built && chrome)('Home, live', () => {
  let d: DeskHome;
  let browser: Browser;
  const errors: string[] = [];

  beforeAll(async () => {
    d = await deskHome({ art: 'Art', mark: 'Mark' });
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  }, 90_000);
  afterAll(async () => { await browser?.close(); await d?.close(); });

  async function screen(w: number, look: string): Promise<Page> {
    const phone = w < 640;
    const ctx = await browser.newContext({ viewport: { width: w, height: phone ? 844 : 900 }, reducedMotion: 'reduce', isMobile: phone, hasTouch: phone, serviceWorkers: 'block' });
    await ctx.addInitScript(`localStorage.setItem('loom-look', '${look}'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
    await ctx.request.post(`${d.base}/login`, { form: { token: d.tok.jonathan }, maxRedirects: 0 });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${d.base}/`);
    await p.locator('.loom-tick__line').first().waitFor({ state: 'attached' });
    return p;
  }
  const line = (p: Page) => p.locator('.loom-tick__line:not([aria-hidden])').first();

  for (const look of ['neon', 'lowlight', 'daylight'] as const) for (const w of [1440, 390] as const) {
    it(`at ${w} (${look}): a job and its step reach Home with no ask for Home's page`, async () => {
      d.report({});
      await d.changed();
      const p = await screen(w, look);
      await p.waitForFunction(() => document.documentElement.dataset.attention === 'live');
      await expect.poll(() => line(p).textContent()).toContain('Mark · Activity unavailable');
      // Let the first page's own follow-ups settle, then count every ask for Home's page.
      await p.waitForTimeout(1_500);
      const asked: string[] = [];
      p.on('request', (r) => { if (new URL(r.url()).pathname === '/' && r.resourceType() !== 'document') asked.push(r.url()); });
      const now = Date.now();
      d.report({ mark: { jobs: [{ id: 'job-mark', text: 'Sorting the photo library', kind: 'lane', status: 'running', where: 'wake', since: new Date(now).toISOString() }],
        doing: [{ text: 'Sorting the photo library', kind: 'lane', where: 'wake', since: new Date(now).toISOString(),
          activity: { action: 'Reading a file', observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 28_000).toISOString() } }] } });
      await d.changed();
      await expect.poll(() => line(p).textContent()).toContain('Mark · Reading a file · a wake');
      if (w >= 640) await expect.poll(() => p.locator('.loom-bigcard[data-agent="mark"]').textContent()).toMatch(/working|Sorting the photo library/i);
      // It ends: the ticker says so, still with nothing asked of Home's page.
      d.report({});
      await d.changed();
      await expect.poll(() => line(p).textContent()).toContain('Mark · Activity unavailable');
      expect(asked).toEqual([]);
      expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
      await p.context().close();
    });
  }

  it('no page threw', () => { expect(errors).toEqual([]); });
});
