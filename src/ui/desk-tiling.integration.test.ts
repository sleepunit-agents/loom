/**
 * Desk tiling, phase 3 (docs/specs/desk-tiling.md, criteria 10, 11, 12, 14, 17 for apps, 18 and 20's phone half): with
 * Tiling chosen, apps share a big screen as tiles, each with its own page and history; the dock opens, focuses,
 * minimizes and brings back; the address carries the set and a reload restores it; One window at a time, the default,
 * is today's window. The apps are ones every household has (Inbox, Comms, Setup, Places, People, Knowledge): the
 * criteria's Tasks and Changes are pieces a test household doesn't install. Real Chrome, Neon Noir.
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
// A tile waits on its page and its chunk: every poll gets 10 seconds.
const expect = Object.assign(((v: unknown, m?: string) => vexpect(v, m)) as typeof vexpect, vexpect,
  { poll: (f: () => unknown, o?: { timeout?: number }) => vexpect.poll(f, { timeout: 10_000, ...o }) }) as typeof vexpect;
const KEY = (label: string) => `.loom-dock-bar [data-part="item"][aria-label="${label}"]`;
type Box = { label: string; x: number; y: number; w: number; h: number; focused: boolean };

describe.runIf(built && chrome)('desk tiling: apps share the screen as tiles', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-desk-tiling-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db')); createConversationTables(db); db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', owner: 'jonathan', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
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

  /** A screen this size, signed in; Tiling chosen on this device unless `tiling: false`. */
  async function screen(width: number, height: number, o: { path?: string; tiling?: boolean; touch?: boolean } = {}): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', serviceWorkers: 'block', hasTouch: !!o.touch, isMobile: !!o.touch });
    const tiling = o.tiling === false ? '' : `localStorage.setItem('loom-tiling', 'on');`;
    await ctx.addInitScript(`localStorage.setItem('loom-look', 'neon'); ${tiling} sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    await p.goto(`${base}${o.path ?? '/'}`);
    await p.locator('.loom-dock-bar [data-part="item"]').first().waitFor();
    // Tiled once the desk's chunk is here (its tile desk drawn); else the page as it was.
    if (o.tiling !== false && width >= 1024) await p.locator('.loom-tiles').waitFor();
    await p.waitForTimeout(300);
    return p;
  }
  const where = (p: Page) => { const u = new URL(p.url()); return decodeURIComponent(u.pathname + u.search); };
  const query = (p: Page, k: string) => new URL(p.url()).searchParams.get(k);
  const tiles = (p: Page): Promise<Box[]> => p.$$eval('.loom-tile', (ts) => ts.map((t) => {
    const r = t.getBoundingClientRect();
    return { label: (t.getAttribute('aria-label') ?? '').replace(/^tile \d+ of \d+, /, ''), x: r.x, y: r.y, w: r.width, h: r.height, focused: t.hasAttribute('data-focused') };
  }));
  const labels = async (p: Page) => (await tiles(p)).map((t) => t.label);
  const open = async (p: Page, label: string, n: number) => { await p.click(KEY(label)); await expect.poll(() => p.locator('.loom-tile').count()).toBe(n); };
  const tile = (p: Page, label: string) => p.locator(`.loom-tile[aria-label$=", ${label}"]`);

  for (const [w, hgt] of [[1024, 768], [1280, 800], [1920, 1080]]) {
    it(`10. open, focus, minimize and back, at ${w}×${hgt}`, async () => {
      const p = await screen(w, hgt);
      expect(await p.locator('.loom-desk-home').count()).toBe(1);
      await open(p, 'Inbox', 1);
      await open(p, 'Comms', 2);
      expect(query(p, 't')).toBe('inbox,*comms');
      expect((await tiles(p)).map((t) => [t.label, t.focused])).toEqual([['Inbox', false], ['Comms', true]]);
      // its key again: minimized
      await p.click(KEY('Comms')); await expect.poll(() => p.locator('.loom-tile').count()).toBe(1);
      expect([query(p, 't'), query(p, 'm')]).toEqual(['*inbox', 'comms']);
      // and back, on the page it was on
      await open(p, 'Comms', 2);
      // (a fresh device's widgets, today's Home set, ride in the address too: desk-tiling-widgets.integration.test.ts)
      expect(where(p)).toBe('/comms?t=inbox,*comms&w=needs,art,mark,vitals,backup');
      // a page scrolled down comes back scrolled where it was: Setup's Appearance, in a short screen
      await p.click(KEY('Setup')); await expect.poll(() => p.locator('.loom-tile').count()).toBeGreaterThanOrEqual(2);
      const setup = tile(p, 'Setup');
      await setup.locator('a, button', { hasText: 'Appearance' }).first().click();
      await expect.poll(() => where(p)).toMatch(/^\/appearance\?/);
      await setup.locator('[aria-label="Desktop"]').waitFor();
      // a short screen, so Appearance scrolls in its tile
      await p.setViewportSize({ width: w, height: 560 });
      const body = setup.locator('.loom-tile__body');
      await expect.poll(() => body.evaluate((b) => b.scrollHeight - b.clientHeight)).toBeGreaterThan(100);
      const top = await body.evaluate((b) => { b.scrollTop = 100; return b.scrollTop; });
      expect(top).toBe(100);
      await p.click(KEY('Setup')); await expect.poll(() => tile(p, 'Setup').count()).toBe(0);
      await p.click(KEY('Setup')); await tile(p, 'Setup').locator('[aria-label="Desktop"]').waitFor();
      expect(new URL(p.url()).pathname).toBe('/appearance');
      await expect.poll(() => tile(p, 'Setup').locator('.loom-tile__body').evaluate((b) => b.scrollTop)).toBe(top);
      await p.context().close();
    }, 60_000);
  }

  for (const [w, hgt] of [[1024, 768], [1280, 800], [1920, 1080]]) {
    it(`11. history per tile, and the browser's Back, at ${w}×${hgt}`, async () => {
      const p = await screen(w, hgt);
      const before = await p.evaluate(() => history.length);
      await open(p, 'Setup', 1);
      await open(p, 'Inbox', 2);
      // opening adds no browser history; closing neither
      expect(await p.evaluate(() => history.length)).toBe(before);
      await tile(p, 'Inbox').locator('button[aria-label="Close Inbox"]').click();
      await expect.poll(() => p.locator('.loom-tile').count()).toBe(1);
      expect(await p.evaluate(() => history.length)).toBe(before);
      await p.click(KEY('People')); await expect.poll(() => labels(p)).toEqual(['Setup', 'People']);
      // a page change in each tile: People to a person, Setup to Accessibility; then Setup's own Back: only Setup moves
      await tile(p, 'People').locator('main a[href^="/people/"], a[href^="/people/"]').first().click();
      await expect.poll(() => new URL(p.url()).pathname).toMatch(/^\/people\/./);
      const person = new URL(p.url()).pathname;
      const setup = tile(p, 'Setup');
      await setup.locator('a, button', { hasText: 'Accessibility' }).first().click();
      await expect.poll(() => new URL(p.url()).pathname).toBe('/accessibility');
      expect(await p.evaluate(() => history.length)).toBe(before + 2);
      await setup.locator('.loom-tile__btn[aria-label^="Back"]').click();
      await expect.poll(() => new URL(p.url()).pathname).toBe('/setup');
      // People stayed on its person
      expect(await tile(p, 'People').locator('.loom-tile__path').textContent()).toBe(`loom${person}`);
      // the browser's Back and Forward walk the focused tile's history
      await setup.locator('a, button', { hasText: 'Appearance' }).first().click();
      await expect.poll(() => new URL(p.url()).pathname).toBe('/appearance');
      await p.goBack();
      await expect.poll(() => new URL(p.url()).pathname).toBe('/setup');
      await expect.poll(() => setup.locator('h2').textContent()).toMatch(/setup/i);
      expect(await p.locator('.loom-tile').count()).toBe(2);
      // what the browser's Back landed on is the tile's page now: minimized and back, it's Setup's start, not Appearance
      await p.click(KEY('Setup')); await expect.poll(() => tile(p, 'Setup').count()).toBe(0);
      expect(query(p, 'm')).toBe('setup');
      await p.click(KEY('Setup')); await tile(p, 'Setup').waitFor();
      await expect.poll(() => new URL(p.url()).pathname).toBe('/setup');
      await p.context().close();
    }, 60_000);
  }

  for (const [w, hgt] of [[1280, 800], [1920, 1080]]) {
    it(`12. a link to another app opens it right after its tile; one within the app stays, at ${w}×${hgt}`, async () => {
      const p = await screen(w, hgt, { path: '/places?t=*places' });
      await expect.poll(() => labels(p)).toEqual(['Places']);
      await open(p, 'Inbox', 2);
      expect(await labels(p)).toEqual(['Places', 'Inbox']);
      await tile(p, 'Places').locator('button', { hasText: 'People' }).first().click();
      // At 1280×800 three of these don't fit (two stacked would be under the Inbox's 320 px minimum height): the one used
      // least recently that isn't the one opened or the one it came from, the Inbox, goes to the dock, and a toast says so.
      if (w >= 1920) {
        await expect.poll(() => labels(p)).toEqual(['Places', 'People', 'Inbox']);
        expect(query(p, 't')).toBe('places,*people,inbox');
      } else {
        await expect.poll(() => labels(p)).toEqual(['Places', 'People']);
        expect([query(p, 't'), query(p, 'm')]).toEqual(['places,*people', 'inbox']);
        await expect.poll(() => p.getByText('Inbox went to the dock to make room for People').count()).toBeGreaterThan(0);
      }
      // within Setup: Appearance is Setup's own page, so it stays in Setup's tile
      await p.click(KEY('Inbox'));   // focus, so Setup isn't placed after a tile it came from
      await p.click(KEY('Setup'));
      await expect.poll(() => labels(p)).toContain('Setup');
      const n = (await labels(p)).length;
      await tile(p, 'Setup').locator('a, button', { hasText: 'Appearance' }).first().click();
      await expect.poll(() => new URL(p.url()).pathname).toBe('/appearance');
      expect((await labels(p)).length).toBe(n);
      await p.context().close();
    });

    it(`14. a reload restores the set: the pinned first, the focused, the dock, at ${w}×${hgt}`, async () => {
      const p = await screen(w, hgt, { path: '/comms?t=inbox!,*comms&m=setup' });
      await expect.poll(() => labels(p)).toEqual(['Inbox', 'Comms']);
      expect((await tiles(p)).find((t) => t.focused)?.label).toBe('Comms');
      expect(where(p)).toBe('/comms?t=inbox!,*comms&m=setup');
      await p.reload(); await p.locator('.loom-tile').first().waitFor();
      await expect.poll(() => labels(p)).toEqual(['Inbox', 'Comms']);
      expect(where(p)).toBe('/comms?t=inbox!,*comms&m=setup');
      // Setup comes back from the dock with its key (at 1280×800, Comms goes to the dock for it: Inbox is pinned)
      await p.click(KEY('Setup'));
      await expect.poll(() => labels(p)).toEqual(w >= 1920 ? ['Inbox', 'Comms', 'Setup'] : ['Inbox', 'Setup']);
      expect(query(p, 'm')).toBe(w >= 1920 ? null : 'comms');
      // an address with no set restores this device's last one, the address's page focused
      await p.goto(`${base}/people`); await p.locator('.loom-tile').first().waitFor();
      // (at 1280 the cap is 3: the least recently used that isn't pinned or focused, Comms, goes to the dock)
      await expect.poll(() => labels(p)).toContain('People');
      expect((await labels(p))[0]).toBe('Inbox');
      expect((await tiles(p)).find((t) => t.focused)?.label).toBe('People');
      await p.context().close();
    }, 60_000);
  }

  for (const [w, hgt] of [[1280, 800], [1920, 1080]]) it(`17. apps at ${w}×${hgt}: nothing overlaps, everything inside the desk, nothing sideways, DOM order is the order`, async () => {
    const p = await screen(w, hgt);
    const bars = await p.locator('.loom-top').evaluate((e) => e.getBoundingClientRect().bottom);
    const dock = await p.locator('.loom-dock-bar').evaluate((e) => e.getBoundingClientRect().top);
    for (const [n, label] of (['Inbox', 'Comms', 'People', 'Knowledge'] as const).entries()) {
      await p.click(KEY(label));
      await expect.poll(() => labels(p)).toContain(label);
      if (w >= 1920) expect(await p.locator('.loom-tile').count()).toBe(n + 1);
      const ts = await tiles(p);
      for (const t of ts) {
        expect(t.y, `${label}: under the bars`).toBeGreaterThanOrEqual(bars - 0.5);
        expect(t.y + t.h, `${label}: over the dock`).toBeLessThanOrEqual(dock + 0.5);
        expect(t.x).toBeGreaterThanOrEqual(0); expect(t.x + t.w).toBeLessThanOrEqual(w);
      }
      for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) {
        const [a, b] = [ts[i], ts[j]];
        expect(a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5, `${a.label}/${b.label}`).toBe(false);
      }
      expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const t = (query(p, 't') ?? '').split(',').map((x) => x.replace(/[*!]/g, ''));
      expect(ts.map((x) => x.label.toLowerCase())).toEqual(t);
    }
    await p.context().close();
  }, 60_000);

  it('20. a phone ignores the set; a desktop narrowed under 1024 draws the focused page as a phone does, and widened, tiles again', async () => {
    const phone = await screen(390, 844, { path: '/comms?t=inbox,*comms', touch: true });
    const assets: string[] = [];
    phone.on('request', (r) => assets.push(r.url()));
    await phone.reload(); await phone.locator('.loom-dock-bar [data-part="item"]').first().waitFor(); await phone.waitForTimeout(800);
    expect(await phone.locator('.loom-tile').count()).toBe(0);
    expect(new URL(phone.url()).pathname).toBe('/comms');
    expect(assets.filter((u) => /\/desk-[^/]*\.js/.test(u))).toEqual([]);
    await phone.context().close();
    const p = await screen(1280, 800);
    await open(p, 'Inbox', 1); await open(p, 'Comms', 2);
    await p.setViewportSize({ width: 900, height: 800 });
    await expect.poll(() => p.locator('.loom-tile').count()).toBe(0);
    expect(where(p)).toBe('/comms');
    await p.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(() => labels(p)).toEqual(['Inbox', 'Comms']);
    await p.context().close();
  }, 60_000);
  // Last: choosing in Appearance is the person's (kept by loom), so it would choose for every test after it.
  for (const [w, hgt] of [[1024, 768], [1280, 800], [1920, 1080]]) it(`18. One window at a time is the default; choosing Tiling in Appearance tiles at once, no reload, at ${w}×${hgt}`, async () => {
    const p = await screen(w, hgt, { tiling: false });
    await p.click(KEY('Inbox')); await p.locator('.loom-window').waitFor();
    await p.click(KEY('Setup')); await expect.poll(() => where(p)).toBe('/setup');
    expect(await p.locator('.loom-window').count()).toBe(1);
    expect(await p.locator('.loom-tile').count()).toBe(0);
    await p.goto(`${base}/appearance`); await p.locator('[aria-label="Desktop"]').waitFor();
    await p.locator('[aria-label="Desktop"] [role="radio"]', { hasText: 'Tiling' }).click();
    await expect.poll(() => p.locator('.loom-tile').count()).toBe(1);
    expect(await labels(p)).toEqual(['Setup']);
    expect(await p.locator('.loom-window').count()).toBe(0);
    await open(p, 'Inbox', 2);
    // and back: the focused tile's page is the window's again
    await p.click(KEY('Setup'));   // focus Setup first (its key focuses an open tile)
    await expect.poll(async () => (await tiles(p)).find((t) => t.focused)?.label).toBe('Setup');
    await p.locator('[aria-label="Desktop"] [role="radio"]', { hasText: 'One window at a time' }).click();
    await expect.poll(() => p.locator('.loom-window').count()).toBe(1);
    expect(await p.locator('.loom-tile').count()).toBe(0);
    expect(query(p, 't')).toBeNull();
    await p.context().close();
  }, 60_000);
});
