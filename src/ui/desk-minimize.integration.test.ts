/**
 * The desktop's windows minimize, like a real OS (Jonathan, 2026-11-05): clicking the open app's dock key, or
 * double-clicking its window's title strip, shrinks the window back into its key and shows the desktop; clicking that
 * key again opens the app where it was left (the same page and query, and its scroll). A different app's key still
 * switches to it; Home always goes to the desktop; Close forgets. And the dock itself: a key never stays magnified
 * once the pointer isn't over it (after a click that navigates, a minimize, or a tap), and the first and last keys,
 * grown, keep their glow whole: nothing that clips cuts it, at 1280 px and at a phone's width. Real Chrome, Neon Noir;
 * the phone's own layout is unchanged.
 *
 * Runs where the app is built (npm run build) and a Chrome is installed (GitHub's runners have one).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

const KEY = (label: string) => `.loom-dock-bar [data-part="item"][aria-label="${label}"]`;

/** A key's visual and its glow (its outer box-shadows' reach, scaled with it), and whatever that clips either. */
function glowCut(el: Element): { scale: number; reach: number; cut: string[] } {
  const vis = el.querySelector<HTMLElement>('[data-part="visual"]')!;
  const v = vis.getBoundingClientRect();
  const scale = v.width / vis.offsetWidth;
  // Each outer shadow: "color x y blur spread" (Chrome's computed form); an inset one is drawn inside.
  let reach = 0;
  for (const s of getComputedStyle(vis).boxShadow.split(/,(?![^(]*\))/)) {
    if (/inset/.test(s) || s.trim() === 'none') continue;
    const n = (s.match(/-?[\d.]+px/g) ?? []).map(parseFloat);
    if (n.length >= 3) reach = Math.max(reach, Math.max(Math.abs(n[0]), Math.abs(n[1])) + n[2] + (n[3] ?? 0));
  }
  reach *= scale;
  const g = { left: v.left - reach, right: v.right + reach, top: v.top - reach, bottom: v.bottom + reach };
  const cut: string[] = [];
  const inside = (r: { left: number; right: number; top: number; bottom: number }, c: DOMRect) =>
    r.left >= c.left - 0.5 && r.right <= c.right + 0.5 && r.top >= c.top - 0.5 && r.bottom <= c.bottom + 0.5;
  for (let a = el.parentElement; a; a = a.parentElement) {
    const cs = getComputedStyle(a);
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || cs.clipPath !== 'none') {
      const c = a.getBoundingClientRect(), what = a.getAttribute('data-part') ?? a.className.toString().slice(0, 40);
      if (!inside(v, c)) cut.push(`the key, by ${what}`);
      // Sideways: the glow's own sides (its top is the #519 room's, and its bottom sits on the screen's edge).
      if (g.left < c.left - 0.5 || g.right > c.right + 0.5) cut.push(`its glow, sideways, by ${what}`);
    }
    if (cs.position === 'fixed') break;
  }
  // And on the screen.
  if (g.left < -0.5 || g.right > innerWidth + 0.5) cut.push('its glow, by the screen');
  return { scale, reach, cut };
}

