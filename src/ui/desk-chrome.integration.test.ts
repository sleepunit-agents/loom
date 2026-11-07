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
import { agentDir, createToken, loadHousehold, type Household } from '../household.js';
import { createConversationTables, recordTurn, writeDigest } from '../backends/conversations.js';
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
    const art = agentDir(h, 'art');
    const conv = recordTurn(art, 'art', { venue: 'wake', place: 'lane:making', label: 't-738: sonarr', at: new Date().toISOString(), from: { kind: 'schedule' }, kind: 'wake' }, 'runtime:clock').conversation;
    writeDigest(art, { conversation: conv, run: 'r1' }, { summary: 'Checked.', needs_owner: { ask: 'Can you check the Sonarr disk when you get a minute?', why: 'It is nearly full.', refs: ['t-738'] } } as never);
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

  // ---- B. tiles ----
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
    // a double-click on the name that's the way up still minimizes the tile, as on the rest of the strip
    const q = await screen(1280, 800, { path: `/comms/${thread}?t=*comms` });
    const up = q.locator('.loom-tile[data-tile="/comms"] .loom-tile__bar h2 a');
    await up.waitFor();
    await up.dblclick();
    await expect.poll(() => labels(q)).toEqual([]);
    expect(new URL(q.url()).searchParams.get('m')).toBe('comms');
    await q.context().close();
  });

  // (Setup is the launcher's now, not a tile, t-1925 G: People and a person's page stand for an app and its own page.)
  it('a page named otherwise keeps the app before it: People › a person', async () => {
    const p = await screen(1280, 800, { path: '/people?t=*people' });
    const t = p.locator('.loom-tile[data-tile="/people"]');
    await t.locator('a[href="/people/mark"]').first().click();
    await expect.poll(() => t.locator('.loom-tile__bar h2').textContent()).toMatch(/^mark$/i);
    expect(await t.locator('.loom-tile__crumb').textContent()).toBe('People');
    await p.context().close();
  });

  it('Recent here: not beside the only app tile (it gets the room), widgets or not; still beside a wide one sharing the screen', async () => {
    const p = await screen(1920, 1080, { path: '/people?t=*people&w=vitals' });
    const t = p.locator('.loom-tile[data-tile="/people"]');
    await t.locator('a[href="/people/mark"]').first().click();
    await expect.poll(() => t.locator('.loom-tile__bar h2').textContent()).toMatch(/^mark$/i);
    await t.locator('.loom-tile__btn[aria-label^="Back"]').click();
    await expect.poll(() => t.locator('.loom-tile__bar h2').textContent()).toMatch(/people/i);
    expect((await box(p, '.loom-tile')).width).toBeGreaterThan(1100);
    await p.waitForTimeout(300);
    expect(await t.locator('.loom-tile__side').count()).toBe(0);
    // the page has the tile's whole width
    const [body, page] = [await box(p, '.loom-tile__body'), await box(p, '.loom-tile__page')];
    expect(page.width).toBeGreaterThan(body.width - 40);
    await p.context().close();
    // 3000 px with two: the big tile is still wide, and shares the screen: Recent here is beside it
    const q = await screen(3000, 1440, { path: '/people?t=*people&w=' });
    const u = q.locator('.loom-tile[data-tile="/people"]');
    await u.locator('a[href="/people/mark"]').first().click();
    await expect.poll(() => u.locator('.loom-tile__bar h2').textContent()).toMatch(/^mark$/i);
    await u.locator('.loom-tile__btn[aria-label^="Back"]').click();
    await q.click(KEY('Inbox'));
    await expect.poll(() => labels(q)).toEqual(['People', 'Inbox']);
    expect((await box(q, '.loom-tile[data-tile="/people"]')).width).toBeGreaterThanOrEqual(1100);
    await expect.poll(() => u.locator('.loom-tile__side', { hasText: 'Recent here' }).count()).toBe(1);
    await q.context().close();
  });

  it('one loader: its three sizes in px, whatever the text around it (spinner.test.ts: the component and the built assets)', async () => {
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
    await p.context().close();
  });

  /** Every tile effect <html data-tile-fx> wore, and the loom-fx animations that ran under each. */
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
  async function tileMoves(p: Page) {
    const settle = () => p.waitForFunction(() => !document.documentElement.dataset.tileMove);
    await p.click(KEY('Inbox')); await expect.poll(() => labels(p)).toEqual(['Inbox']); await settle();
    await p.click(KEY('Comms')); await expect.poll(() => labels(p)).toEqual(['Inbox', 'Comms']); await settle();
    await p.locator('button[aria-label="Make Comms the big one"]').click(); await expect.poll(() => labels(p)).toEqual(['Comms', 'Inbox']); await settle();
    await p.locator('button[aria-label="Minimize Comms to the dock"]').click(); await expect.poll(() => labels(p)).toEqual(['Inbox']); await settle();
    await p.click(KEY('Comms')); await expect.poll(() => labels(p)).toContain('Comms'); await settle();
    await p.locator('button[aria-label="Close Comms"]').click(); await expect.poll(() => labels(p)).toEqual(['Inbox']); await settle();
  }

  it('each tile move has its own effect: open, make big, minimize, bring back, close', async () => {
    const p = await screen(1280, 800, { motion: 'no-preference', path: '/?w=needs' });
    await watchFx(p);
    await tileMoves(p);
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

  it('under reduced motion none of them run, and the tiles still open, move and close', async () => {
    const p = await screen(1280, 800, { motion: 'reduce', path: '/?w=needs' });
    await watchFx(p);
    await tileMoves(p);
    expect(await fxSeen(p)).toEqual({ fx: [], anims: [] });
    await p.context().close();
  });

  // ---- E. right-click ----
  const menu = (p: Page) => p.locator('[role="menu"].loom-cmenu');
  const items = (p: Page) => menu(p).locator('[role="menuitem"]').evaluateAll((es) => es.map((e) => e.querySelector('span')!.textContent));
  const focused = (p: Page) => p.evaluate(() => document.activeElement?.textContent ?? '');

  it('the dock has no + key; a right-click on the desktop\'s ground adds a widget', async () => {
    const p = await screen(1280, 800, { path: '/?w=needs' });
    expect(await p.locator(KEY('Add a widget')).count()).toBe(0);
    await p.locator('.loom-desk-col--right').click({ button: 'right', position: { x: 40, y: 200 } });
    await menu(p).waitFor();
    expect(await menu(p).getAttribute('aria-label')).toBe('Add a widget');
    expect(await items(p)).toEqual(['Needs you', 'art’s card', 'mark’s card', 'Vitals', 'Backup']);
    expect(await menu(p).locator('[role="menuitem"]', { hasText: 'Needs you' }).textContent()).toMatch(/on the desktop/);
    await menu(p).locator('[role="menuitem"]', { hasText: 'Vitals' }).click();
    await expect.poll(() => widgets(p)).toEqual(['needs', 'vitals']);
    expect(await menu(p).count()).toBe(0);
    // on a tile's page, and on a link in it, the browser's own menu: none of ours, and nothing stops the browser's
    await p.goto(`${base}/people?t=*people&w=needs,vitals`); await expect.poll(() => labels(p)).toEqual(['People']);
    await p.locator('.loom-tile__body').click({ button: 'right', position: { x: 300, y: 300 } });
    expect(await menu(p).count()).toBe(0);
    const native = (sel: string) => p.locator(sel).first().evaluate((el) => {
      const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    });
    expect(await native('.loom-tile__page')).toBe(false);
    // a link in a page (one put there, so there surely is one)
    await p.locator('.loom-tile__page').evaluate((pg) => { const l = document.createElement('a'); l.href = '/people'; l.textContent = 'People'; l.id = 'a-link'; pg.prepend(l); });
    expect(await native('#a-link')).toBe(false);
    expect(await native('.loom-tile__page button')).toBe(false);
    // and the desktop's ground is ours
    await p.click(KEY('Home'));
    await expect.poll(() => labels(p)).toEqual([]);
    expect(await native('.loom-desk-col--right')).toBe(true);
    await p.keyboard.press('Escape');
    await p.context().close();
  });

  it('from the keyboard: Shift+F10 on the desktop opens it; arrows move, Enter chooses, Esc closes, Tab never stays', async () => {
    const p = await screen(1280, 800, { path: '/?w=needs' });
    await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await p.keyboard.press('Shift+F10');
    await menu(p).waitFor();
    expect(await focused(p)).toMatch(/^Needs you/);
    await p.keyboard.press('ArrowDown');
    expect(await focused(p)).toMatch(/^art/);
    await p.keyboard.press('End');
    expect(await focused(p)).toMatch(/^Backup/);
    await p.keyboard.press('ArrowDown');   // round to the top
    expect(await focused(p)).toMatch(/^Needs you/);
    await p.keyboard.press('ArrowUp');   // and round to the bottom
    expect(await focused(p)).toMatch(/^Backup/);
    await p.keyboard.press('Home');
    expect(await focused(p)).toMatch(/^Needs you/);
    await p.keyboard.press('Escape');
    expect(await menu(p).count()).toBe(0);
    // Tab: the menu closes, focus moves on
    await p.keyboard.press('Shift+F10');
    await menu(p).waitFor();
    await p.keyboard.press('Tab');
    expect(await menu(p).count()).toBe(0);
    // Enter chooses
    await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await p.keyboard.press('Shift+F10');
    await menu(p).waitFor();
    await p.keyboard.press('End'); await p.keyboard.press('ArrowUp');   // Vitals
    await p.keyboard.press('Enter');
    await expect.poll(() => widgets(p)).toEqual(['needs', 'vitals']);
    // Space chooses too
    await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await p.keyboard.press('Shift+F10');
    await menu(p).waitFor();
    await p.keyboard.press('End');   // Backup
    await p.keyboard.press(' ');
    await expect.poll(() => widgets(p)).toEqual(['needs', 'vitals', 'backup']);
    // the Menu key on a focused dock key: the dock key's menu, at it
    await p.locator(KEY('Inbox')).focus();
    await p.keyboard.press('ContextMenu');
    await menu(p).waitFor();
    expect(await menu(p).getAttribute('aria-label')).toBe('Inbox');
    await p.keyboard.press('Escape');
    await expect.poll(() => p.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Inbox');
    await p.context().close();
  });

  it('a tile\'s strip: Minimize, Make it the big one, Close', async () => {
    const p = await screen(1280, 800, { path: '/inbox?t=*inbox,comms&w=' });
    await expect.poll(() => labels(p)).toEqual(['Inbox', 'Comms']);
    await p.locator('.loom-tile[data-tile="/comms"] .loom-tile__bar h2').click({ button: 'right' });
    await menu(p).waitFor();
    expect(await items(p)).toEqual(['Minimize', 'Make it the big one', 'Close']);
    await menu(p).locator('[role="menuitem"]', { hasText: 'Make it the big one' }).click();
    await expect.poll(() => labels(p)).toEqual(['Comms', 'Inbox']);
    await p.locator('.loom-tile[data-tile="/comms"] .loom-tile__bar').click({ button: 'right', position: { x: 300, y: 10 } });
    expect(await items(p)).toEqual(['Minimize', 'Close']);
    await menu(p).locator('[role="menuitem"]', { hasText: 'Minimize' }).click();
    await expect.poll(() => labels(p)).toEqual(['Inbox']);
    expect(new URL(p.url()).searchParams.get('m')).toBe('comms');
    // an agent's tile: its card, pinned and taken off from the strip
    await p.click(KEY('Inbox')); await expect.poll(() => labels(p)).toEqual([]);
    await p.goto(`${base}/a/art?t=*art&w=`);
    await expect.poll(() => labels(p)).toEqual(['art']);
    const strip = p.locator('.loom-tile[data-tile="/a/art"] .loom-tile__bar h2');
    await strip.click({ button: 'right' });
    expect(await items(p)).toEqual(['Minimize', 'Pin its card to the desktop', 'Close']);
    await menu(p).locator('[role="menuitem"]', { hasText: 'Pin' }).click();
    await expect.poll(() => widgets(p)).toEqual(['art']);
    await strip.click({ button: 'right' });
    expect(await items(p)).toEqual(['Minimize', 'Take its card off the desktop', 'Close']);
    await menu(p).locator('[role="menuitem"]', { hasText: 'Take' }).click();
    await expect.poll(() => widgets(p)).toEqual([]);
    await p.context().close();
  });

  it('an agent\'s card: Chat, Open, Unpin', async () => {
    const p = await screen(1280, 800, { path: '/?w=art,needs' });
    await p.locator('[data-widget="art"]').click({ button: 'right', position: { x: 60, y: 60 } });
    await menu(p).waitFor();
    expect(await items(p)).toEqual(['Chat', 'Open', 'Unpin from the desktop']);
    await menu(p).locator('[role="menuitem"]', { hasText: 'Open' }).click();
    await expect.poll(() => labels(p)).toEqual(['art']);
    await p.locator('[data-widget="art"]').click({ button: 'right', position: { x: 40, y: 40 } });
    await menu(p).locator('[role="menuitem"]', { hasText: 'Unpin' }).click();
    await expect.poll(() => widgets(p)).toEqual(['needs']);
    await p.context().close();
  });

  it('a dock key: Open, Minimize, Close', async () => {
    const p = await screen(1280, 800, { path: '/?w=needs' });
    await p.locator(KEY('Comms')).click({ button: 'right' });
    await menu(p).waitFor();
    expect(await items(p)).toEqual(['Open']);
    await menu(p).locator('[role="menuitem"]').click();
    await expect.poll(() => labels(p)).toEqual(['Comms']);
    await p.locator(KEY('Comms')).click({ button: 'right' });
    expect(await items(p)).toEqual(['Open', 'Minimize', 'Close']);
    await menu(p).locator('[role="menuitem"]', { hasText: 'Minimize' }).click();
    await expect.poll(() => labels(p)).toEqual([]);
    await p.locator(KEY('Comms')).click({ button: 'right' });
    expect(await items(p)).toEqual(['Open', 'Close']);
    await menu(p).locator('[role="menuitem"]', { hasText: 'Close' }).click();
    await expect.poll(() => new URL(p.url()).searchParams.get('m')).toBeNull();
    // Home, All apps (the launcher) and your own key, where the dock has it, have none of ours
    for (const sel of [KEY('Home'), KEY('All apps'), '.loom-dock-bar [data-part="item"][data-value="/account"]']) {
      if (!(await p.locator(sel).count())) continue;
      await p.locator(sel).click({ button: 'right' });
      expect(await menu(p).count(), sel).toBe(0);
    }
    await p.context().close();
  });

  it('an Inbox row: Open (in the reader), Mark done (once loom says it\'s open), never over an unsent reply', async () => {
    // its own ask, so nothing an earlier test pressed can have answered it
    const art = agentDir(h, 'art');
    const conv = recordTurn(art, 'art', { venue: 'wake', place: 'lane:making', label: 't-739: drive', at: new Date().toISOString(), from: { kind: 'schedule' }, kind: 'wake' }, 'runtime:clock').conversation;
    writeDigest(art, { conversation: conv, run: 'r2' }, { summary: 'Checked.', needs_owner: { ask: 'Can you swap the Sonarr disk for the spare this week?', why: 'It is nearly full.', refs: ['t-739'] } } as never);
    const p = await screen(1280, 800, { path: '/inbox?t=*inbox&w=' });
    const row = p.locator('.loom-tile button[data-row-menu]', { hasText: 'swap the Sonarr disk' });
    // what the tile shows, should the row not come (said in the failure)
    await row.waitFor({ timeout: 20_000 }).catch(async (e: Error) => {
      const what = await p.evaluate(() => ({ text: document.querySelector('.loom-tile')?.textContent?.slice(0, 600), rows: [...document.querySelectorAll('.loom-tile button')].map((b) => `${b.getAttribute('data-row-menu') ?? '-'}:${b.textContent?.slice(0, 50)}`).slice(0, 20) }));
      throw new Error(`${e.message}\n${JSON.stringify(what)}`);
    });
    // a reply typed and not sent: Open only (the sheet's Done sends it first), never Mark done
    const key = await p.evaluate(async () => ((await (await fetch('/inbox', { headers: { accept: 'application/json' } })).json()) as { items: { key: string; text: string }[] })
      .items.find((i) => /swap the Sonarr disk/.test(i.text))!.key);
    await p.evaluate((k) => localStorage.setItem(`loom.draft.${k}`, 'On it tonight'), key);
    await p.reload(); await row.waitFor();
    await row.click({ button: 'right' });
    await menu(p).waitFor();
    expect(await items(p)).toEqual(['Open']);
    await p.keyboard.press('Escape');
    await p.evaluate((k) => localStorage.removeItem(`loom.draft.${k}`), key);
    await p.reload(); await row.waitFor();
    await row.click({ button: 'right' });
    await menu(p).waitFor();
    expect(await items(p)).toEqual(['Open', 'Mark done']);
    // (another item first in the reader, so Open is seen to pick this one)
    await menu(p).locator('[role="menuitem"]', { hasText: 'Open' }).click();
    await expect.poll(() => row.getAttribute('aria-current')).toBe('true');
    await expect.poll(() => p.locator('.loom-tile .loom-inbox__read h2').textContent()).toMatch(/swap the Sonarr disk/);
    const posted: string[] = [];
    p.on('request', (r) => { if (r.method() === 'POST') posted.push(new URL(r.url()).pathname + ' ' + (r.postData() ?? '')); });
    await row.click({ button: 'right' });
    await menu(p).locator('[role="menuitem"]', { hasText: 'Mark done' }).click();
    await expect.poll(() => posted.some((x) => /needs-done/.test(x))).toBe(true);
    await expect.poll(() => p.locator('.loom-tile button[data-row-menu]', { hasText: 'swap the Sonarr disk' }).count()).toBe(0);
    await p.context().close();
  });

  it('no page errors on the way', () => { expect(errors).toEqual([]); });
});
