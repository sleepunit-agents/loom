/**
 * Neon wider than a phone (Jonathan, 2026-11-05): the phone's bar (phone-bar.tsx) at every width, under loom's own
 * system bar (system-bar.tsx) where a phone's status bar would be: loom's clock (loom's time, in loom's zone, never the
 * browser's) on the left, a few monochrome glyphs on the right, each with its words; the big icon-and-title header is
 * gone. In a real browser at 1280 and 800 px, over a household with a Boxes piece that has an alert and reports an agent
 * at work, a backup not set up, and something waiting. Every look has them (Low Light and Daylight are token sets).
 *
 * Runs where the app is built (npm run build) and a Chrome is installed (GitHub's runners have one).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { Look } from '../../web/src/look';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from '../household.js';
import { createConversationTables, recordTurn, writeDigest } from '../backends/conversations.js';
import { closeAllBackends } from '../backends/index.js';
import { clearPieceCache } from './pieces.js';

const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);

/** A stand-in Boxes piece (the runtime): its tile says how many, one of its asks is an alert, and it reports art at work. */
function boxes(dir: string) {
  writeFileSync(join(dir, 'boxes.manifest.json'), JSON.stringify({ v: 2, tab: { label: 'Boxes' }, tile: { label: 'Boxes', value: '3 boxes', page: '' },
    // No kind and no buttons: an alert all the same (docs/extensions.md).
    asks: [{ text: 'loom-http failed on mini', page: '', label: 'Look' }],
    // art at work (something it's doing); mark said broken by this piece, though another says it's doing something.
    agents: { art: { readings: [], doing: [{ text: 'Checking a pull request' }] }, mark: { state: 'broken', reason: 'Its box is dark', readings: [] } } }));
  writeFileSync(join(dir, 'boxes.page.json'), JSON.stringify({ title: 'Boxes', sections: [{ id: 's', blocks: [{ type: 'text', text: 'Three boxes.' }] }] }));
  writeFileSync(join(dir, 'loom-runtime'), `#!/bin/sh
d=$(dirname "$0")
case "$1 $2" in
"ui --json") cat "$d/boxes.manifest.json" ;;
"ui page") cat >/dev/null; cat "$d/boxes.page.json" ;;
*) exit 2 ;;
esac
`);
  chmodSync(join(dir, 'loom-runtime'), 0o755);
}

/** A second piece that says mark is doing something (the runtime says mark is broken: worst wins, as on its card). */
function busy(dir: string) {
  writeFileSync(join(dir, 'busy.manifest.json'), JSON.stringify({ v: 2, agents: { mark: { readings: [], doing: [{ text: 'Rendering props' }] } } }));
  writeFileSync(join(dir, 'loom-busy'), `#!/bin/sh\ncase "$1 $2" in\n"ui --json") cat "$(dirname "$0")/busy.manifest.json" ;;\n*) exit 2 ;;\nesac\n`);
  chmodSync(join(dir, 'loom-busy'), 0o755);
}

