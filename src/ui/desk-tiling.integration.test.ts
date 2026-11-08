/**
 * Desk tiling, phase 3 (docs/specs/desk-tiling.md, criteria 10, 11, 12, 14, 17 for apps, and 20's phone half):
 * apps share a big screen as tiles, each with its own page and history; the dock opens, focuses, minimizes and brings
 * back; the address carries the set and a reload restores it. (Criterion 18, tiling the only desktop and One window at
 * a time: desk-tiling-only.integration.test.ts.) The apps are ones every household has (Inbox, Comms, Setup, Places, People, Knowledge): the
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

  /** A screen this size, signed in. */
  async function screen(width: number, height: number, o: { path?: string; touch?: boolean } = {}): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', serviceWorkers: 'block', hasTouch: !!o.touch, isMobile: !!o.touch });
    await ctx.addInitScript(`localStorage.setItem('loom-look', 'neon'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    await p.goto(`${base}${o.path ?? '/'}`);
    await p.locator('.loom-dock-bar [data-part="item"]').first().waitFor();
    // Tiled once the desk's chunk is here (its tile desk drawn); else the page as it was.
    if (width >= 1024) await p.locator('.loom-tiles').waitFor();
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
  /** An app with no dock key, from the launcher (t-1925 G): its search, then Enter. */
  const launch = async (p: Page, name: string) => {
    await p.click(KEY('All apps')); await p.locator('.loom-launcher').waitFor();
    await p.keyboard.type(name); await p.keyboard.press('Enter');
    await expect.poll(() => p.locator('.loom-launcher').count()).toBe(0);
  };

  for (const [w, hgt] of [[1024, 768], [1280, 800], [1920, 1080]]) {
    it(`10. open, focus, minimize and back, at ${w}×${hgt}`, async () => {
      const p = await screen(w, hgt);
      expect(await p.locator('.loom-adesk').count()).toBe(1);
      await open(p, 'Inbox', 1);
      await open(p, 'Comms', 2);
      expect(query(p, 't')).toBe('inbox,*comms');
      expect((await tiles(p)).map((t) => [t.label, t.focused])).toEqual([['Inbox', false], ['Comms', true]]);
      // its key again: minimized
      await p.click(KEY('Comms')); await expect.poll(() => p.locator('.loom-tile').count()).toBe(1);
      expect([query(p, 't'), query(p, 'm')]).toEqual(['*inbox', 'comms']);
      // and back, on the page it was on
      await open(p, 'Comms', 2);
      expect(where(p)).toBe('/comms?t=inbox,*comms');
      // a page scrolled down comes back scrolled where it was: Appearance (the launcher's), in a short screen
      await launch(p, 'Appearance'); await expect.poll(() => p.locator('.loom-tile').count()).toBeGreaterThanOrEqual(2);
      const setup = tile(p, 'Appearance');
      await expect.poll(() => where(p)).toMatch(/^\/appearance\?/);
      await setup.locator('[aria-label="Look"]').waitFor();
      // a short screen, so Appearance scrolls in its tile
      await p.setViewportSize({ width: w, height: 560 });
      const body = setup.locator('.loom-tile__body');
      await expect.poll(() => body.evaluate((b) => b.scrollHeight - b.clientHeight)).toBeGreaterThan(100);
      const top = await body.evaluate((b) => { b.scrollTop = 100; return b.scrollTop; });
      expect(top).toBe(100);
      await setup.locator('button[aria-label="Minimize Appearance to the dock"]').click(); await expect.poll(() => tile(p, 'Appearance').count()).toBe(0);
      await launch(p, 'Appearance'); await tile(p, 'Appearance').locator('[aria-label="Look"]').waitFor();
      expect(new URL(p.url()).pathname).toBe('/appearance');
      await expect.poll(() => tile(p, 'Appearance').locator('.loom-tile__body').evaluate((b) => b.scrollTop)).toBe(top);
      await p.context().close();
    }, 60_000);
  }

  for (const [w, hgt] of [[1024, 768], [1280, 800], [1920, 1080]]) {
    it(`11. history per tile, and the browser's Back, at ${w}×${hgt}`, async () => {
      const p = await screen(w, hgt);
      const before = await p.evaluate(() => history.length);
      await open(p, 'Activity', 1);
      await open(p, 'Inbox', 2);
      // opening adds no browser history; closing neither
      expect(await p.evaluate(() => history.length)).toBe(before);
      await tile(p, 'Inbox').locator('button[aria-label="Close Inbox"]').click();
      await expect.poll(() => p.locator('.loom-tile').count()).toBe(1);
      expect(await p.evaluate(() => history.length)).toBe(before);
      await p.click(KEY('People')); await expect.poll(() => labels(p)).toEqual(['Activity', 'People']);
      // a page change in each tile: People to a person, Activity to Mark's; then Activity's own Back: only Activity moves
      await tile(p, 'People').locator('main a[href^="/people/"], a[href^="/people/"]').first().click();
      await expect.poll(() => new URL(p.url()).pathname).toMatch(/^\/people\/./);
      const person = new URL(p.url()).pathname;
      const setup = tile(p, 'Activity');
      await setup.locator('[aria-label="Filter"] button, [aria-label="Filter"] [role="radio"]', { hasText: 'mark' }).first().click();
      await expect.poll(() => query(p, 'who')).toBe('mark');
      expect(await p.evaluate(() => history.length)).toBe(before + 2);
      await setup.locator('.loom-tile__btn[aria-label^="Back"]').click();
      await expect.poll(() => [new URL(p.url()).pathname, query(p, 'who')]).toEqual(['/activity', null]);
      // People stayed on its person
      expect(await tile(p, 'People').locator('.loom-tile__path').textContent()).toBe(`loom${person}`);
      // the browser's Back and Forward walk the focused tile's history
      await setup.locator('[aria-label="Filter"] button, [aria-label="Filter"] [role="radio"]', { hasText: 'art' }).first().click();
      await expect.poll(() => query(p, 'who')).toBe('art');
      await p.goBack();
      await expect.poll(() => [new URL(p.url()).pathname, query(p, 'who')]).toEqual(['/activity', null]);
      expect(await p.locator('.loom-tile').count()).toBe(2);
      // what the browser's Back landed on is the tile's page now: minimized and back, it's Activity's start, not Art's
      await p.click(KEY('Activity')); await expect.poll(() => tile(p, 'Activity').count()).toBe(0);
      expect(query(p, 'm')).toBe('activity');
      await p.click(KEY('Activity')); await tile(p, 'Activity').waitFor();
      await expect.poll(() => [new URL(p.url()).pathname, query(p, 'who')]).toEqual(['/activity', null]);
      await p.context().close();
    }, 60_000);
  }

  // 776, not 800: the desktop's one bar (2026-11-06) gave the tiles 24 px more, and at 800 three now fit.
  for (const [w, hgt] of [[1280, 776], [1920, 1080]]) {
    it(`12. a link to another app opens it right after its tile; one within the app stays, at ${w}×${hgt}`, async () => {
      // A person's page links to their agent's: another app.
      const p = await screen(w, hgt, { path: '/people?t=*people' });
      await expect.poll(() => labels(p)).toEqual(['People']);
      await open(p, 'Inbox', 2);
      expect(await labels(p)).toEqual(['People', 'Inbox']);
      // within People: a person is People's own page, so it stays in People's tile
      await tile(p, 'People').locator('a[href="/people/art"]').first().click();
      await expect.poll(() => new URL(p.url()).pathname).toBe('/people/art');
      expect(await labels(p)).toEqual(['People', 'Inbox']);
      await tile(p, 'People').locator('a[href="/a/art"]').first().click();
      // At 1280×776 three of these don't fit: the one used least recently that isn't the one opened or the one it came
      // from, the Inbox, goes to the dock, and a toast says so.
      if (w >= 1920) {
        await expect.poll(() => labels(p)).toEqual(['People', 'art', 'Inbox']);
        expect(query(p, 't')).toBe('people,*art,inbox');
      } else {
        await expect.poll(() => labels(p)).toEqual(['People', 'art']);
        expect([query(p, 't'), query(p, 'm')]).toEqual(['people,*art', 'inbox']);
        await expect.poll(() => p.getByText('Inbox went to the dock to make room for art').count()).toBeGreaterThan(0);
      }
      await p.context().close();
    });

    it(`14. a reload restores the set: the pinned first, the focused, the dock, at ${w}×${hgt}`, async () => {
      const p = await screen(w, hgt, { path: '/comms?t=inbox!,*comms&m=people' });
      await expect.poll(() => labels(p)).toEqual(['Inbox', 'Comms']);
      expect((await tiles(p)).find((t) => t.focused)?.label).toBe('Comms');
      expect(where(p)).toBe('/comms?t=inbox!,*comms&m=people');
      await p.reload(); await p.locator('.loom-tile').first().waitFor();
      await expect.poll(() => labels(p)).toEqual(['Inbox', 'Comms']);
      expect(where(p)).toBe('/comms?t=inbox!,*comms&m=people');
      // People comes back from the dock with its key (at 1280×800, Comms goes to the dock for it: Inbox is pinned)
      await p.click(KEY('People'));
      await expect.poll(() => labels(p)).toEqual(w >= 1920 ? ['Inbox', 'Comms', 'People'] : ['Inbox', 'People']);
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
    // The desk's own chunk: never on a phone (the small shared ones, desk-rail and the agent cards, may come).
    expect(assets.filter((u) => /\/desk-(?!rail-|agents-)[^/]*\.js/.test(u))).toEqual([]);
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
});
