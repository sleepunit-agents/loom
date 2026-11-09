/**
 * The desktop's ticker (docs/specs/agent-desk.md, "The ticker"; t-1959 phase 5): centred on the screen, whatever the
 * bar's two sides hold, and each item opens its app: the agents Home, an agent its window, a place (Tasks, Boxes,
 * Bridges…) its own page, in a tile. At 1280, 1440 and 1920 in all three looks.
 *
 * Runs where the app is built (npm run build) and a Chrome is installed (GitHub's runners have one).
 */
import { describe, it, expect as vexpect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright-core';
import { deskHome, type DeskHome } from './agent-desk.fixture.js';

vi.setConfig({ testTimeout: 90_000 });
const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);
const SHOTS = process.env.LOOM_DESK_SHOTS;
const expect = Object.assign(((v: unknown, m?: string) => vexpect(v, m)) as typeof vexpect, vexpect,
  { poll: (f: () => unknown, o?: { timeout?: number }) => vexpect.poll(f, { timeout: 10_000, ...o }) }) as typeof vexpect;

describe.runIf(built && chrome)('the desktop\'s ticker', () => {
  let d: DeskHome;
  let browser: Browser;
  const errors: string[] = [];

  beforeAll(async () => {
    if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    d = await deskHome({ art: 'Art E Fish with a very long agent name', mark: 'Mark' });
    d.report({}, { stat: '3 boxes · swap 94%', tone: 'warn' });
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  }, 90_000);
  afterAll(async () => { await browser?.close(); await d?.close(); });

  async function screen(w: number, h: number, path: string, look = 'neon', motion: 'reduce' | 'no-preference' = 'reduce'): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: motion, serviceWorkers: 'block' });
    await ctx.addInitScript(`localStorage.setItem('loom-look', '${look}'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
    await ctx.request.post(`${d.base}/login`, { form: { token: d.tok.jonathan }, maxRedirects: 0 });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${d.base}${path}`);
    await p.locator('.loom-top--one .loom-tick').waitFor();
    return p;
  }
  const centre = (p: Page) => p.locator('.loom-top--one .loom-tick').evaluate((e) => { const r = e.getBoundingClientRect(); return r.left + r.width / 2; });

  for (const look of ['neon', 'lowlight', 'daylight'] as const) for (const [w, h] of [[1024, 768], [1280, 800], [1440, 900], [1920, 1080]] as const) {
    it(`at ${w}×${h} (${look}): the ticker stands in the middle of the screen, on Home and with a long page name`, async () => {
      const p = await screen(w, h, '/', look);
      expect(Math.abs((await centre(p)) - w / 2)).toBeLessThanOrEqual(1);
      // Its words, when they fit, in its middle too.
      const words = await p.locator('.loom-tick__line').first().evaluate((e) => { const r = document.createRange(); r.selectNodeContents(e); const b = r.getBoundingClientRect(); return b.left + b.width / 2; });
      if (await p.locator('.loom-tick[data-fits]').count()) expect(Math.abs(words - w / 2)).toBeLessThanOrEqual(2);
      // A tile with a long name on the left: the ticker doesn't move.
      await p.goto(`${d.base}/inbox?t=*inbox`); await p.locator('.loom-tile').waitFor();
      expect(Math.abs((await centre(p)) - w / 2)).toBeLessThanOrEqual(1);
      if (SHOTS) await p.screenshot({ path: `${SHOTS}/ticker-${look}-${w}.png`, clip: { x: 0, y: 0, width: w, height: 60 } });
      await p.context().close();
    });
  }

  it('each item opens its app: a place its page in a tile, an agent its window, the agents Home', async () => {
    const p = await screen(1920, 1080, '/');
    const part = (t: string) => p.locator('.loom-top--one .loom-tick__line:not([aria-hidden]) .loom-tick__part', { hasText: t }).first();
    await part('swap 94%').click();
    await expect.poll(() => p.$$eval('.loom-tile', (ts) => ts.map((t) => t.getAttribute('data-tile')))).toEqual(['/p/runtime']);
    await part('Mark').click();
    await expect.poll(() => p.$$eval('.loom-tile', (ts) => ts.map((t) => t.getAttribute('data-tile')))).toContain('/a/mark');
    await part('2 agents').click();
    await expect.poll(() => p.locator('.loom-tile').count()).toBe(0);
    await p.locator('.loom-adesk').waitFor();
    // Each is a link, so it can open in a tab of its own too.
    expect(await part('swap 94%').getAttribute('href')).toBe('/p/runtime');
    await p.context().close();
  });

  it('running (its words too long): the copy that follows it round is out of the tab order', async () => {
    const p = await screen(1280, 800, '/', 'neon', 'no-preference');
    await p.evaluate(() => { document.querySelector<HTMLElement>('.loom-top--one .loom-tick')!.style.maxWidth = '120px'; dispatchEvent(new Event('resize')); });
    await expect.poll(() => p.locator('.loom-tick[data-run]').count()).toBe(1);
    const copy = p.locator('.loom-tick__line[aria-hidden] a');
    expect(await copy.count()).toBeGreaterThan(0);
    expect(await copy.evaluateAll((as) => as.every((a) => a.getAttribute('tabindex') === '-1'))).toBe(true);
    await p.context().close();
  });

  for (const width of [1024, 1280]) it(`fresh safe activity, expiry, idle and navigation at ${width}`, async () => {
    const t = d.thread('jonathan', 'mark', 'Private words never belong in the ticker', 'A long conversation title');
    const now = Date.now();
    d.report({ mark: { readings: [], doing: [{ text: 'private raw text', kind: 'talk', where: 'Discord', conversation: t.conversation,
      activity: { action: 'Running a command', observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 12000).toISOString() } }] } });
    await d.changed();
    const p = await screen(width, 800, '/');
    const line = p.locator('.loom-top--one .loom-tick__line').first();
    expect(await line.innerText()).toContain('Mark · Running a command · Comms');
    expect(await line.innerText()).not.toContain('private raw text');
    expect(await line.innerText()).not.toContain('Private words');
    expect(await p.locator('.loom-top--one .loom-tick__live').first().isVisible()).toBe(false);
    expect(await p.locator('.loom-top--one .loom-tick').getAttribute('data-run')).toBeNull();
    // Its current activity opens the actual authorized conversation.
    const link = line.locator('a', { hasText: 'Mark · Running' });
    expect(await link.getAttribute('href')).toContain(t.id.replace(/^th:/, ''));
    await link.click();
    await expect.poll(() => p.url()).toContain(t.id.replace(/^th:/, ''));
    await expect.poll(() => line.innerText(), { timeout: 16000 }).toContain('Mark · Activity unavailable');
    d.report({ mark: { idle: { observedAt: new Date().toISOString(), expiresAt: new Date(Date.now()+30000).toISOString() } } }); await d.changed();
    await p.reload();
    await expect.poll(() => line.innerText()).toContain('Mark · Idle');
    await p.context().close();
  });

  it('a saved offline shell cannot keep its fresh-looking activity claim', async () => {
    const t = d.thread('jonathan', 'mark', 'private', 'A conversation');
    d.report({ mark: { doing: [{ text: 'private', kind: 'talk', conversation: t.conversation,
      activity: { action: 'Reading a file', observedAt: new Date().toISOString(), expiresAt: new Date(Date.now()+30000).toISOString() } }] } });
    await d.changed();
    const p = await screen(1280, 800, '/');
    const line = p.locator('.loom-top--one .loom-tick__line').first();
    await expect.poll(() => line.innerText()).toContain('Mark · Reading a file');
    const cached = await (await p.context().request.get(d.base+'/', { headers: {accept:'application/json'} })).json();
    await p.route(d.base+'/', route => route.request().headers().accept?.includes('application/json')
      ? route.fulfill({json:cached,headers:{'x-loom-saved-at':new Date().toISOString()}}) : route.continue());
    await p.evaluate(() => dispatchEvent(new Event('online')));
    await expect.poll(() => line.innerText()).toContain('Mark · Activity unavailable');
    expect(await line.innerText()).not.toContain('Mark · Reading a file');
    await p.context().close();
  });

  it('no page threw', () => { expect(errors).toEqual([]); });
});