describe.runIf(built && chrome)('Neon wider than a phone: the phone\'s bar under loom\'s own system bar', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    clearPieceCache();
    const home = mkdtempSync(join(tmpdir(), 'loom-desk-bar-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), a === 'art' ? '# Art E Fish\n' : '# Visual Mark\n');
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db')); createConversationTables(db); db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    boxes(bin);
    busy(bin);
    for (const k of ['PATH', 'LOOM_HOME', 'XDG_CONFIG_HOME', 'LOOM_TIMEZONE']) saved[k] = process.env[k];
    process.env.PATH = [bin, process.env.PATH].join(delimiter);
    process.env.LOOM_HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    // loom's zone, 45 minutes off any whole-hour zone, and never the browser's (device() puts it in Los Angeles).
    process.env.LOOM_TIMEZONE = 'Asia/Kathmandu';
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
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (h) rmSync(h.home, { recursive: true, force: true });
  });

  const errors: string[] = [];
  async function device(look: Look, motion: 'reduce' | 'no-preference', width: number, o: { skewMs?: number } = {}): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height: 800 }, reducedMotion: motion, serviceWorkers: 'block', timezoneId: 'America/Los_Angeles' });
    // A device whose clock is wrong: its Date runs this far from the real one (loom's).
    if (o.skewMs) await ctx.addInitScript((d) => { const N = Date.now; Date.now = () => N() + d; const D = Date;
      // any: replacing the global Date constructor itself, which TypeScript types as read-only.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).Date = class extends D { constructor(...a: unknown[]) { if (a.length) super(...(a as [])); else super(N() + d); } static now() { return N() + d; } }; }, o.skewMs);
    await ctx.addInitScript((l) => { localStorage.setItem('loom-look', l); sessionStorage.setItem('loom-arrived', '1'); }, look);
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`${width}: ${m.text()}`); });
    p.on('pageerror', (e) => errors.push(`${width}: ${e.message}`));
    await p.goto(`${base}/appearance`);
    await p.locator('.loom-top h1').waitFor();
    const csrf = await p.evaluate(async () => ((await (await fetch('/appearance', { headers: { accept: 'application/json' } })).json()) as { chrome: { csrf: string } }).chrome.csrf);
    await p.evaluate(async ([c, l]) => { await fetch('/appearance/prefs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ _csrf: c, look: l }) }); }, [csrf, look]);
    return p;
  }
  const open = async (p: Page, path: string) => { await p.goto(`${base}${path}`); await p.locator('.loom-top h1').waitFor(); await p.waitForTimeout(400); };

  it('at 1280 px: the system bar\'s clock and named glyphs over the phone\'s bar; no big header; the name is the ⓘ when the page has info; the count shows', async () => {
    const p = await device('neon', 'reduce', 1280);
    await open(p, '/');
    // The big header is gone: one title, the bar's, small and bold; no app tile.
    expect(await p.locator('.loom-top h1').count()).toBe(1);
    expect(await p.locator('.loom-pbar h1').innerText()).toBe('Home');
    expect(await p.locator('.loom-pbar h1').evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBe(13);
    expect(await p.locator('.loom-top .loom-app-tile').count()).toBe(0);
    // The system bar: over the phone's bar, the clock on its left (the time alone: "9:41"), small and bold.
    const sys = p.locator('.loom-sys');
    expect(await sys.count()).toBe(1);
    const clock = p.locator('.loom-sys__clock');
    // loom's time in loom's zone (Kathmandu here), not the browser's (Los Angeles): "9:41", no AM or PM.
    const loomTime = (ms: number) => new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kathmandu', hour: 'numeric', minute: '2-digit', hourCycle: 'h12' }).format(ms).replace(/\s?[AP]M$/, '');
    const shown = await clock.locator('[aria-hidden]').innerText();
    // Whole for a screen reader and on hover: the half of the day and the zone.
    expect(await clock.getAttribute('title')).toMatch(/^\d{1,2}:\d{2}\s[AP]M, Asia\/Kathmandu time$/);
    expect(await clock.locator('.sr-only').innerText()).toBe(await clock.getAttribute('title'));
    expect(shown).toMatch(/^\d{1,2}:\d{2}$/);
    expect([loomTime(Date.now()), loomTime(Date.now() - 60_000)]).toContain(shown);
    expect(await clock.evaluate((e) => ({ size: parseFloat(getComputedStyle(e).fontSize), weight: getComputedStyle(e).fontWeight }))).toEqual({ size: 13, weight: '700' });
    const [sb, bar, name, brand] = await Promise.all(['.loom-sys', '.loom-pbar', '.loom-pbar__name', '.loom-pbar__brand'].map(async (s) => (await p.locator(s).boundingBox())!));
    expect(sb.y + sb.height).toBeLessThanOrEqual(bar.y + 1);
    // As on a phone: the clock over the page's name, the glyphs over LOOM//OS (the bar spans the page's column).
    const cb = (await clock.boundingBox())!, last = (await p.locator('.loom-sys__icon svg').last().boundingBox())!;
    expect(Math.abs(cb.x - name.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(last.x + last.width - (bar.x + bar.width))).toBeLessThanOrEqual(4);
    expect(last.x).toBeGreaterThan(brand.x);
    // The glyphs: each named in words (aria-label), the same words shown on hover. Live; one agent at work; Boxes dimmed by its alert;
    // the backup, not set up here.
    const icons = await p.locator('.loom-sys__icon').evaluateAll((es) => es.map((e) => ({ k: (e as HTMLElement).dataset.k, name: e.getAttribute('aria-label'), dim: e.hasAttribute('data-dim') })));
    expect(icons).toEqual([
      { k: 'signal', name: 'Live: connected to loom', dim: false },
      { k: 'agents', name: '1 of 2 agents at work', dim: false },
      { k: 'boxes', name: '3 boxes: 1 alert', dim: true },
      { k: 'backup', name: 'Backup: not set up', dim: true },
    ]);
    expect(await p.getByRole('img', { name: 'Live: connected to loom' }).count()).toBe(1);
    const tip = p.locator('.loom-sys__icon[data-k="boxes"] .loom-sys__tip');
    expect(await tip.evaluate((e) => getComputedStyle(e).opacity)).toBe('0');
    await p.locator('.loom-sys__icon[data-k="boxes"]').hover();
    await expect.poll(() => tip.evaluate((e) => getComputedStyle(e).opacity)).toBe('1');
    expect(await tip.innerText()).toBe('3 boxes: 1 alert');
    // A glyph that's a place goes there.
    expect(await p.locator('.loom-sys__icon[data-k="boxes"]').getAttribute('href')).toBe('/p/runtime');
    // The count: visible, never part of what moves.
    const needs = p.locator('.loom-pbar__needs');
    expect(await needs.isVisible()).toBe(true);
    expect(await needs.getAttribute('aria-label')).toMatch(/^\d+ needs? you$/);
    expect(await needs.evaluate((e) => !!e.closest('.loom-tick'))).toBe(false);
    // A page with something to say about itself: its name is the button to it.
    await open(p, '/members');
    const about = p.getByRole('button', { name: 'About Members' });
    expect(await about.count()).toBe(1);
    expect(await p.locator('.loom-pbar__title').evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
    await p.context().close();
  }, 90_000);

  it('at 800 px (between a phone and the side panel): the same bars, the dock still below, nothing wider than the screen', async () => {
    const p = await device('neon', 'reduce', 800);
    for (const path of ['/', '/inbox', '/setup', '/a/art']) {
      await open(p, path);
      expect(await p.locator('.loom-sys').count(), path).toBe(1);
      expect(await p.locator('.loom-pbar h1').count(), path).toBe(1);
      expect(await p.evaluate(() => document.documentElement.scrollWidth), path).toBeLessThanOrEqual(800);
    }
    expect(await p.locator('.loom-dock-bar').count()).toBe(1);
    await p.context().close();
  }, 90_000);

  it('the system bar starts at 640 px: none at 639, there at 640', async () => {
    for (const [w, n] of [[639, 0], [640, 1]] as const) {
      const p = await device('neon', 'reduce', w);
      await open(p, '/');
      expect(await p.locator('.loom-sys').count(), `${w}`).toBe(n);
      expect(await p.locator('.loom-pbar').count(), `${w}`).toBe(1);
      expect(await p.evaluate(() => document.documentElement.scrollWidth), `${w}`).toBeLessThanOrEqual(w);
      await p.context().close();
    }
  }, 60_000);

  it('the ticker has more room and still moves only when its words overflow; reduced motion keeps it still', async () => {
    const p = await device('neon', 'no-preference', 1280);
    await open(p, '/');
    const tick = p.locator('.loom-tick');
    const state = () => tick.evaluate((e) => ({ run: e.hasAttribute('data-run'), w: e.clientWidth, over: (e.querySelector('.loom-tick__line') as HTMLElement).scrollWidth > e.clientWidth + 1 }));
    // Measured once its typeface is in (the words' width changes with it), and settled, even on a busy machine.
    await p.waitForFunction(() => document.fonts.status === 'loaded');
    expect((await state()).w).toBeGreaterThan(500);
    await expect.poll(async () => { const s = await state(); return s.run === s.over; }, { timeout: 10_000 }).toBe(true);
    // Crowded, it moves.
    await tick.evaluate((e) => { (e as HTMLElement).style.flex = 'none'; (e as HTMLElement).style.width = '120px'; });
    await expect.poll(async () => (await state()).run, { timeout: 10_000 }).toBe(true);
    await p.context().close();

    const q = await device('neon', 'reduce', 1280);
    await open(q, '/');
    const t = q.locator('.loom-tick');
    await t.evaluate((e) => { (e as HTMLElement).style.flex = 'none'; (e as HTMLElement).style.width = '120px'; });
    await q.waitForTimeout(300);
    expect(await t.evaluate((e) => ({ run: e.hasAttribute('data-run'), name: getComputedStyle(e.querySelector('.loom-tick__track')!).animationName }))).toEqual({ run: false, name: 'none' });
    await q.context().close();
  }, 90_000);

  it('its clock is loom\'s, not the device\'s: a device three hours and seven minutes fast still shows loom\'s time (its answers\' Date)', async () => {
    const p = await device('neon', 'reduce', 1280, { skewMs: (3 * 60 + 7) * 60_000 });
    await open(p, '/');
    const loomTime = (ms: number) => new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kathmandu', hour: 'numeric', minute: '2-digit', hourCycle: 'h12' }).format(ms).replace(/\s?[AP]M$/, '');
    expect([loomTime(Date.now()), loomTime(Date.now() - 60_000)]).toContain(await p.locator('.loom-sys__clock [aria-hidden]').innerText());
    await p.context().close();
  }, 60_000);

  it('Low Light and Daylight at 1280 px: the same system bar and phone bar, no big header', async () => {
    for (const look of ['lowlight', 'daylight'] as const) {
      const p = await device(look, 'reduce', 1280);
      await open(p, '/');
      expect(await p.evaluate(() => document.documentElement.dataset.look), look).toBe(look);
      expect([await p.locator('.loom-sys').count(), await p.locator('.loom-pbar').count(), await p.locator('.loom-top h1').count()], look).toEqual([1, 1, 1]);
      expect(await p.locator('.loom-pbar h1').evaluate((e) => parseFloat(getComputedStyle(e).fontSize)), look).toBe(13);
      await p.context().close();
    }
  }, 60_000);

  it('no console errors on the way', () => { expect(errors).toEqual([]); });
});
