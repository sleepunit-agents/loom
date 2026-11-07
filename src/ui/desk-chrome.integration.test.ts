/**
 * The desktop's chrome (t-1925; docs/specs/desk-tiling.md, "The bar", criterion 22): one bar across the top, as a
 * desktop OS has (the clock and the page's name on its left, LOOM//OS and the status glyphs on its right, the ticker
 * between); the ticker widget gone (the bar has it), and a layout saved with it loads without it and is written again
 * without it; no headline on the desktop. A phone keeps its own bar. Real Chrome, Neon Noir.
 *
 * Runs where the app is built (npm run build) and a Chrome is installed (GitHub's runners have one).
 */
import { describe, it, expect as vexpect, beforeAll, afterAll, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { createToken, loadHousehold, type Household } from '../household.js';
import { createConversationTables } from '../backends/conversations.js';
import { closeAllBackends } from '../backends/index.js';

const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);
const expect = Object.assign(((v: unknown, m?: string) => vexpect(v, m)) as typeof vexpect, vexpect,
  { poll: (f: () => unknown, o?: { timeout?: number }) => vexpect.poll(f, { timeout: 10_000, ...o }) }) as typeof vexpect;

describe.runIf(built && chrome)('the desktop\'s chrome', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  const saved: Record<string, string | undefined> = {};
  const errors: string[] = [];

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-desk-chrome-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db')); createConversationTables(db); db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', owner: 'jonathan',
      members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
    for (const k of ['LOOM_HOME', 'XDG_CONFIG_HOME']) saved[k] = process.env[k];
    process.env.LOOM_HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    h = loadHousehold(home)!;
    token = createToken(h, { role: { kind: 'owner' }, label: 'jonathan' }).token;
    handle = await startHttpServer({ contextDir: join(home, 'agents', 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await handle?.close();
    await closeAllBackends();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (h) rmSync(h.home, { recursive: true, force: true });
  });

  /** A device this size, signed in: nothing saved but what `init` puts there (once, before the first page). */
  async function screen(width: number, height: number, o: { path?: string; init?: string; motion?: 'reduce' | 'no-preference' } = {}): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: o.motion ?? 'reduce', serviceWorkers: 'block' });
    await ctx.addInitScript(`if (!sessionStorage.getItem('t')) { sessionStorage.setItem('t', '1'); localStorage.setItem('loom-look', 'neon'); ${o.init ?? ''} } sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`${width}: ${e.message}`));
    await p.goto(`${base}${o.path ?? '/'}`);
    await p.locator(width >= 1024 ? '.loom-tiles' : '.loom-top h1').waitFor();
    await p.waitForTimeout(300);
    return p;
  }
  const widgets = (p: Page) => p.$$eval('[data-widget]', (ws) => ws.map((w) => w.getAttribute('data-widget')));
  const box = async (p: Page, sel: string) => (await p.locator(sel).first().boundingBox())!;

  // ---- A. the bar ----
  for (const [w, hgt] of [[1024, 768], [1280, 800], [1920, 1080]]) {
    it(`one bar at ${w}: the clock then the name on the left, LOOM//OS then the glyphs on the right, the ticker between`, async () => {
      const p = await screen(w, hgt);
      expect(await p.locator('.loom-top').count()).toBe(1);
      expect(await p.locator('.loom-sys').count()).toBe(0);
      expect(await p.locator('.loom-pbar').count()).toBe(1);
      const [bar, clock, name, tick, brand, icons] = await Promise.all(['.loom-pbar--one', '.loom-pbar--one .loom-sys__clock', '.loom-pbar__name',
        '.loom-pbar--one .loom-tick', '.loom-pbar__brand', '.loom-pbar--one .loom-sys__icons'].map((s) => box(p, s)));
      // One line, 34 px: every part on its middle.
      expect(Math.round(bar.height)).toBe(34);
      for (const b of [clock, name, tick, brand, icons]) expect(Math.abs(b.y + b.height / 2 - (bar.y + bar.height / 2))).toBeLessThanOrEqual(2);
      // In order, left to right.
      expect(clock.x).toBeLessThan(name.x);
      expect(name.x + name.width).toBeLessThanOrEqual(tick.x + 1);
      expect(tick.x + tick.width).toBeLessThanOrEqual(brand.x + 1);
      expect(brand.x + brand.width).toBeLessThanOrEqual(icons.x);
      // The ticker has the room between them; the bar spans the screen; nothing sideways.
      expect(tick.width).toBeGreaterThan(w / 3);
      expect(bar.width).toBeGreaterThan(w - 60);
      expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
      await p.context().close();
    });
  }

  it('under 1024 px, two bars as before (at 1023): loom\'s status bar over the phone\'s', async () => {
    const p = await screen(1023, 768);
    expect(await p.locator('.loom-sys').count()).toBe(1);
    expect(await p.locator('.loom-pbar--one').count()).toBe(0);
    expect(Math.round((await box(p, '.loom-pbar')).height)).toBe(24);
    await p.context().close();
  });

  it('iOS\'s home-screen app (an iPad, landscape) draws its own clock and status: the one bar drops loom\'s', async () => {
    const p = await screen(1180, 820, { init: `Object.defineProperty(navigator, 'standalone', { get: () => true });` });
    expect(await p.evaluate(() => document.documentElement.classList.contains('loom-ios-app'))).toBe(true);
    expect(await p.locator('.loom-pbar--one').count()).toBe(1);
    expect(await p.locator('.loom-pbar--one :is(.loom-sys__clock, .loom-sys__icons)').evaluateAll((es) => es.map((e) => getComputedStyle(e).display))).toEqual(['none', 'none']);
    expect(await p.locator('.loom-pbar__brand').isVisible()).toBe(true);
    await p.context().close();
  });

  it('a phone keeps its own bar: the name, the ticker, LOOM//OS; no clock, no glyphs', async () => {
    const p = await screen(390, 844);
    expect(await p.locator('.loom-pbar').count()).toBe(1);
    expect(await p.locator('.loom-pbar--one').count()).toBe(0);
    expect(await p.locator('.loom-sys, .loom-sys__clock, .loom-sys__icons').count()).toBe(0);
    expect(await p.locator('.loom-pbar .loom-tick').count()).toBe(1);
    expect(Math.round((await box(p, '.loom-pbar')).height)).toBe(24);
    await p.context().close();
  });

  // ---- A. the ticker widget, gone ----
  it('the seed has no ticker and the desktop no headline', async () => {
    const p = await screen(1280, 800);
    await expect.poll(() => widgets(p)).toEqual(['needs', 'art', 'mark', 'vitals', 'backup']);
    expect(await p.locator('.loom-desk-headline, .loom-w--ticker').count()).toBe(0);
    expect(await p.getByText('Everyone’s fine').count()).toBe(0);
    await p.context().close();
  });

  it('a layout saved with the ticker loads without it, and is kept without it', async () => {
    const init = `localStorage.setItem('loom-tiles', JSON.stringify({ t: [], m: [], w: ['needs', 'ticker', 'mark'] }));`;
    const p = await screen(1280, 800, { init });
    await expect.poll(() => widgets(p)).toEqual(['needs', 'mark']);
    expect(await p.evaluate(() => JSON.parse(localStorage.getItem('loom-tiles') ?? 'null')?.w)).toEqual(['needs', 'mark']);
    expect(new URL(p.url()).searchParams.get('w')).toBe('needs,mark');
    // and an address that names it
    await p.goto(`${base}/?w=ticker,vitals`);
    await expect.poll(() => widgets(p)).toEqual(['vitals']);
    expect(await p.evaluate(() => JSON.parse(localStorage.getItem('loom-tiles') ?? 'null')?.w)).toEqual(['vitals']);
    // Find offers no ticker to add.
    await p.keyboard.press('Control+k');
    await p.locator('input[aria-label="Find anything"]').fill('ticker');
    await p.waitForTimeout(300);
    expect(await p.locator('[role="option"]', { hasText: 'Add widget' }).count()).toBe(0);
    await p.context().close();
  });

  it('no page errors on the way', () => { expect(errors).toEqual([]); });
});
