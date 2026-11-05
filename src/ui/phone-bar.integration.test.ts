/**
 * Neon's phone bar, its ticker and its dock (t-1849), in a real browser at a phone's width, over a household with two
 * agents and something waiting: the bar sits at the safe-area inset with the page's name in it; the ticker moves only
 * when its words don't fit, and never under reduced motion, and stops while touched or hidden; the needs-you count is
 * never part of what moves; the dock's keys have names but show none; nothing is wider than 390 px. 000h and a wide
 * screen keep the big header (and 000h its dock's names).
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
import { agentDir, createToken, loadHousehold, type Household } from '../household.js';
import { createConversationTables, recordTurn, writeDigest } from '../backends/conversations.js';
import { closeAllBackends } from '../backends/index.js';

const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);

describe.runIf(built && chrome)('Neon\'s phone bar, ticker and dock', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  const saved = process.env.LOOM_HOME;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-phone-bar-'));
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
    rmSync(h.home, { recursive: true, force: true });
  });

  /** A device in a look, its arrival already had; at a phone's width with an iPhone's top inset, unless it's wide. */
  async function device(look: 'neon' | '000h', motion: 'reduce' | 'no-preference', width = 390): Promise<Page> {
    const phone = width < 640;
    const ctx = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, reducedMotion: motion, isMobile: phone, hasTouch: phone, serviceWorkers: 'block' });
    await ctx.addInitScript((l) => { localStorage.setItem('loom-look', l); sessionStorage.setItem('loom-arrived', '1'); }, look);
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    if (phone) await (await ctx.newCDPSession(p)).send('Emulation.setSafeAreaInsetsOverride' as never, { insets: { top: 47, topMax: 47, bottom: 34, bottomMax: 34 } } as never).catch(() => {});
    // The look is the person's (loom keeps it): say it, so a page never lands on the other one.
    await p.goto(`${base}/appearance`);
    await p.locator('.loom-top h1').waitFor();
    const csrf = await p.evaluate(async () => ((await (await fetch('/appearance', { headers: { accept: 'application/json' } })).json()) as { chrome: { csrf: string } }).chrome.csrf);
    await p.evaluate(async ([c, l]) => { await fetch('/appearance/prefs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ _csrf: c, look: l }) }); }, [csrf, look]);
    return p;
  }
  const open = async (p: Page, path: string) => { await p.goto(`${base}${path}`); await p.locator('.loom-top h1').waitFor(); await p.waitForTimeout(300); };

  it('the bar: at the inset, the page\'s name in it, no clock, the count pinned and visible; nothing wider than 390 px', async () => {
    const p = await device('neon', 'no-preference');
    for (const path of ['/', '/inbox', '/setup', '/places', '/a/art', '/appearance']) {
      await open(p, path);
      expect(await p.evaluate(() => document.documentElement.scrollWidth), path).toBeLessThanOrEqual(390);
      expect(await p.locator('.loom-status').count(), path).toBe(0);
      expect(await p.locator('.loom-pbar h1').count(), path).toBe(1);
    }
    await open(p, '/');
    expect(await p.locator('.loom-pbar h1').innerText()).toBe('Home');
    // Right under the phone's own bar: its top is the inset, no more.
    expect(Math.round((await p.locator('.loom-pbar').boundingBox())!.y)).toBe(await p.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.loom-top')!).paddingTop)));
    const needs = p.locator('.loom-pbar__needs');
    expect(await needs.innerText()).toBe('1');
    expect(await needs.getAttribute('aria-label')).toBe('1 needs you');
    // Never inside what moves, and on screen whole while the ticker runs.
    expect(await needs.evaluate((e) => !!e.closest('.loom-tick'))).toBe(false);
    await p.locator('.loom-tick[data-run]').waitFor({ state: 'attached' });
    const b = (await needs.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(390);
    await p.context().close();
  }, 90_000);

  it('the ticker moves only when its words overflow, slowly, and stops while touched or hidden', async () => {
    const p = await device('neon', 'no-preference');
    await open(p, '/');
    const tick = p.locator('.loom-tick');
    await p.locator('.loom-tick[data-run]').waitFor({ state: 'attached' });
    const moving = () => tick.evaluate((e) => { const t = e.querySelector('.loom-tick__track')!; const s = getComputedStyle(t); return { run: e.hasAttribute('data-run'), name: s.animationName, state: s.animationPlayState, copies: e.querySelectorAll('.loom-tick__line').length }; });
    expect(await moving()).toMatchObject({ run: true, name: 'loom-tick', state: 'running', copies: 2 });
    // ~20-30 px a second: the loop's length is the words' width (and the gap) at that speed.
    const speed = await tick.evaluate((e) => (e.querySelector('.loom-tick__line') as HTMLElement).offsetWidth / parseFloat(getComputedStyle(e.querySelector('.loom-tick__track')!).animationDuration));
    expect(speed).toBeGreaterThanOrEqual(20); expect(speed).toBeLessThanOrEqual(30);
    // Held while touched.
    await tick.dispatchEvent('pointerdown');
    expect((await moving()).state).toBe('paused');
    await tick.dispatchEvent('pointerup');
    expect((await moving()).state).toBe('running');
    // Held while the tab is hidden.
    await p.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
    await expect.poll(async () => (await moving()).state).toBe('paused');
    await p.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
    await expect.poll(async () => (await moving()).state).toBe('running');
    // Room for its words: it stands still, one copy.
    await tick.evaluate((e) => { (e as HTMLElement).style.flex = 'none'; (e as HTMLElement).style.width = '3000px'; });
    await expect.poll(async () => (await moving()).run).toBe(false);
    expect(await moving()).toMatchObject({ name: 'none', copies: 1 });
    await p.context().close();
  }, 90_000);

  it('reduced motion: the ticker stands still, cut with an ellipsis; the count still shows', async () => {
    const p = await device('neon', 'reduce');
    await open(p, '/');
    await p.waitForTimeout(500);
    const t = await p.locator('.loom-tick').evaluate((e) => { const l = e.querySelector('.loom-tick__line') as HTMLElement; return { run: e.hasAttribute('data-run'), name: getComputedStyle(e.querySelector('.loom-tick__track')!).animationName,
      copies: e.querySelectorAll('.loom-tick__line').length, ellipsis: getComputedStyle(l).textOverflow, over: l.scrollWidth > l.clientWidth }; });
    expect(t).toEqual({ run: false, name: 'none', copies: 1, ellipsis: 'ellipsis', over: true });
    expect(await p.locator('.loom-pbar__needs').isVisible()).toBe(true);
    await p.context().close();
  }, 60_000);

  it('the dock: every key named, no names showing, no tray; 000h keeps its names, its tray and its big header', async () => {
    const keys = async (p: Page) => p.locator('.loom-dock-bar [data-part="item"]').evaluateAll((bs) => bs.map((b) => ({
      name: b.getAttribute('aria-label') ?? '', shown: getComputedStyle(b.querySelector('[data-part="label"]')!).opacity })));
    const p = await device('neon', 'reduce');
    await open(p, '/');
    const neon = await keys(p);
    expect(neon.length).toBeGreaterThanOrEqual(4);
    expect(neon.every((k) => k.name.trim().length > 0 && k.shown === '0')).toBe(true);
    expect(await p.locator('.loom-dock-bar [data-part="shelf-plane"]').evaluate((e) => getComputedStyle(e).display)).toBe('none');
    // The "me" key is round.
    expect(await p.locator('.loom-me-dock [data-part="lane"]:last-child [data-part="visual"]').evaluate((e) => getComputedStyle(e).borderTopLeftRadius)).toBe('999px');
    await p.context().close();

    const q = await device('000h', 'reduce');
    await open(q, '/');
    expect((await keys(q)).every((k) => k.name.trim().length > 0 && k.shown === '1')).toBe(true);
    expect(await q.locator('.loom-dock-bar [data-part="shelf-plane"]').evaluate((e) => getComputedStyle(e).display)).not.toBe('none');
    expect(await q.locator('.loom-pbar').count()).toBe(0);
    expect(await q.locator('.loom-top h1').evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(28);
    await q.context().close();
  }, 90_000);

  it('a wide screen under Neon keeps the status bar and the big header', async () => {
    const p = await device('neon', 'reduce', 1280);
    await open(p, '/');
    expect(await p.locator('.loom-pbar').count()).toBe(0);
    expect(await p.locator('.loom-status').count()).toBe(1);
    expect(await p.locator('.loom-top h1').evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(28);
    await p.context().close();
  }, 60_000);
});
