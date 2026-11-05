/**
 * Neon Noir's chrome, every look's since 2026-11-05, in a real browser, over a household with something waiting (an ask
 * from Art, task t-738): the Inbox's sheet has its title bar, Find is a command bar, the power-on ends at a tap well
 * before it would end by itself, and sound plays only when the person has turned it on and the opening animation runs.
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

describe.runIf(built && chrome)('Neon Noir\'s chrome', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  const saved = process.env.LOOM_HOME;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-neon-chrome-'));
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
    writeDigest(art, { conversation: conv, run: 'r1' }, { summary: 'Checked the recycle bin.', needs_owner: { ask: 'OK to turn off the recycle bin on Sonarr for a quick rename?',
      why: 'Deleting a big show takes hours because the recycle bin copies it first.', if_yes: 'I turn it off, rename, and turn it back on.', if_no: 'I plan a rework.', refs: ['t-738'] } } as never);
    handle = await startHttpServer({ contextDir: art, host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await handle?.close();
    await closeAllBackends();
    if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved;
    rmSync(h.home, { recursive: true, force: true });
  });

  /** A device: its own sign-in, this device's copy of the look, and a record of the arrival and of every tone played. */
  async function device(motion: 'reduce' | 'no-preference', look: 'neon' | 'lowlight' | 'daylight'): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: motion, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    await ctx.addInitScript((l) => {
      localStorage.setItem('loom-look', l);
      const w = window as unknown as { arrive: { set?: number; off?: number }; tones: number };
      w.arrive = {}; w.tones = 0;
      new MutationObserver(() => { const on = 'arrive' in document.documentElement.dataset; if (on && w.arrive.set === undefined) w.arrive.set = performance.now(); if (!on && w.arrive.set !== undefined && w.arrive.off === undefined) w.arrive.off = performance.now(); })
        // The page's <html> isn't made yet when this runs: watch the document for it.
        .observe(document, { attributes: true, subtree: true, attributeFilter: ['data-arrive'] });
      const C = window.AudioContext;
      if (C) window.AudioContext = class extends C { createOscillator() { w.tones++; return super.createOscillator(); } } as typeof AudioContext;
    }, look);
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    return ctx.newPage();
  }
  const arrival = (p: Page) => p.evaluate(() => (window as unknown as { arrive: { set?: number; off?: number } }).arrive);
  async function choose(p: Page, prefs: Record<string, unknown>) {
    await p.goto(`${base}/appearance`);
    await p.locator('.loom-top h1').waitFor();
    const csrf = await p.evaluate(async () => ((await (await fetch('/appearance', { headers: { accept: 'application/json' } })).json()) as { chrome: { csrf: string } }).chrome.csrf);
    expect(await p.evaluate(async ([c, b]) => (await fetch('/appearance/prefs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ _csrf: c, ...(b as object) }) })).status, [csrf, prefs] as const)).toBe(200);
  }

  it('the Inbox\'s sheet: a title bar (what, who, its task), in every look', async () => {
    for (const look of ['neon', 'daylight'] as const) {
      const p = await device('reduce', look);
      await choose(p, { look });
      await p.goto(`${base}/inbox`);
      await p.getByText('OK to turn off the recycle bin').first().click();
      const bar = p.locator('.loom-sheet-bar');
      await bar.waitFor({ state: 'attached' });
      await bar.waitFor();
      expect((await bar.innerText()).replace(/\s+/g, ' '), look).toMatch(/ALERT|ASK|PERMISSION|DECISION/);
      expect(await bar.innerText()).toMatch(/t-738/i);
      expect(await bar.locator('.loom-data').getAttribute('aria-hidden')).toBeNull();
      await p.context().close();
    }
  }, 60_000);

  it('Find under Neon is a command bar: a prompt, a cyan field', async () => {
    const p = await device('reduce', 'neon');
    await choose(p, { look: 'neon' });
    await p.goto(`${base}/`);
    await p.locator('.loom-find-pill').click();
    const field = p.locator('.loom-find-field');
    await field.waitFor();
    expect(await field.evaluate((e) => [getComputedStyle(e, '::before').content, getComputedStyle(e).borderTopColor])).toEqual(['"›"', 'rgb(46, 230, 240)']);
    await p.context().close();
  }, 60_000);

  it('the power-on: a tap ends it long before it would end by itself, in every look', async () => {
    const run = async (look: 'neon' | 'lowlight', tap: boolean) => {
      const p = await device('no-preference', look);
      await p.goto(`${base}/`);
      await p.waitForFunction(() => (window as unknown as { arrive: { set?: number } }).arrive.set !== undefined, null, { timeout: 15_000 });
      if (tap) await p.mouse.click(5, 5);
      await p.waitForFunction(() => (window as unknown as { arrive: { off?: number } }).arrive.off !== undefined, null, { timeout: 5_000 });
      const a = await arrival(p);
      await p.context().close();
      return a.off! - a.set!;
    };
    const p0 = await device('reduce', 'neon'); await choose(p0, { look: 'neon' }); await p0.context().close();
    const natural = await run('neon', false), tapped = await run('neon', true);
    expect(natural).toBeGreaterThan(900);
    expect(tapped).toBeLessThan(natural / 2);
    const p1 = await device('reduce', 'lowlight'); await choose(p1, { look: 'lowlight' }); await p1.context().close();
    const calm = await run('lowlight', false), calmTapped = await run('lowlight', true);
    expect(calm).toBeGreaterThan(900);
    expect(calmTapped).toBeLessThan(calm / 2);
  }, 90_000);

  it('sound: chimes at the opening only once the person turns it on, and never when the opening is skipped', async () => {
    const sounds = async (motion: 'reduce' | 'no-preference') => {
      const p = await device(motion, 'neon');
      const fetched: string[] = [];
      p.on('request', (r) => { if (/\/assets\/sound-/.test(r.url())) fetched.push(r.url()); });
      await p.goto(`${base}/`);
      await p.locator('.loom-top h1').waitFor();
      await p.waitForTimeout(2500);
      const tones = await p.evaluate(() => (window as unknown as { tones: number }).tones);
      await p.context().close();
      return { fetched: fetched.length, tones };
    };
    const p0 = await device('reduce', 'neon'); await choose(p0, { look: 'neon', sound: false }); await p0.context().close();
    expect(await sounds('no-preference')).toEqual({ fetched: 0, tones: 0 });
    const p1 = await device('reduce', 'neon'); await choose(p1, { sound: true }); await p1.context().close();
    const on = await sounds('no-preference');
    expect(on.fetched).toBeGreaterThan(0);
    expect(on.tones).toBeGreaterThan(0);
    expect(await sounds('reduce')).toEqual({ fetched: 0, tones: 0 });
  }, 90_000);
});
