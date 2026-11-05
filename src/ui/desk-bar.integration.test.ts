/**
 * Neon wider than a phone (Jonathan, 2026-11-05): the phone's bar (phone-bar.tsx) at every width, under loom's own
 * system bar (system-bar.tsx) where a phone's status bar would be: loom's clock on the left, a few monochrome glyphs
 * on the right, each with its words; the big icon-and-title header is gone. In a real browser at 1280 and 800 px, over
 * a household with a Boxes piece that has an alert, a backup not set up, and something waiting. 000h keeps its big
 * header and has no system bar.
 *
 * Runs where the app is built (npm run build) and a Chrome is installed (GitHub's runners have one).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from '../household.js';
import { createConversationTables, recordTurn, writeDigest } from '../backends/conversations.js';
import { closeAllBackends } from '../backends/index.js';
import { clearPieceCache } from './pieces.js';

const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);

/** A stand-in Boxes piece: its tile says how many, and one of its asks is an alert. */
function boxes(dir: string) {
  writeFileSync(join(dir, 'boxes.manifest.json'), JSON.stringify({ v: 2, tab: { label: 'Boxes' }, tile: { label: 'Boxes', value: '3 boxes', page: '' },
    asks: [{ text: 'loom-http failed on mini', page: '', label: 'Look', kind: 'alert' }] }));
  writeFileSync(join(dir, 'boxes.page.json'), JSON.stringify({ title: 'Boxes', sections: [{ id: 's', blocks: [{ type: 'text', text: 'Three boxes.' }] }] }));
  writeFileSync(join(dir, 'loom-boxes'), `#!/bin/sh
d=$(dirname "$0")
case "$1 $2" in
"ui --json") cat "$d/boxes.manifest.json" ;;
"ui page") cat >/dev/null; cat "$d/boxes.page.json" ;;
*) exit 2 ;;
esac
`);
  chmodSync(join(dir, 'loom-boxes'), 0o755);
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
    for (const k of ['PATH', 'LOOM_HOME', 'XDG_CONFIG_HOME']) saved[k] = process.env[k];
    process.env.PATH = [bin, process.env.PATH].join(delimiter);
    process.env.LOOM_HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
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

  async function device(look: 'neon' | '000h', motion: 'reduce' | 'no-preference', width: number): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height: 800 }, reducedMotion: motion, serviceWorkers: 'block' });
    await ctx.addInitScript((l) => { localStorage.setItem('loom-look', l); sessionStorage.setItem('loom-arrived', '1'); }, look);
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
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
    expect(await clock.innerText()).toMatch(/^\d{1,2}:\d{2}$/);
    expect(await clock.evaluate((e) => ({ size: parseFloat(getComputedStyle(e).fontSize), weight: getComputedStyle(e).fontWeight }))).toEqual({ size: 13, weight: '700' });
    const [sb, bar, name, brand] = await Promise.all(['.loom-sys', '.loom-pbar', '.loom-pbar__name', '.loom-pbar__brand'].map(async (s) => (await p.locator(s).boundingBox())!));
    expect(sb.y + sb.height).toBeLessThanOrEqual(bar.y + 1);
    // As on a phone: the clock over the page's name, the glyphs over LOOM//OS (the bar spans the page's column).
    const cb = (await clock.boundingBox())!, ib = (await p.locator('.loom-sys__icons').boundingBox())!;
    expect(Math.abs(cb.x - name.x)).toBeLessThanOrEqual(2);
    expect(ib.x + ib.width).toBeGreaterThanOrEqual(brand.x + brand.width);
    // The glyphs: each named in words (aria-label), the same words shown on hover. Live; Boxes dimmed by its alert;
    // the backup, not set up here.
    const icons = await p.locator('.loom-sys__icon').evaluateAll((es) => es.map((e) => ({ k: (e as HTMLElement).dataset.k, name: e.getAttribute('aria-label'), dim: e.hasAttribute('data-dim') })));
    expect(icons).toEqual([
      { k: 'signal', name: 'Live: connected to loom', dim: false },
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
    expect(await p.locator('.loom-sys__icon[data-k="boxes"]').getAttribute('href')).toBe('/p/boxes');
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

  it('a name with its ⓘ isn\'t cut short ("Boxes", not "Bo…")', async () => {
    const p = await device('neon', 'reduce', 390);
    await open(p, '/p/boxes');
    expect(await p.locator('.loom-pbar__title').evaluate((e) => ({ text: (e as HTMLElement).innerText, cut: e.scrollWidth > e.clientWidth }))).toEqual({ text: 'Boxes', cut: false });
    await p.context().close();
  }, 60_000);

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

  it('the ticker has more room and still moves only when its words overflow; reduced motion keeps it still', async () => {
    const p = await device('neon', 'no-preference', 1280);
    await open(p, '/');
    const tick = p.locator('.loom-tick');
    const state = () => tick.evaluate((e) => ({ run: e.hasAttribute('data-run'), w: e.clientWidth, over: (e.querySelector('.loom-tick__line') as HTMLElement).scrollWidth > e.clientWidth + 1 }));
    const s = await state();
    expect(s.w).toBeGreaterThan(500);
    expect(s.run).toBe(s.over);
    // Crowded, it moves.
    await tick.evaluate((e) => { (e as HTMLElement).style.flex = 'none'; (e as HTMLElement).style.width = '120px'; });
    await expect.poll(async () => (await state()).run).toBe(true);
    await p.context().close();

    const q = await device('neon', 'reduce', 1280);
    await open(q, '/');
    const t = q.locator('.loom-tick');
    await t.evaluate((e) => { (e as HTMLElement).style.flex = 'none'; (e as HTMLElement).style.width = '120px'; });
    await q.waitForTimeout(300);
    expect(await t.evaluate((e) => ({ run: e.hasAttribute('data-run'), name: getComputedStyle(e.querySelector('.loom-tick__track')!).animationName }))).toEqual({ run: false, name: 'none' });
    await q.context().close();
  }, 90_000);

  it('000h at 1280 px: the big header, no system bar, no phone bar', async () => {
    const p = await device('000h', 'reduce', 1280);
    await open(p, '/');
    expect(await p.locator('.loom-sys').count()).toBe(0);
    expect(await p.locator('.loom-pbar').count()).toBe(0);
    expect(await p.locator('.loom-top h1').evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(28);
    await p.context().close();
  }, 60_000);
});
