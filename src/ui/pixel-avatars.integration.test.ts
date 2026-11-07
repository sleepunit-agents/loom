/**
 * Pixel faces everywhere an agent's drawn face was (Jonathan, 2026-11-05: "anywhere we currently have the 0000h face
 * should be the pixel art guy now"; letter badges in history-style lists stay). In a real browser over a household where
 * Art has a sprite sheet and Mark has none, with something of Art's waiting: Home (its cards and what needs you), the
 * Inbox (its rows and an ask's sheet), Find, People, Art's own page, and the desktop at 1280 (its widgets and a window's
 * title). Art is pixels wherever his face shows, Mark is drawn; under 36 px Art is a still crop of his rest frame at a
 * whole-pixel scale (pixel-face.tsx PixelAvatar); with Pixel faces off everyone is drawn; nothing is wider than 390 px.
 *
 * Runs where the app is built (npm run build) and a Chrome is installed (GitHub's runners have one).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { agentDir, createToken, loadHousehold, manifestFromPixelLab, setSprite, type Household } from '../household.js';
import { createConversationTables, recordTurn, writeDigest } from '../backends/conversations.js';
import { closeAllBackends } from '../backends/index.js';
import { AVATAR_SIDE, avatarCrop, avatarScale } from '../../web/src/pixel-face';
import { checkSpriteManifest, HouseholdError } from '../household.js';
import { sheet } from './pixel-sheet.fixture.js';
import { openThread } from '../comms.js';
import { stopCommsWatch } from './comms-live.js';

const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);
const hasAge = spawnSync('sh', ['-c', 'command -v age && command -v age-keygen'], { encoding: 'utf-8' }).status === 0;

describe('a small pixel avatar', () => {
  it('is cut over the top of what\'s drawn in the rest frame, 24 pixels square, unless the manifest names its crop', () => {
    const m = { cell: [56, 84] as [number, number], states: { idle: { south: [{ row: 7, frames: 17, weight: 1 }] } } };
    // The fixture's figure: x 10 to 45, y 20 to 63.
    expect(avatarCrop(m, (x, y) => x >= 10 && x < 46 && y >= 20 && y < 64)).toEqual({ x: 16, y: 20, w: 24, h: 24 });
    expect(avatarCrop(m, () => false)).toEqual({ x: 16, y: 0, w: 24, h: 24 });
    expect(avatarCrop({ ...m, avatar: { x: 4, y: 6, w: 32, h: 32 } }, () => true)).toEqual({ x: 4, y: 6, w: 32, h: 32 });
  });
  it('a manifest\'s crop is kept, checked: whole pixels inside the cell, 8 or more across', () => {
    const m = { cell: [56, 84], states: { idle: { south: [{ row: 7, frames: 17, weight: 1 }] } } };
    expect(checkSpriteManifest({ ...m, avatar: { x: 4, y: 6, w: 32, h: 32 } }).avatar).toEqual({ x: 4, y: 6, w: 32, h: 32 });
    expect(checkSpriteManifest(m).avatar).toBeUndefined();
    for (const avatar of [{ x: 40, y: 0, w: 24, h: 24 }, { x: 0, y: 0, w: 4, h: 24 }, { x: 0.5, y: 0, w: 24, h: 24 }, { x: 0, y: 0, w: 24 }, 'top'])
      expect(() => checkSpriteManifest({ ...m, avatar }), JSON.stringify(avatar)).toThrow(HouseholdError);
  });
  it('is drawn at a whole-pixel scale: the nearest whole number, never under 1', () => {
    expect([22, 24, 28, 32, 35, 48].map((s) => avatarScale(s, 24))).toEqual([1, 1, 1, 1, 1, 2]);
  });
});

describe.runIf(built && chrome)('pixel faces wherever an agent\'s face shows', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  const saved: Record<string, string | undefined> = {};
  const errors: string[] = [];

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-pixel-avatars-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), a === 'art' ? '# Art E Fish\n' : '# Visual Mark\n');
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db')); createConversationTables(db); db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
    for (const k of ['LOOM_HOME', 'XDG_CONFIG_HOME']) saved[k] = process.env[k];
    process.env.LOOM_HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    h = loadHousehold(home)!;
    const { png, json } = sheet();
    setSprite(h, 'art', manifestFromPixelLab(JSON.parse(json.toString())), { 'sheet.png': png });
    token = createToken(h, { role: { kind: 'owner' }, label: 'jonathan' }).token;
    const art = agentDir(h, 'art');
    const conv = recordTurn(art, 'art', { venue: 'wake', place: 'lane:making', label: 't-738: sonarr', at: new Date().toISOString(), from: { kind: 'schedule' }, kind: 'wake' }, 'runtime:clock').conversation;
    writeDigest(art, { conversation: conv, run: 'r1' }, { summary: 'Checked.', needs_owner: { ask: 'OK to turn off the recycle bin on Sonarr for a quick rename?',
      why: 'Deleting a big show takes hours.', if_yes: 'I turn it off.', if_no: 'I plan a rework.', refs: ['t-738'] } } as never);
    // A Comms thread with Art, for its list (Comms keeps its words with age: without it, no thread, and that check waits).
    if (hasAge) openThread(h, process.env, h.members[0], { agent: 'art', id: 'cccccccccccccccc', text: 'Is the sheet in?' });
    handle = await startHttpServer({ contextDir: art, host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    stopCommsWatch();
    await handle?.close();
    await closeAllBackends();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (h) rmSync(h.home, { recursive: true, force: true });
  });

  async function device(width: number, pixel = true): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 800 }, reducedMotion: 'no-preference', serviceWorkers: 'block' });
    await ctx.addInitScript(() => {
      sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');
      // Every draw onto a small avatar's canvas, counted: one is drawn once and never again.
      const draw = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, ...a: unknown[]) {
        const c = this.canvas as HTMLCanvasElement;
        if (c.closest?.('.loom-pixel-avatar')) c.dataset.draws = String(Number(c.dataset.draws ?? 0) + 1);
        return (draw as (...x: unknown[]) => void).apply(this, a);
      } as typeof draw;
    });
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`${width}: ${e.message}`));
    // Home, not a page: a page on a desktop is a tile this device keeps, and the tests' Home would open beside it.
    await p.goto(`${base}/`);
    await p.locator('.loom-top h1').waitFor();
    const csrf = await p.evaluate(async () => ((await (await fetch('/appearance', { headers: { accept: 'application/json' } })).json()) as { chrome: { csrf: string } }).chrome.csrf);
    await p.evaluate(async ([c, px]) => { await fetch('/appearance/prefs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ _csrf: c, pixel: px }) }); }, [csrf, pixel] as const);
    return p;
  }
  /** Every face of Art's and Mark's showing: drawn (face.tsx) or pixels (pixel-face.tsx), with its size on screen. */
  const faces = (p: Page) => p.evaluate(() => {
    const vis = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const of = (sel: string) => [...document.querySelectorAll(sel)].filter(vis).map((e) => (e.getAttribute('aria-label') ?? '').split(',')[0]);
    const small = [...document.querySelectorAll<HTMLCanvasElement>('.loom-pixel-avatar canvas')].filter(vis).map((c) => ({
      who: c.getAttribute('aria-label'), w: c.width, h: c.height, shown: c.getBoundingClientRect().width, scale: Number(c.dataset.scale), box: c.parentElement!.getBoundingClientRect().width,
      render: getComputedStyle(c).imageRendering }));
    return { drawn: of('[data-slot="agent-face"]'), pixels: of('.loom-pixel-face canvas'), small, wide: document.documentElement.scrollWidth };
  });
  /**
   * Until the faces `check` will look for are showing and still: each small one scaled, and nothing round a face
   * moving. A fixed 900 ms wait (the arrive animation's length) read a widget that arrived late at its first frame,
   * scaled to .975 (t-1886): sizes are read once the finite animations on a face and what holds it have finished.
   */
  const settle = (p: Page, o: { art?: boolean; small?: boolean; drawnArt?: boolean } = {}) => p.waitForFunction((o) => {
    const vis = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const moving = (e: Element | null) => {
      for (; e; e = e.parentElement) if (e.getAnimations().some((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity)) return true;
      return false;
    };
    const art = (sel: string) => [...document.querySelectorAll(sel)].filter((e) => vis(e) && (e.getAttribute('aria-label') ?? '').startsWith('Art E Fish'));
    const small = [...document.querySelectorAll<HTMLCanvasElement>('.loom-pixel-avatar canvas')].filter(vis);
    const faces = [...document.querySelectorAll('.loom-pixel-face canvas, [data-slot="agent-face"]')].filter(vis);
    if (o.small && !small.length) return false;
    if (o.art !== false && !o.drawnArt && !art('.loom-pixel-face canvas').length) return false;
    if (o.drawnArt && !art('[data-slot="agent-face"]').length) return false;
    return small.every((c) => c.dataset.scale) && ![...small, ...faces].some(moving);
  }, o, { timeout: 15_000 });
  /** Art in pixels, never drawn; Mark drawn, never in pixels; each small one a 24-pixel crop at a whole-pixel scale. */
  function check(at: string, f: Awaited<ReturnType<typeof faces>>, o: { art?: boolean; small?: boolean } = {}) {
    if (f.wide !== undefined && at !== 'the desktop' && at !== 'a tile') expect(f.wide, `${at}: wider than 390`).toBeLessThanOrEqual(390);
    expect(f.drawn.filter((w) => w === 'Art E Fish'), `${at}: Art drawn`).toEqual([]);
    expect(f.pixels.filter((w) => w !== 'Art E Fish'), `${at}: someone else in pixels`).toEqual([]);
    if (o.art !== false) expect(f.pixels.filter((w) => w === 'Art E Fish').length, `${at}: Art in pixels`).toBeGreaterThan(0);
    if (o.small) expect(f.small.length, `${at}: a small one`).toBeGreaterThan(0);
    for (const s of f.small) {
      expect([s.w, s.h, s.render], at).toEqual([AVATAR_SIDE, AVATAR_SIDE, 'pixelated']);
      expect(Number.isInteger(s.scale) && s.scale >= 1, at).toBe(true);
      expect(s.shown, at).toBeCloseTo(AVATAR_SIDE * s.scale, 0);
      expect(s.scale, at).toBe(Math.max(1, Math.round(s.box / 24)));
    }
  }

  it('390 px: Home, the Inbox and an ask\'s sheet, Find, People and Art\'s page', async () => {
    const p = await device(390);
    for (const path of ['/', '/inbox', '/people', '/people/art', '/a/art']) {
      await p.goto(`${base}${path}`);
      await p.locator('.loom-top h1').waitFor();
      await settle(p, { small: path === '/inbox', art: path !== '/people' });
      const f = await faces(p);
      // People's list draws people as their letters (history-style: they stay); Art's own entry wears his face.
      check(path, f, { small: path === '/inbox', art: path !== '/people' });
      expect(f.wide, path).toBeLessThanOrEqual(390);
      if (path === '/') expect(f.drawn, 'Mark on Home').toContain('Visual Mark');
      // Art's window: his whole pixel face, alive, in its Neon frame (t-1925 D).
      if (path === '/a/art') expect(await p.locator('.loom-aghead .loom-faceframe canvas').count(), 'Art\'s window').toBeGreaterThan(0);
    }
    // An ask's sheet.
    await p.goto(`${base}/inbox`);
    await p.getByText('OK to turn off the recycle bin').first().click();
    // The open item (t-1925: the reader, over the list): who asks, by their face.
    await p.locator('.loom-split__reader .loom-inbox__from').waitFor();
    await settle(p);
    check('the open ask', await faces(p));
    await p.keyboard.press('Escape');
    // Find, asked for an agent.
    await p.goto(`${base}/`);
    await p.locator('.loom-find-pill').click();
    await p.locator('.loom-find input').fill('art');
    await p.locator('.loom-find [role="option"]', { hasText: 'Art E Fish' }).first().waitFor();
    await settle(p);
    check('Find', await faces(p));
    await p.context().close();
  }, 120_000);

  it('a small one is the rest frame\'s crop, pixel for pixel, drawn once and never again', async () => {
    const p = await device(390);
    await p.goto(`${base}/inbox`);
    await settle(p, { small: true });
    // The crop (x 16, y 20, 24 square) of the rest frame: cyan, with the rest frame's own magenta mark at (4, 1); a
    // squashed whole cell would have the cell's empty margin at its corners, another frame no mark.
    const px = await p.evaluate(() => { const c = document.querySelector<HTMLCanvasElement>('.loom-pixel-avatar canvas')!; const g = c.getContext('2d')!;
      const at = (x: number, y: number) => [...g.getImageData(x, y, 1, 1).data].join(','); return { tl: at(0, 0), mark: at(4, 1), off: at(6, 1), br: at(23, 23), draws: c.dataset.draws }; });
    expect(px).toEqual({ tl: '46,230,240,255', mark: '255,61,168,255', off: '46,230,240,255', br: '46,230,240,255', draws: '1' });
    await p.waitForTimeout(3000);
    expect(await p.evaluate(() => [...document.querySelectorAll<HTMLCanvasElement>('.loom-pixel-avatar canvas')].map((c) => c.dataset.draws))).toEqual(expect.arrayContaining(['1']));
    expect(await p.evaluate(() => [...document.querySelectorAll<HTMLCanvasElement>('.loom-pixel-avatar canvas')].every((c) => c.dataset.draws === '1'))).toBe(true);
    await p.context().close();
  }, 60_000);

  it('1280 px, the desktop: its widgets and a tile\'s title', async () => {
    const p = await device(1280);
    await p.goto(`${base}/`);
    await p.locator('.loom-desk-home').waitFor();
    await settle(p, { small: true });
    check('the desktop', await faces(p), { small: true });
    await p.goto(`${base}/inbox`);
    await p.locator('.loom-tile').waitFor();
    await settle(p, { small: true });
    check('a tile', await faces(p), { small: true });
    await p.context().close();
  }, 60_000);

  // A small place wears the agent's letter (t-1925 D, the app mockups): the pixel face is the one big picture.
  it.runIf(hasAge)('Comms\' thread list: each thread wears its agent\'s letter, not a cropped face', async () => {
    const p = await device(1280);
    await p.goto(`${base}/comms`);
    await p.locator('.comms-row').first().waitFor();
    const rows = await p.locator('.comms-row').count();
    expect(await p.locator('.comms-row .loom-letter').count()).toBe(rows);
    expect(await p.locator('.comms-row .loom-pixel-avatar').count()).toBe(0);
    await p.context().close();
  }, 60_000);

  it('Pixel faces off: everyone drawn, everywhere', async () => {
    const p = await device(390, false);
    for (const path of ['/', '/inbox', '/a/art']) {
      await p.goto(`${base}${path}`);
      await p.locator('.loom-top h1').waitFor();
      await settle(p, { drawnArt: true });
      const f = await faces(p);
      expect(f.pixels, path).toEqual([]);
      expect(f.drawn, path).toContain('Art E Fish');
    }
    await p.context().close();
  }, 60_000);

  it('no errors on the way', () => { expect(errors).toEqual([]); });
});
