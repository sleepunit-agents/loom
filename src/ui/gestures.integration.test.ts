/**
 * A phone's gestures, its page moves and its haptics (t-1855), in a real browser at a phone's width with touch, driven
 * by CDP touches: a sideways swipe moves between the dock's own pages in its order, and nothing else does (a diagonal
 * or a vertical drag, a start in the Inbox's chips, Safari's edges, a page with a crumb); a swipe up from the dock opens
 * Find, never from the home bar's inset, and a tap on a key is still a tap; haptics tick on a commit while they're on,
 * not while they're off; the page moves (a View Transition) run by the dock's order, push into a page and pop back, a
 * crossfade under reduced motion, with the dock and the bar left where they are; the dock's keys swap by sliding; and
 * nothing is ever wider than 390 px.
 *
 * Runs where the app is built (npm run build) and a Chrome is installed (GitHub's runners have one).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { chromium, type Browser, type CDPSession, type Page } from 'playwright-core';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from '../household.js';
import { createConversationTables, recordTurn, writeDigest } from '../backends/conversations.js';
import { closeAllBackends } from '../backends/index.js';

const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);

type Phone = { p: Page; cdp: CDPSession };
type Seen = { moves: (string | undefined)[]; anims: { pe: string; name: string }[][]; buzz: unknown[]; wide: number };

describe.runIf(built && chrome)('a phone\'s gestures, page moves and haptics', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  const saved = process.env.LOOM_HOME;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-gestures-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), a === 'art' ? '# Art E Fish\n' : '# Visual Mark\n');
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db')); createConversationTables(db); db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
    process.env.LOOM_HOME = home;
    h = loadHousehold(home)!;
    token = createToken(h, { role: { kind: 'owner' }, label: 'jonathan' }).token;
    const art = agentDir(h, 'art');
    const conv = recordTurn(art, 'art', { venue: 'wake', place: 'lane:making', label: 't-738: sonarr', at: new Date().toISOString(), from: { kind: 'schedule' }, kind: 'wake' }, 'runtime:clock').conversation;
    writeDigest(art, { conversation: conv, run: 'r1' }, { summary: 'Checked.', needs_owner: { ask: 'OK to turn off the recycle bin on Sonarr for a quick rename?',
      why: 'Deleting a big show takes hours.', if_yes: 'I turn it off.', if_no: 'I plan a rework.', refs: ['t-738'] } } as never);
    handle = await startHttpServer({ contextDir: art, host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await handle?.close();
    await closeAllBackends();
    if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved;
    if (h) rmSync(h.home, { recursive: true, force: true });
  });

  /** A phone (390 × 844, touch, an iPhone's insets) in a look, its Appearance said to loom; what it does is watched:
   * each View Transition (the move asked for, and its animations once ready), each vibration, and the widest the
   * document has been. */
  async function phone(o: { look?: 'neon' | '000h'; motion?: 'reduce' | 'no-preference'; haptics?: boolean; ua?: string } = {}): Promise<Phone> {
    const look = o.look ?? 'neon';
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: o.motion ?? 'no-preference', isMobile: true, hasTouch: true, serviceWorkers: 'block', ...(o.ua ? { userAgent: o.ua } : {}) });
    await ctx.addInitScript(([l, hp]) => {
      localStorage.setItem('loom-look', l as string); localStorage.setItem('loom-haptics', hp ? 'on' : 'off'); sessionStorage.setItem('loom-arrived', '1');
      const w = window as unknown as { __seen: Seen };
      w.__seen = { moves: [], anims: [], buzz: [], wide: 0 };
      Object.defineProperty(Navigator.prototype, 'vibrate', { configurable: true, value(p: unknown) { w.__seen.buzz.push(p); return true; } });
      const d = Document.prototype as unknown as { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };
      const orig = d.startViewTransition;
      if (orig) d.startViewTransition = function (this: Document, cb: () => void) {
        w.__seen.moves.push(document.documentElement.dataset.move);
        const vt = orig.call(this, cb);
        vt.ready.then(() => {
          w.__seen.anims.push(document.getAnimations().map((a) => ({ pe: (a.effect as KeyframeEffect).pseudoElement ?? '', name: (a as CSSAnimation).animationName ?? '' })).filter((a) => a.pe.startsWith('::view-transition')));
        }).catch(() => {});
        return vt;
      };
      const watch = () => { w.__seen.wide = Math.max(w.__seen.wide, document.documentElement.scrollWidth); requestAnimationFrame(watch); };
      requestAnimationFrame(watch);
      // Chrome's emulated touch has no :active for a held finger otherwise: nothing to do with what's tested.
      void (undefined as unknown);
    }, [look, o.haptics ?? true] as const);
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    const cdp = await ctx.newCDPSession(p);
    await cdp.send('Emulation.setSafeAreaInsetsOverride' as never, { insets: { top: 47, topMax: 47, bottom: 34, bottomMax: 34 } } as never);
    await p.goto(`${base}/appearance`);
    await p.locator('.loom-top h1').waitFor();
    const csrf = await p.evaluate(async () => ((await (await fetch('/appearance', { headers: { accept: 'application/json' } })).json()) as { chrome: { csrf: string } }).chrome.csrf);
    await p.evaluate(async ([c, l, hp]) => { await fetch('/appearance/prefs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ _csrf: c, look: l, haptics: hp }) }); }, [csrf, look, o.haptics ?? true] as const);
    return { p, cdp };
  }
  /** Open a page, and let it settle (its neighbours fetched, haptics' chunk loaded). */
  const open = async ({ p }: Phone, path: string) => { await p.goto(`${base}${path}`); await p.locator('.loom-top h1').waitFor(); await p.waitForTimeout(1800); };
  const seen = ({ p }: Phone) => p.evaluate(() => (window as unknown as { __seen: Seen }).__seen);
  const forget = ({ p }: Phone) => p.evaluate(() => { const s = (window as unknown as { __seen: Seen }).__seen; s.moves = []; s.anims = []; s.buzz = []; });
  const where = ({ p }: Phone) => p.evaluate(() => location.pathname);
  /** A finger from one point to another, in steps a frame apart; `mid` runs halfway, finger down. */
  async function drag({ p, cdp }: Phone, from: [number, number], to: [number, number], o: { steps?: number; mid?: () => Promise<void> } = {}) {
    const steps = o.steps ?? 12;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from[0], y: from[1] }] });
    for (let n = 1; n <= steps; n++) {
      const t = n / steps;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from[0] + (to[0] - from[0]) * t, y: from[1] + (to[1] - from[1]) * t }] });
      await p.waitForTimeout(16);
      if (n === Math.floor(steps / 2) && o.mid) await o.mid();
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await p.waitForTimeout(500);
  }
  const tap = async ({ p, cdp }: Phone, x: number, y: number) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await p.waitForTimeout(600);
  };
  /** Into an agent's own page the way a person goes there: Find, then its row. */
  const toAgent = async (f: Phone) => {
    await f.p.keyboard.press('Control+k');
    await f.p.locator('.loom-find [role="option"]', { hasText: 'Art E Fish' }).first().click();
  };
  const keyAt = async ({ p }: Phone, label: string) => {
    const b = (await p.locator(`.loom-dock-now [data-part="item"][aria-label="${label}"]`).boundingBox())!;
    return [b.x + b.width / 2, b.y + b.height / 2] as [number, number];
  };

  it('sideways: Home to the Inbox and back, by the dock\'s order, with a tick and a move each way; never wider than 390 px', async () => {
    const f = await phone();
    await open(f, '/');
    let mid = 0;
    let held: { state: string; t: number }[] = [];
    await drag(f, [300, 420], [80, 430], { mid: async () => {
      mid = await f.p.evaluate(() => document.documentElement.scrollWidth);
      // Halfway, the move is held under the finger: paused, part of the way.
      held = await f.p.evaluate(() => document.getAnimations().filter((a) => (a.effect as KeyframeEffect).pseudoElement === '::view-transition-new(loom-page)')
        .map((a) => ({ state: a.playState, t: Number(a.currentTime) })));
    } });
    await expect.poll(() => where(f)).toBe('/inbox');
    let s = await seen(f);
    expect(s.moves).toContain('right');
    expect(s.anims.flat().some((a) => a.pe === '::view-transition-new(loom-page)' && a.name === 'loom-move-in-right')).toBe(true);
    expect(s.buzz.length).toBeGreaterThanOrEqual(1);
    expect(mid).toBeLessThanOrEqual(390);
    expect(held).toHaveLength(1);
    expect(held[0].state).toBe('paused');
    expect(held[0].t).toBeGreaterThan(0);
    expect(held[0].t).toBeLessThan(280);
    await f.p.waitForTimeout(1500);
    await forget(f);
    await drag(f, [80, 520], [320, 530]);
    await expect.poll(() => where(f)).toBe('/');
    s = await seen(f);
    expect(s.moves).toContain('left');
    expect(s.anims.flat().some((a) => a.pe === '::view-transition-new(loom-page)' && a.name === 'loom-move-in-left')).toBe(true);
    expect(s.wide).toBeLessThanOrEqual(390);
    await f.p.context().close();
  }, 90_000);

  it('a short or let-go swipe runs back: the page it started on stays', async () => {
    const f = await phone();
    await open(f, '/');
    await drag(f, [300, 420], [260, 422]);
    expect(await where(f)).toBe('/');
    expect(await f.p.locator('.loom-pbar h1').innerText()).toBe('Home');
    await f.p.context().close();
  }, 60_000);

  it('a diagonal or a vertical drag, a start in the Inbox\'s chips, or a page with a crumb: no page change', async () => {
    const f = await phone();
    await open(f, '/');
    await drag(f, [300, 500], [200, 300]);
    expect(await where(f)).toBe('/');
    await drag(f, [200, 600], [200, 300]);
    expect(await where(f)).toBe('/');
    await open(f, '/inbox');
    const chips = (await f.p.locator('main [aria-label="Show"]').boundingBox())!;
    const y = chips.y + Math.min(16, chips.height / 2);
    await drag(f, [320, y], [60, y + 4]);
    expect(await where(f)).toBe('/inbox');
    await open(f, '/people/jonathan');
    expect(await f.p.locator('.loom-pbar__back').count()).toBe(1);
    await drag(f, [300, 420], [60, 425]);
    expect(await where(f)).toBe('/people/jonathan');
    // Nor up from the dock: a page with a crumb has no gestures yet.
    const [kx, ky] = await keyAt(f, 'Inbox');
    await drag(f, [kx, ky], [kx, ky - 120]);
    expect(await f.p.locator('.loom-find[role="dialog"]').count()).toBe(0);
    await f.p.context().close();
  }, 90_000);

  it('Safari\'s edges are iOS\'s; in the home-screen app they\'re the page\'s', async () => {
    const f = await phone();
    await open(f, '/');
    await drag(f, [380, 420], [140, 425]);
    expect(await where(f)).toBe('/');
    await f.p.evaluate(() => document.documentElement.classList.add('loom-ios-app'));
    await drag(f, [380, 420], [140, 425]);
    await expect.poll(() => where(f)).toBe('/inbox');
    await f.p.context().close();
  }, 60_000);

  it('up from the dock opens Find, with a tick; never from the home bar\'s inset; a tap on a key is still a tap', async () => {
    const f = await phone();
    await open(f, '/');
    const [kx, ky] = await keyAt(f, 'Places');
    await drag(f, [kx, 844 - 12], [kx, 844 - 140]);
    expect(await f.p.locator('.loom-find[role="dialog"]').count()).toBe(0);
    await forget(f);
    await drag(f, [kx, ky], [kx, ky - 110]);
    await f.p.locator('.loom-find[role="dialog"]').waitFor();
    expect(await where(f)).toBe('/');   // the key it started on wasn't pressed
    expect((await seen(f)).buzz.length).toBeGreaterThanOrEqual(1);
    await f.p.keyboard.press('Escape');
    await f.p.locator('.loom-find[role="dialog"]').waitFor({ state: 'detached' });
    await forget(f);
    const [ix, iy] = await keyAt(f, 'Inbox');
    await tap(f, ix, iy);
    await expect.poll(() => where(f)).toBe('/inbox');
    const s = await seen(f);
    expect(s.moves).toContain('right');   // a tap moves as a swipe does
    expect(s.buzz.length).toBeGreaterThanOrEqual(1);
    await f.p.context().close();
  }, 90_000);

  it('Haptics off: the pages still change, nothing ticks', async () => {
    const f = await phone({ haptics: false });
    await open(f, '/');
    await drag(f, [300, 420], [80, 430]);
    await expect.poll(() => where(f)).toBe('/inbox');
    const [hx, hy] = await keyAt(f, 'Home');
    await tap(f, hx, hy);
    await expect.poll(() => where(f)).toBe('/');
    expect((await seen(f)).buzz).toEqual([]);
    // Appearance says it, with the gestures.
    await open(f, '/appearance');
    expect(await f.p.locator('[aria-label="Haptics"] [data-state="on"]').innerText()).toBe('Off');
    expect(await f.p.locator('.loom-gestures-hint').innerText()).toMatch(/swipe sideways .* swipe up from the dock/i);
    await f.p.context().close();
  }, 60_000);

  it('iOS: a dock key wears a label for the page\'s one hidden switch, and a tap on it is still the key\'s', async () => {
    const f = await phone({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1' });
    await open(f, '/');
    expect(await f.p.locator('.loom-dock-now [data-part="item"] label.loom-haptic[for="loom-haptic"]').count()).toBeGreaterThanOrEqual(4);
    expect(await f.p.locator('input#loom-haptic[switch]').evaluate((e) => getComputedStyle(e).visibility)).toBe('hidden');
    const [ix, iy] = await keyAt(f, 'Inbox');
    await tap(f, ix, iy);
    await expect.poll(() => where(f)).toBe('/inbox');
    await f.p.context().close();
  }, 60_000);

  it('reduced motion: a swipe still changes the page, with a crossfade and nothing sliding', async () => {
    const f = await phone({ motion: 'reduce' });
    await open(f, '/');
    await drag(f, [300, 420], [80, 430]);
    await expect.poll(() => where(f)).toBe('/inbox');
    const a = (await seen(f)).anims.flat().filter((x) => x.pe.endsWith('(loom-page)'));
    expect(a.length).toBeGreaterThan(0);
    expect(a.map((x) => x.name).sort()).toEqual(['loom-move-fade-out', 'loom-move-name-in']);
    await f.p.context().close();
  }, 60_000);

  it('by the dock\'s order both ways, a push into a page and a pop back; the dock and the bar never move', async () => {
    const f = await phone();
    await open(f, '/inbox');
    const dockBefore = await f.p.locator('.loom-dock-bar').boundingBox();
    const barBefore = await f.p.locator('.loom-pbar').boundingBox();
    await forget(f);
    const [px, py] = await keyAt(f, 'Places');
    let mid: { dock: unknown; bar: unknown } | null = null;
    await f.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: px, y: py }] });
    await f.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await f.p.waitForTimeout(120);
    mid = { dock: await f.p.locator('.loom-dock-bar').boundingBox(), bar: await f.p.locator('.loom-pbar').boundingBox() };
    await expect.poll(() => where(f)).toBe('/places');
    expect(mid).toEqual({ dock: dockBefore, bar: barBefore });
    let s = await seen(f);
    expect(s.moves).toEqual(['right']);
    // Nothing of the dock's, the bar's or the fade's is animated: they stay put. The page's name crossfades.
    const pes = s.anims.flat().map((x) => x.pe);
    expect(pes.filter((x) => /loom-(dock|bar|fade)\)/.test(x))).toEqual([]);
    expect(pes).toContain('::view-transition-new(loom-title)');
    await f.p.waitForTimeout(1500);
    await forget(f);
    const [ix, iy] = await keyAt(f, 'Inbox');
    await tap(f, ix, iy);
    await expect.poll(() => where(f)).toBe('/inbox');
    expect((await seen(f)).moves).toEqual(['left']);
    // Into an agent's page: a push; Back: a pop.
    await open(f, '/');
    await forget(f);
    await toAgent(f);
    await expect.poll(() => where(f)).toBe('/a/art');
    s = await seen(f);
    expect(s.moves).toEqual(['push']);
    expect(s.anims.flat().some((a) => a.pe === '::view-transition-new(loom-page)' && a.name === 'loom-move-in-right')).toBe(true);
    await f.p.waitForTimeout(800);
    await forget(f);
    await f.p.goBack();
    await expect.poll(() => where(f)).toBe('/');
    s = await seen(f);
    expect(s.moves).toEqual(['pop']);
    await expect.poll(async () => (await seen(f)).anims.flat().some((a) => a.pe === '::view-transition-old(loom-page)' && a.name === 'loom-move-off-right')).toBe(true);
    expect(s.wide).toBeLessThanOrEqual(390);
    await f.p.context().close();
  }, 90_000);

  it('the dock\'s keys swap by sliding: the old ones end below the screen, the new ones in their place; back runs the other way', async () => {
    const f = await phone();
    await open(f, '/');
    await toAgent(f);
    await f.p.locator('.loom-dock-swap[data-swap="go"] .loom-dock-gone').waitFor({ state: 'attached' });
    const ends = await f.p.evaluate(() => {
      const lanes = (sel: string) => [...document.querySelectorAll<HTMLElement>(`${sel} [data-part="lane"]`)];
      for (const l of [...lanes('.loom-dock-gone'), ...lanes('.loom-dock-now')]) for (const a of l.getAnimations()) a.finish();
      return { gone: lanes('.loom-dock-gone').map((l) => l.getBoundingClientRect().top), now: lanes('.loom-dock-now').map((l) => Math.round(l.getBoundingClientRect().top)),
        delays: lanes('.loom-dock-now').map((l) => getComputedStyle(l).animationDelay), h: innerHeight };
    });
    expect(ends.gone.length).toBeGreaterThan(0);
    expect(Math.min(...ends.gone)).toBeGreaterThanOrEqual(ends.h);
    expect(ends.delays.slice(0, 3)).toEqual(['0.05s', '0.075s', '0.1s']);
    await f.p.locator('.loom-dock-gone').waitFor({ state: 'detached' });
    const settled = await f.p.evaluate(() => [...document.querySelectorAll<HTMLElement>('.loom-dock-now [data-part="lane"]')].map((l) => Math.round(l.getBoundingClientRect().top)));
    expect(ends.now).toEqual(settled);
    await f.p.waitForTimeout(600);
    await f.p.goBack();
    await f.p.locator('.loom-dock-swap[data-swap="back"]').waitFor({ state: 'attached' });
    const back = await f.p.evaluate(() => [...document.querySelectorAll<HTMLElement>('.loom-dock-now [data-part="lane"]')].map((l) => getComputedStyle(l).animationDelay));
    expect(back.at(-1)).toBe('0.05s');   // from the other end
    expect((await seen(f)).wide).toBeLessThanOrEqual(390);
    await f.p.context().close();
  }, 60_000);
});