describe.runIf(built && chrome)('the desktop\'s windows minimize, and the dock lets go', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-desk-min-'));
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

  async function screen(width: number, o: { motion?: 'reduce' | 'no-preference'; touch?: boolean; path?: string } = {}): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: !!o.touch, isMobile: !!o.touch, reducedMotion: o.motion ?? 'no-preference', serviceWorkers: 'block' });
    await ctx.addInitScript(() => { localStorage.setItem('loom-look', 'neon'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1'); });
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    await p.goto(`${base}${o.path ?? '/'}`);
    await p.locator('.loom-dock-bar [data-part="item"]').first().waitFor();
    await p.waitForTimeout(500);
    return p;
  }
  const where = (p: Page) => { const u = new URL(p.url()); return u.pathname + u.search; };
  const onDesktop = async (p: Page) => { await p.locator('.loom-desk-home').waitFor(); await expect.poll(() => p.locator('.loom-window').count()).toBe(0); expect(new URL(p.url()).pathname).toBe('/'); };
  /** The window's page, scrolled this far down (as far as it goes, if it's shorter). */
  const scrollTo = (p: Page, top: number) => p.locator('.loom-window main').evaluate((m, t) => { m.scrollTop = t; return m.scrollTop; }, top);
  const scrolled = (p: Page) => p.locator('.loom-window main').evaluate((m) => m.scrollTop);
  /** A key at rest: drawn at its own size, not engaged. */
  const atRest = (p: Page, label: string) => p.locator(KEY(label)).evaluate((el) => {
    const v = el.querySelector('[data-part="visual"]')!.getBoundingClientRect();
    return { ratio: Math.round((v.height / el.getBoundingClientRect().height) * 100) / 100, engaged: el.closest('[data-part="lane"]')!.hasAttribute('data-engaged') };
  });
  const away = async (p: Page) => { await p.mouse.move(640, 300); await p.waitForTimeout(450); };

  it('clicking the open app\'s key minimizes it to the desktop; clicking it again opens it where it was, page, query and scroll', async () => {
    const p = await screen(1280, { path: '/appearance?from=minimize' });
    await p.locator('.loom-window main').waitFor();
    await p.locator('.loom-window main > *').first().waitFor();
    const top = await scrollTo(p, 240);
    const moves: string[] = [];
    await p.exposeFunction('noteMove', (m: string) => moves.push(m));
    await p.evaluate(() => new MutationObserver(() => { const m = document.documentElement.dataset.deskMove; if (m) (window as unknown as { noteMove: (m: string) => void }).noteMove(m); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-desk-move'] }));
    // The Setup key is the open app's (Appearance is in Setup).
    expect(await p.locator(KEY('Setup')).getAttribute('aria-pressed')).toBe('true');
    await p.locator(KEY('Setup')).click();
    await onDesktop(p);
    await expect.poll(() => moves).toEqual(['close']);   // the window shrinks back into its key, as Close's does
    await p.locator(KEY('Setup')).click();
    await p.locator('.loom-window main > *').first().waitFor();
    expect(where(p)).toBe('/appearance?from=minimize');
    await expect.poll(() => scrolled(p)).toBe(top);
    // Again, from a page with no scroll of its own: it comes back at its top.
    await scrollTo(p, 0);
    await p.locator(KEY('Setup')).click();
    await onDesktop(p);
    await p.locator(KEY('Setup')).click();
    await expect.poll(() => where(p)).toBe('/appearance?from=minimize');
    expect(await scrolled(p)).toBe(0);
    await p.context().close();
  }, 90_000);

  it('a different app\'s key switches to it; Home goes to the desktop; Close forgets where the app was', async () => {
    const p = await screen(1280, { path: '/appearance?from=switch' });
    await p.locator('.loom-window main > *').first().waitFor();
    // Another app's key: that app, at its own root, as before.
    await p.locator(KEY('Inbox')).click();
    await expect.poll(() => where(p)).toBe('/inbox');
    expect(await p.locator('.loom-window').count()).toBe(1);
    // Home: the desktop, always.
    await p.locator(KEY('Home')).click();
    await onDesktop(p);
    await p.locator(KEY('Home')).click();
    await p.waitForTimeout(300);
    await onDesktop(p);
    // Minimized, then closed: Close forgets it, so its key opens the app's root.
    await p.goto(`${base}/appearance?from=close`);
    await p.locator('.loom-window main > *').first().waitFor();
    await p.locator(KEY('Setup')).click();
    await onDesktop(p);
    await p.locator(KEY('Setup')).click();
    await expect.poll(() => where(p)).toBe('/appearance?from=close');
    await p.getByRole('button', { name: /^Close, back to the desktop/ }).click();
    await onDesktop(p);
    await p.locator(KEY('Setup')).click();
    await expect.poll(() => where(p)).toBe('/setup');
    await p.context().close();
  }, 90_000);

  it('double-clicking the window\'s title strip minimizes it; double-clicking its Close doesn\'t', async () => {
    const p = await screen(1280, { path: '/appearance?from=strip' });
    await p.locator('.loom-window main > *').first().waitFor();
    // A double-click that lands on Close alone (no clicks before it): the window stays.
    await p.locator('.loom-window__close').dispatchEvent('dblclick');
    await p.waitForTimeout(400);
    expect(await p.locator('.loom-window').count()).toBe(1);
    expect(where(p)).toBe('/appearance?from=strip');
    // The strip itself, by its title and by its empty middle.
    for (const at of ['#loom-window-title', '.loom-window__path']) {
      await p.locator(at).dblclick();
      await onDesktop(p);
      await p.locator(KEY('Setup')).click();
      await expect.poll(() => where(p), at).toBe('/appearance?from=strip');
      await p.locator('.loom-window main > *').first().waitFor();
    }
    // A real double-click on Close: its first click closes (Close is Close), and closed is forgotten, not minimized.
    await p.locator('.loom-window__close').dblclick();
    await onDesktop(p);
    await p.locator(KEY('Setup')).click();
    await expect.poll(() => where(p)).toBe('/setup');
    await p.context().close();
  }, 90_000);

  it('under reduced motion a minimize still happens, with no shrink', async () => {
    const p = await screen(1280, { motion: 'reduce', path: '/appearance?from=still' });
    await p.locator('.loom-window main > *').first().waitFor();
    await p.evaluate(() => { const w = window as unknown as { moves: number }; w.moves = 0;
      new MutationObserver(() => { if (document.documentElement.dataset.deskMove) w.moves++; }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-desk-move'] }); });
    await p.locator(KEY('Setup')).click();
    await onDesktop(p);
    await p.locator(KEY('Setup')).click();
    await expect.poll(() => where(p)).toBe('/appearance?from=still');
    await p.locator('#loom-window-title').dblclick();
    await onDesktop(p);
    expect(await p.evaluate(() => (window as unknown as { moves: number }).moves)).toBe(0);
    await p.context().close();
  }, 60_000);

  it('a key lets go of its magnification once the pointer leaves it: after a click that opens an app, and after a minimize', async () => {
    const p = await screen(1280);
    await p.locator('.loom-desk-home').waitFor();
    const key = p.locator(KEY('Inbox'));
    // Open it from its key, then the pointer goes away.
    await key.click();
    await p.locator('.loom-window').waitFor();
    await away(p);
    await expect.poll(() => atRest(p, 'Inbox')).toEqual({ ratio: 1, engaged: false });
    // Minimize from the same key, and away (focus goes back to the key the window shrank into: that isn't hover).
    await key.click();
    await onDesktop(p);
    await away(p);
    await expect.poll(() => atRest(p, 'Inbox')).toEqual({ ratio: 1, engaged: false });
    // Close, by the mouse, does the same (it stayed grown here before: 1.65x and engaged, the pointer far away).
    await key.click();
    await p.locator('.loom-window').waitFor();
    await p.getByRole('button', { name: /^Close, back to the desktop/ }).click();
    await onDesktop(p);
    await expect.poll(() => p.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Inbox');
    await away(p);
    await expect.poll(() => atRest(p, 'Inbox')).toEqual({ ratio: 1, engaged: false });
    // While the pointer is on it, it's grown; off it, it isn't.
    const b = (await key.boundingBox())!;
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await expect.poll(async () => (await atRest(p, 'Inbox')).ratio).toBeGreaterThan(1.6);
    await away(p);
    await expect.poll(() => atRest(p, 'Inbox')).toEqual({ ratio: 1, engaged: false });
    // A keyboard user still sees the key they're on: focus from the keyboard grows it.
    await key.focus(); await p.keyboard.press('ArrowRight'); await p.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await atRest(p, 'Inbox')).engaged).toBe(true);
    await p.context().close();
  }, 60_000);

  it('a tap leaves no key magnified or engaged', async () => {
    const p = await screen(1280, { touch: true });
    await p.locator('.loom-desk-home').waitFor();
    await p.locator(KEY('Inbox')).tap();
    await p.locator('.loom-window').waitFor();
    await p.waitForTimeout(450);
    await expect.poll(() => atRest(p, 'Inbox')).toEqual({ ratio: 1, engaged: false });
    await p.context().close();
  }, 60_000);



  for (const width of [1280, 390]) {
    it(`${width} px: the first and last keys, grown under the pointer, keep their glow whole`, async () => {
      const p = await screen(width);
      const items = p.locator('.loom-dock-bar [data-part="item"]');
      const n = await items.count();
      for (const i of [0, n - 1]) {
        const item = items.nth(i);
        const b = (await item.boundingBox())!;
        await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
        await expect.poll(() => item.evaluate((el) => el.querySelector('[data-part="visual"]')!.getBoundingClientRect().height / el.getBoundingClientRect().height), { timeout: 4000 }).toBeGreaterThan(1.6);
        await p.waitForTimeout(300);
        const seen = await item.evaluate(glowCut);
        expect(seen.reach, `key ${i} has a glow to keep`).toBeGreaterThan(0);
        // At a phone's width with a mouse the first key's grown glow can pass the screen's own edge (the dock sits 36 px
        // in, as a phone's does): nothing of the page clips it, and that's what's checked there.
        expect(seen.cut.filter((c) => width > 390 || c !== 'its glow, by the screen'), `${width} px, key ${i}`).toEqual([]);
      }
      await p.context().close();
    }, 60_000);
  }

  it('a phone (a finger): nothing grows, and the first and last keys\' glow is whole, on the screen too', async () => {
    const p = await screen(390, { touch: true });
    const items = p.locator('.loom-dock-bar [data-part="item"]');
    const n = await items.count();
    for (const i of [0, n - 1]) {
      const seen = await items.nth(i).evaluate(glowCut);
      expect(seen.scale, `key ${i}`).toBe(1);
      expect(seen.cut, `390 px touch, key ${i}`).toEqual([]);
    }
    await p.context().close();
  }, 60_000);

  /** Anything scrollbar-like the dock shows: a scroll area's own bar or thumb drawn at a size, or a native bar. */
  const bars = (p: Page) => p.evaluate(() => {
    const seen: string[] = [];
    for (const dock of document.querySelectorAll('.loom-dock-bar [data-slot="dock"]')) {
      if (dock.closest('.loom-dock-gone')) continue;
      for (const e of dock.querySelectorAll<HTMLElement>('[data-slot="scroll-area-scrollbar"], [data-slot="scroll-area-thumb"], .v-scroll__grip')) {
        const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
        if (r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && +cs.opacity > 0) seen.push(`${e.dataset.slot ?? e.className} ${e.dataset.orientation ?? ''} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
      const vp = dock.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!, cs = getComputedStyle(vp);
      if (cs.overflowY !== 'hidden') seen.push(`the viewport scrolls up and down (${cs.overflowY})`);
      if (cs.scrollbarWidth !== 'none') seen.push(`a native bar (${cs.scrollbarWidth})`);
    }
    return seen;
  });

  for (const width of [1280, 1855, 1920]) {
    it(`${width} px: the dock never shows a scrollbar, after loading, hovering, a minimize or an agent's dock`, async () => {
      const p = await screen(width);
      await p.locator('.loom-desk-home').waitFor();
      await p.waitForTimeout(3000);
      expect(await bars(p), 'after load').toEqual([]);
      const items = p.locator('.loom-dock-bar [data-part="item"]');
      for (const i of [0, (await items.count()) - 1]) {
        const b = (await items.nth(i).boundingBox())!;
        await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
        await p.waitForTimeout(400);
        expect(await bars(p), `hovering key ${i}`).toEqual([]);
      }
      await p.locator(KEY('Inbox')).click();
      await p.locator('.loom-window').waitFor();
      await p.locator(KEY('Inbox')).click();
      await onDesktop(p);
      await p.waitForTimeout(3000);
      expect(await bars(p), 'after a minimize').toEqual([]);
      // An agent's own dock (the dock swaps to its pages), and back.
      await p.locator('a.loom-w--agent').first().click();
      await p.locator('.loom-agent-dock').waitFor();
      await p.waitForTimeout(3000);
      expect(await bars(p), 'an agent\'s dock').toEqual([]);
      await p.locator('.loom-dock-bar [data-part="item"][aria-label="Back"]').click();
      await onDesktop(p);
      await p.waitForTimeout(3000);
      expect(await bars(p), 'back from it').toEqual([]);
      await p.context().close();
    }, 90_000);
  }

  it('a phone keeps its own layout: no window, and its open page\'s key leaves it open; the dock sits where it did', async () => {
    const p = await screen(390, { touch: true, path: '/inbox' });
    await p.locator('.loom-top h1').waitFor();
    expect(await p.locator('.loom-window, .loom-desk').count()).toBe(0);
    await p.locator(KEY('Inbox')).tap();
    await p.waitForTimeout(500);
    expect(where(p)).toBe('/inbox');
    const m = await p.evaluate(() => {
      const bar = document.querySelector('.loom-dock-bar')!.getBoundingClientRect();
      const keys = [...document.querySelectorAll('.loom-dock-bar [data-part="item"]')].map((k) => k.getBoundingClientRect());
      const vp = document.querySelector('.loom-dock-bar [data-part="viewport"]')!.getBoundingClientRect();
      return { underRule: keys[0].top - (bar.top + 22), left: Math.round(keys[0].left), vpLeft: Math.round(vp.left), vpRight: Math.round(vp.right), sw: document.documentElement.scrollWidth };
    });
    expect(m.underRule).toBe(10);
    // The phone's dock box is as it was: its scroller inside the screen, nothing sideways.
    expect(m.vpLeft).toBeGreaterThanOrEqual(0);
    expect(m.vpRight).toBeLessThanOrEqual(390);
    expect(m.sw).toBeLessThanOrEqual(390);
    await p.context().close();
  }, 60_000);
});
