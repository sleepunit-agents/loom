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
import { openThread } from '../comms.js';

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
  let thread: string;
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
    token = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: 'jonathan' }).token;
    thread = openThread(h, process.env, h.members[0], { agent: 'art', id: 'cccccccccccccccc', text: 'A thread with Art' }).thread.id;
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
  const KEY = (label: string) => `.loom-dock-bar [data-part="item"][aria-label="${label}"]`;
  const labels = (p: Page) => p.$$eval('.loom-tile', (ts) => ts.map((t) => (t.getAttribute('aria-label') ?? '').replace(/^tile \d+ of \d+, /, '')));

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

  // ---- B. windows ----
  it('a page named as its app never repeats it: no "COMMS › COMMS"; the name is the way up', async () => {
    const p = await screen(1280, 800, { path: `/comms/${thread}?t=*comms` });
    const bar = p.locator('.loom-tile[data-tile="/comms"] .loom-tile__bar');
    await bar.locator('h2').waitFor();
    // the thread itself (not an error page, which is named as its app too)
    await expect.poll(() => p.locator('.loom-tile[data-tile="/comms"] .loom-tile__page').getByText('A thread with Art').count()).toBeGreaterThan(0);
    await expect.poll(() => bar.locator('h2').textContent()).toBe('Comms');
    expect(await bar.locator('.loom-tile__crumb').count()).toBe(0);
    // one "Comms" in the strip's words (the path chip is loom's address, aria-hidden)
    expect((await bar.locator(':is(.loom-tile__crumb, h2)').allTextContents()).join(' ')).toBe('Comms');
    await bar.locator('h2 a').click();
    await expect.poll(() => new URL(p.url()).pathname).toBe('/comms');
    // at the app's start there's no way up: the name alone
    expect(await bar.locator('h2 a').count()).toBe(0);
    await p.context().close();
  });

  it('a page named otherwise keeps the app before it: Setup › Appearance', async () => {
    const p = await screen(1280, 800, { path: '/setup?t=*setup' });
    const t = p.locator('.loom-tile[data-tile="/setup"]');
    await t.locator('a, button', { hasText: 'Appearance' }).first().click();
    await expect.poll(() => t.locator('.loom-tile__bar h2').textContent()).toBe('Appearance');
    expect(await t.locator('.loom-tile__crumb').textContent()).toBe('Setup');
    await p.context().close();
  });

  it('Recent here: not beside a window alone on the desktop (it gets the room); still beside a wide one sharing it', async () => {
    const p = await screen(1920, 1080, { path: '/setup?t=*setup&w=' });
    const t = p.locator('.loom-tile[data-tile="/setup"]');
    await t.locator('a, button', { hasText: 'Appearance' }).first().click();
    await expect.poll(() => t.locator('.loom-tile__bar h2').textContent()).toBe('Appearance');
    await t.locator('.loom-tile__btn[aria-label^="Back"]').click();
    await expect.poll(() => t.locator('.loom-tile__bar h2').textContent()).toMatch(/setup/i);
    expect((await box(p, '.loom-tile')).width).toBeGreaterThan(1100);
    await p.waitForTimeout(300);
    expect(await t.locator('.loom-tile__side').count()).toBe(0);
    // the page has the tile's whole width
    const [body, page] = [await box(p, '.loom-tile__body'), await box(p, '.loom-tile__page')];
    expect(page.width).toBeGreaterThan(body.width - 40);
    await p.context().close();
    // 3000 px with two: the big tile is still wide, and shares the screen: Recent here is beside it
    const q = await screen(3000, 1440, { path: '/setup?t=*setup&w=' });
    const u = q.locator('.loom-tile[data-tile="/setup"]');
    await u.locator('a, button', { hasText: 'Appearance' }).first().click();
    await expect.poll(() => u.locator('.loom-tile__bar h2').textContent()).toBe('Appearance');
    await u.locator('.loom-tile__btn[aria-label^="Back"]').click();
    await q.click(KEY('Inbox'));
    await expect.poll(() => labels(q)).toEqual(['Setup', 'Inbox']);
    expect((await box(q, '.loom-tile[data-tile="/setup"]')).width).toBeGreaterThanOrEqual(1100);
    await expect.poll(() => u.locator('.loom-tile__side', { hasText: 'Recent here' }).count()).toBe(1);
    await q.context().close();
  });

  it('one loader: its three sizes in px, whatever the text around it; no old spinner in the app', async () => {
    const p = await screen(1280, 800);
    const sizes = await p.evaluate(() => [12, 40].flatMap((fs) => ['sm', 'md', 'lg'].map((size) => {
      const host = document.createElement('div');
      host.style.fontSize = `${fs}px`;
      host.innerHTML = `<span class="loom-load" data-slot="spinner" data-size="${size}"><i></i><i></i><i></i><i></i></span>`;
      document.body.append(host);
      const r = host.firstElementChild!.getBoundingClientRect();
      host.remove();
      return `${fs}:${size}:${r.width}x${r.height}`;
    })));
    expect(sizes).toEqual(['12:sm:16x16', '12:md:24x24', '12:lg:40x40', '40:sm:16x16', '40:md:24x24', '40:lg:40x40']);
    // the app's scripts carry no other spinner (the orbit and bloom drawings are gone)
    const old = await p.evaluate(async () => {
      const srcs = [...document.querySelectorAll<HTMLScriptElement>('script[src], link[rel="modulepreload"]')].map((e) => (e as HTMLScriptElement).src || (e as HTMLLinkElement).href);
      const texts = await Promise.all(srcs.map((u) => fetch(u).then((r) => r.text())));
      return texts.some((t) => /v-pulse__orbit|v-pulse__mark/.test(t));
    });
    expect(old).toBe(false);
    await p.context().close();
  });

  /** Every window effect <html data-tile-fx> wore, and the loom-fx animations that ran under each. */
  const watchFx = (p: Page) => p.evaluate(() => {
    const w = window as unknown as { fx: string[]; fxAnims: string[] };
    w.fx = []; w.fxAnims = [];
    new MutationObserver(() => {
      const k = document.documentElement.dataset.tileFx;
      if (!k) return;
      w.fx.push(k);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        for (const a of document.getAnimations()) { const n = (a as CSSAnimation).animationName; if (n?.startsWith('loom-fx')) w.fxAnims.push(`${k}:${n}`); }
      }));
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-tile-fx'] });
  });
  const fxSeen = (p: Page) => p.evaluate(() => { const w = window as unknown as { fx: string[]; fxAnims: string[] }; return { fx: w.fx, anims: [...new Set(w.fxAnims)] }; });
  /** Open, open, make big, minimize, bring back, close: each waits for the last to settle. */
  async function windows(p: Page) {
    const settle = () => p.waitForFunction(() => !document.documentElement.dataset.tileMove);
    await p.click(KEY('Inbox')); await expect.poll(() => labels(p)).toEqual(['Inbox']); await settle();
    await p.click(KEY('Comms')); await expect.poll(() => labels(p)).toEqual(['Inbox', 'Comms']); await settle();
    await p.locator('button[aria-label="Make Comms the big one"]').click(); await expect.poll(() => labels(p)).toEqual(['Comms', 'Inbox']); await settle();
    await p.locator('button[aria-label="Minimize Comms to the dock"]').click(); await expect.poll(() => labels(p)).toEqual(['Inbox']); await settle();
    await p.click(KEY('Comms')); await expect.poll(() => labels(p)).toContain('Comms'); await settle();
    await p.locator('button[aria-label="Close Comms"]').click(); await expect.poll(() => labels(p)).toEqual(['Inbox']); await settle();
  }

  it('each window move has its own effect: open, make big, minimize, bring back, close', async () => {
    const p = await screen(1280, 800, { motion: 'no-preference', path: '/?w=needs' });
    await watchFx(p);
    await windows(p);
    const seen = await fxSeen(p);
    expect(seen.fx).toEqual(['open', 'open', 'max', 'min', 'restore', 'close']);
    for (const a of ['open:loom-fx-on', 'max:loom-fx-glitch', 'min:loom-fx-wipe-out', 'restore:loom-fx-wipe-in', 'close:loom-fx-off']) expect(seen.anims, a).toContain(a);
    // each short: none over 350 ms
    const long = await p.evaluate(() => [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } })
      .map((r) => r.cssText).filter((t) => /loom-fx-/.test(t) && /animation:/.test(t)).map((t) => /(\.\d+|\d+(\.\d+)?)s/.exec(t)?.[0]).filter((d) => d && parseFloat(d) > 0.35));
    expect(long).toEqual([]);
    expect(await p.evaluate(() => document.documentElement.dataset.tileFx ?? null)).toBeNull();
    await p.context().close();
  });

  it('under reduced motion none of them run, and the windows still open, move and close', async () => {
    const p = await screen(1280, 800, { motion: 'reduce', path: '/?w=needs' });
    await watchFx(p);
    await windows(p);
    expect(await fxSeen(p)).toEqual({ fx: [], anims: [] });
    await p.context().close();
  });

  it('no page errors on the way', () => { expect(errors).toEqual([]); });
});
