/**
 * The Accessibility app (Jonathan, 2026-11-05: "lets do all except text size"), in a real browser at 390 px with touch,
 * under Neon and 000h: its tile is in More beside Appearance and in Find; Allow zoom has moved there from Appearance,
 * and a choice made before the move still holds; Reduce motion (Follow the phone, On, Off) is one switch for everything
 * that moves (a page's move, the ticker, the arrival, the faces): On stills them in a browser that asks for motion, Off
 * runs them in one that asks for less, and Follow obeys the phone as it changes; Higher contrast raises the tokens to
 * 7:1 for text and 4.5:1 for the quieter texts and edges, leaves no faded words and draws a stronger focus ring; the
 * choices follow the person to a second device before its first paint; and nothing is wider than 390 px.
 *
 * Runs where the app is built (npm run build) and a Chrome is installed (GitHub's runners have one).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import BetterSqlite3 from 'better-sqlite3';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { agentDir, createToken, loadHousehold, manifestFromPixelLab, setSprite, type Household } from '../household.js';
import { createConversationTables } from '../backends/conversations.js';
import { closeAllBackends } from '../backends/index.js';

const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);

type Look = 'neon' | '000h';
type Follow = 'follow' | 'on' | 'off';
type Prefs = { look?: Look; mode?: 'auto' | 'light' | 'dark'; zoom?: boolean; motion?: Follow; contrast?: Follow };

/** A PixelLab-style sheet (as pixel-face.integration.test.ts makes one): a cyan square in every cell, so each frame draws. */
function sheet(): { png: Buffer; json: Buffer } {
  const names = ['Error', 'Idle', 'Thinking', 'Done', 'Waiting'];
  const facings = ['south'];
  const [cw, ch, cols, rows] = [56, 84, 17, 1 + names.length * facings.length];
  const [w, h] = [cw * cols, ch * rows];
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [cx, cy] = [x % cw, y % ch];
    if (cx >= 10 && cx < 46 && cy >= 20 && cy < 64) raw.set([0x2e, 0xe6, 0xf0, 255], y * (w * 4 + 1) + 1 + x * 4);
  }
  const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  const json = Buffer.from(JSON.stringify({ character: { size: { width: 48, height: 48 } }, spritesheet: { cell_size: { width: cw, height: ch }, columns: cols,
    rows: [{ row: 0, type: 'rotations', frame_count: 8 }, ...names.flatMap((animation, i) => facings.map((direction, j) => ({ row: 1 + i * facings.length + j, type: 'animation', frame_count: 17, animation, direction })))] } }));
  return { png, json };
}

/** WCAG's contrast between two #rrggbb colours. */
function ratio(a: string, b: string): number {
  const lum = (h: string) => {
    const x = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(h.trim())?.[1];
    if (!x) throw new Error(`not a plain colour: ${h}`);
    const full = x.length === 3 ? [...x].map((c) => c + c).join('') : x;
    const [r, g, bl] = [0, 2, 4].map((i) => { const c = parseInt(full.slice(i, i + 2), 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe.runIf(built && chrome)('the Accessibility app', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  const saved = process.env.LOOM_HOME;
  /** Console errors on any page, any test (docs/specs/ui-app.md: the pages load with none). */
  const errors: string[] = [];

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-a11y-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), a === 'art' ? '# Art E Fish\n' : '# Visual Mark\n');
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db')); createConversationTables(db); db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
    process.env.LOOM_HOME = home;
    h = loadHousehold(home)!;
    token = createToken(h, { role: { kind: 'owner' }, label: 'jonathan' }).token;
    // Art wears a pixel face (it plays frames while motion is allowed); Mark keeps his drawn one.
    const { png, json } = sheet();
    setSprite(h, 'art', manifestFromPixelLab(JSON.parse(json.toString())), { 'sheet.png': png });
    handle = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await handle?.close();
    await closeAllBackends();
    if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved;
    if (h) rmSync(h.home, { recursive: true, force: true });
    expect(errors).toEqual([]);
  });

  type Seen = { moves: string[]; anims: string[]; arrived: boolean; first: { motion?: string; contrast?: string }; draws: number; wide: number };
  /**
   * A phone (390 × 844, touch) whose browser asks for `media` motion, signed in as the household's owner, with `prefs`
   * said to loom first as the person's. Watched: each page move's animations, whether the arrival ran, what <html>
   * was first given for motion and contrast (the boot script's, before the app), every frame a pixel face drew, and the
   * widest the document has been. `arrived` leaves the session's arrival already had (the default) or not.
   */
  async function phone(o: { media?: 'reduce' | 'no-preference'; prefs?: Prefs; arrive?: boolean; kept?: Record<string, string> } = {}): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: o.media ?? 'no-preference', isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    await ctx.addInitScript(([arrive, kept]) => {
      if (!arrive) sessionStorage.setItem('loom-arrived', '1');
      Math.random = () => 0;
      for (const [k, v] of Object.entries(kept as Record<string, string>)) if (!localStorage.getItem(`seeded:${k}`)) { localStorage.setItem(k, v); localStorage.setItem(`seeded:${k}`, '1'); }
      const w = window as unknown as { __seen: Seen };
      w.__seen = { moves: [], anims: [], arrived: false, first: {}, draws: 0, wide: 0 };
      const draw = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, ...a: unknown[]) { w.__seen.draws++; return (draw as (...x: unknown[]) => void).apply(this, a); } as typeof draw;
      const d = Document.prototype as unknown as { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };
      const orig = d.startViewTransition;
      if (orig) d.startViewTransition = function (this: Document, cb: () => void) {
        w.__seen.moves.push(document.documentElement.dataset.move ?? '');
        const vt = orig.call(this, cb);
        vt.ready.then(() => { for (const an of document.getAnimations()) if (((an.effect as KeyframeEffect).pseudoElement ?? '').endsWith('(loom-page)')) w.__seen.anims.push((an as CSSAnimation).animationName); }).catch(() => {});
        return vt;
      };
      // <html> may not be there yet when this runs: the document's, with its subtree, sees <html>'s attributes whenever.
      new MutationObserver(() => {
        const d = document.documentElement;
        if (!d) return;
        w.__seen.first.motion ??= d.dataset.motion; w.__seen.first.contrast ??= d.dataset.contrast;
        if ('arrive' in d.dataset) w.__seen.arrived = true;
      }).observe(document, { attributes: true, subtree: true, attributeFilter: ['data-motion', 'data-contrast', 'data-arrive'] });
      const watch = () => { w.__seen.wide = Math.max(w.__seen.wide, document.documentElement.scrollWidth); requestAnimationFrame(watch); };
      requestAnimationFrame(watch);
    }, [!!o.arrive, o.kept ?? {}] as const);
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`${p.url()}: ${m.text()}`); });
    if (o.prefs) await choose(p, o.prefs);
    return p;
  }
  /** Say the person's choices to loom, as the app saves them (from a page of loom's, with its anti-forgery token). */
  async function choose(p: Page, prefs: Prefs): Promise<void> {
    const r = await p.context().request.get(`${base}/accessibility`, { headers: { accept: 'application/json' } });
    const csrf = ((await r.json()) as { chrome: { csrf: string } }).chrome.csrf;
    const s = await p.context().request.post(`${base}/appearance/prefs`, { data: { _csrf: csrf, ...prefs }, headers: { origin: base } });
    expect(s.status(), JSON.stringify(prefs)).toBe(200);
  }
  const open = async (p: Page, path: string) => { await p.goto(`${base}${path}`); await p.locator('.loom-top h1').waitFor(); await p.waitForTimeout(500); };
  const seen = (p: Page) => p.evaluate(() => (window as unknown as { __seen: Seen }).__seen);
  const html = (p: Page) => p.evaluate(() => ({ motion: document.documentElement.dataset.motion, contrast: document.documentElement.dataset.contrast, look: document.documentElement.dataset.look }));
  const group = (p: Page, name: string) => p.getByRole('radiogroup', { name });
  const checked = (p: Page, name: string) => group(p, name).locator('[role="radio"][aria-checked="true"]').innerText();
  /** A finger's tap on a dock key (a phone's own touch events, as gestures.integration.test.ts taps). */
  const tapKey = async (p: Page, label: string) => {
    const b = (await p.locator(`.loom-dock-now [data-part="item"][aria-label="${label}"]`).boundingBox())!;
    const cdp = await p.context().newCDPSession(p);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  };

  /** What moves on a phone, as it is now: a page's move (Home to Places by the dock), the ticker, the faces. */
  async function motionOf(p: Page): Promise<{ move: string[]; ticker: string; drawnFaceLive: boolean; pixelDraws: number }> {
    await open(p, '/');
    await p.waitForTimeout(800);
    // The ticker (Neon's bar): its track's animation, when its words overflow (two agents' names and more do at 390 px).
    const ticker = await p.locator('.loom-tick__track').first().evaluate((t) => getComputedStyle(t).animationName).catch(() => 'absent');
    // Mark's drawn face is alive (data-live) only with motion; Art's pixel face plays frames only with motion.
    const drawnFaceLive = await p.locator('.loom-identity [data-slot="agent-face"]').first().evaluate((e) => e.hasAttribute('data-live'));
    // Art's pixel face: with motion, its first beat comes within a second (the page's dice are loaded: Math.random is 0)
    // and plays its frames; without, it draws its rest frame and nothing after.
    // Counted from its first frame (its sheet may still be on its way).
    await p.waitForFunction(() => (window as unknown as { __seen: Seen }).__seen.draws > 0, null, { timeout: 15_000 });
    const before = (await seen(p)).draws;
    await p.waitForTimeout(2600);
    const pixelDraws = (await seen(p)).draws - before;
    await p.evaluate(() => { (window as unknown as { __seen: Seen }).__seen.anims = []; });
    await tapKey(p, 'Places');
    await expect.poll(() => p.evaluate(() => location.pathname)).toBe('/places');
    await p.waitForTimeout(600);
    const s = await seen(p);
    if (!s.anims.length) console.log('no move seen', JSON.stringify({ moves: s.moves }));
    return { move: [...new Set(s.anims)].sort(), ticker, drawnFaceLive, pixelDraws };
  }
  const SLIDES = ['loom-move-give-left', 'loom-move-in-right'];
  const FADES = ['loom-move-fade-out', 'loom-move-name-in'];

  it('a tile of its own in More, beside Appearance, and in Find; its own page, with an intro behind its name', async () => {
    const p = await phone({ prefs: { look: 'neon', motion: 'follow', contrast: 'follow', zoom: false } });
    await open(p, '/setup');
    const tiles = await p.locator('main .loom-launch').evaluateAll((bs) => bs.map((b) => [b.querySelector('.w-full.truncate')?.textContent ?? '', b.querySelector('.loom-launch-tile')?.getAttribute('data-tint') ?? '']));
    const at = tiles.findIndex(([l]) => l === 'Accessibility');
    expect(at, JSON.stringify(tiles)).toBeGreaterThan(0);
    expect(tiles[at - 1][0]).toBe('Appearance');
    expect(tiles[at][1]).toBe('blue');
    await p.locator('main .loom-launch', { hasText: 'Accessibility' }).click();
    await expect.poll(() => p.evaluate(() => location.pathname)).toBe('/accessibility');
    expect(await p.locator('.loom-top h1').innerText()).toBe('Accessibility');
    expect(await group(p, 'Allow zoom').count()).toBe(1);
    expect(await group(p, 'Reduce motion').count()).toBe(1);
    expect(await group(p, 'Higher contrast').count()).toBe(1);
    // Its intro, behind its name in Neon's phone bar.
    await p.getByRole('button', { name: 'About Accessibility' }).click();
    await expect.poll(() => p.getByRole('dialog').innerText().catch(() => '')).toContain('Reduce motion and Higher contrast follow your phone');
    await p.keyboard.press('Escape');
    // Find has it among the apps, and finds it by name.
    await p.keyboard.press('Control+k');
    await p.locator('.loom-find input').fill('access');
    await p.locator('.loom-find [role="option"]', { hasText: 'Accessibility' }).first().waitFor();
    await p.locator('.loom-find [role="option"]', { hasText: 'Accessibility' }).first().click();
    await expect.poll(() => p.evaluate(() => location.pathname)).toBe('/accessibility');
    // 000h: the same page, its header with the line and the ⓘ.
    await choose(p, { look: '000h' });
    await open(p, '/accessibility');
    expect((await html(p)).look).toBe('000h');
    expect(await p.locator('.loom-top').innerText()).toContain('Make loom easier to see and use.');
    expect((await seen(p)).wide).toBeLessThanOrEqual(390);
    await p.context().close();
  }, 90_000);

  it('Allow zoom has moved from Appearance, and a choice made before the move still holds', async () => {
    // Chosen before the move: loom kept it as `zoom`, and this device kept loom-zoom.
    const p = await phone({ prefs: { look: 'neon', zoom: true }, kept: { 'loom-zoom': 'on' } });
    await open(p, '/appearance');
    expect(await group(p, 'Allow zoom').count()).toBe(0);
    for (const g of ['Look', 'Background', 'Sound', 'Haptics']) expect(await group(p, g).count(), g).toBe(1);
    // Appearance's line under Haptics, the gestures, stays.
    expect(await p.locator('#appearance .loom-gestures-hint').innerText()).toContain('swipe sideways');
    await open(p, '/accessibility');
    expect(await checked(p, 'Allow zoom')).toBe('On');
    expect(await p.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name="viewport"]')!.content)).not.toContain('user-scalable=no');
    // And on a device that never kept it: loom's copy.
    const q = await phone();
    await open(q, '/accessibility');
    await expect.poll(() => checked(q, 'Allow zoom')).toBe('On');
    await group(q, 'Allow zoom').getByRole('radio', { name: 'Off', exact: true }).click();
    await expect.poll(() => q.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name="viewport"]')!.content)).toContain('user-scalable=no');
    await p.context().close(); await q.context().close();
  }, 90_000);

  it('Reduce motion On, in a browser that asks for motion: pages crossfade, the ticker, the arrival and the faces are still', async () => {
    // The baseline: the same browser with motion allowed moves all of it.
    const free = await phone({ prefs: { look: 'neon', motion: 'follow', contrast: 'follow' } });
    const moving = await motionOf(free);
    expect(moving.move).toEqual(SLIDES);
    expect(moving.ticker).toBe('loom-tick');
    expect(moving.drawnFaceLive).toBe(true);
    expect(moving.pixelDraws).toBeGreaterThan(8);
    await free.context().close();

    // On, chosen on this device's Accessibility page.
    const p = await phone();
    await open(p, '/accessibility');
    await group(p, 'Reduce motion').getByRole('radio', { name: 'On', exact: true }).click();
    await expect.poll(async () => (await html(p)).motion).toBe('reduce');
    const still = await motionOf(p);
    expect(still.move).toEqual(FADES);
    expect(still.ticker).toBe('none');
    expect(still.drawnFaceLive).toBe(false);
    expect(still.pixelDraws).toBeLessThanOrEqual(1);
    await p.context().close();

    // The arrival, on a fresh session in a browser that asks for motion: skipped, from the first paint (boot.js, from
    // this device's copy) and on a device that has never been told (loom's copy, before the page paints).
    for (const kept of [{ 'loom-motion': 'on' }, {}]) {
      const q = await phone({ arrive: true, kept });
      await open(q, '/');
      await q.waitForTimeout(600);
      const s = await seen(q);
      expect(s.arrived, JSON.stringify(kept)).toBe(false);
      if (kept['loom-motion']) expect(s.first.motion).toBe('reduce');
      await q.context().close();
    }
  }, 120_000);

  it('Reduce motion Off, in a browser that asks for less: everything moves, the arrival too', async () => {
    const p = await phone({ media: 'reduce', prefs: { look: 'neon', motion: 'follow' } });
    const still = await motionOf(p);
    expect(still.move).toEqual(FADES);
    expect(still.ticker).toBe('none');
    await open(p, '/accessibility');
    await group(p, 'Reduce motion').getByRole('radio', { name: 'Off', exact: true }).click();
    await expect.poll(async () => (await html(p)).motion).toBe('full');
    const moving = await motionOf(p);
    expect(moving.move).toEqual(SLIDES);
    expect(moving.ticker).toBe('loom-tick');
    expect(moving.drawnFaceLive).toBe(true);
    expect(moving.pixelDraws).toBeGreaterThan(8);
    await p.context().close();
    // The arrival runs on a fresh session: from the first paint with this device's copy, and on a device that has
    // never been told once loom's copy lands (before the page paints).
    for (const kept of [{ 'loom-motion': 'off' }, {}]) {
      const q = await phone({ media: 'reduce', arrive: true, kept });
      await open(q, '/');
      await expect.poll(async () => (await seen(q)).arrived, JSON.stringify(kept)).toBe(true);
      expect((await seen(q)).first.motion).toBe(kept['loom-motion'] ? 'full' : 'reduce');
      await q.context().close();
    }
  }, 120_000);

  it('Follow the phone obeys the phone\'s setting, as it changes (motion and contrast)', async () => {
    const p = await phone({ prefs: { look: 'neon', motion: 'follow', contrast: 'follow' } });
    await open(p, '/accessibility');
    expect(await checked(p, 'Reduce motion')).toBe('Follow the phone');
    expect(await checked(p, 'Higher contrast')).toBe('Follow the phone');
    expect(await html(p)).toMatchObject({ motion: 'full', contrast: 'normal' });
    await p.emulateMedia({ reducedMotion: 'reduce', contrast: 'more' });
    await expect.poll(() => html(p)).toMatchObject({ motion: 'reduce', contrast: 'more' });
    expect((await motionOf(p)).move).toEqual(FADES);
    await p.emulateMedia({ reducedMotion: 'no-preference', contrast: 'no-preference' });
    await expect.poll(() => html(p)).toMatchObject({ motion: 'full', contrast: 'normal' });
    expect((await motionOf(p)).move).toEqual(SLIDES);
    // On and Off don't follow it.
    await open(p, '/accessibility');
    await group(p, 'Reduce motion').getByRole('radio', { name: 'Off', exact: true }).click();
    await p.emulateMedia({ reducedMotion: 'reduce' });
    await p.waitForTimeout(200);
    expect((await html(p)).motion).toBe('full');
    await p.context().close();
  }, 90_000);

  for (const [look, mode] of [['neon', 'dark'], ['000h', 'light'], ['000h', 'dark']] as const) {
    it(`Higher contrast, ${look === 'neon' ? 'Neon' : `000h ${mode}`}: the tokens rise to 7:1 and 4.5:1, no faded words, a stronger focus ring`, async () => {
      const p = await phone({ prefs: { look, mode, motion: 'follow', contrast: 'off' } });
      await open(p, '/accessibility');
      const TOKENS = ['--v-text', '--v-text-2', '--v-text-3', '--v-edge', '--v-border', '--v-canvas', '--v-paper', '--v-beige'];
      const tokens = () => p.evaluate((names) => Object.fromEntries(names.map((n) => [n, getComputedStyle(document.documentElement).getPropertyValue(n).trim()])), TOKENS);
      const before = await tokens();
      await group(p, 'Higher contrast').getByRole('radio', { name: 'On', exact: true }).click();
      await expect.poll(async () => (await html(p)).contrast).toBe('more');
      const t = await tokens();
      for (const n of ['--v-text-2', '--v-text-3', '--v-edge', '--v-border']) expect(t[n], n).not.toBe(before[n]);
      for (const s of ['--v-canvas', '--v-paper', '--v-beige']) {
        expect(ratio(t['--v-text'], t[s]), `text on ${s}`).toBeGreaterThanOrEqual(7);
        for (const f of ['--v-text-2', '--v-text-3', '--v-edge']) expect(ratio(t[f], t[s]), `${f} on ${s}`).toBeGreaterThanOrEqual(4.5);
        expect(ratio(t['--v-border'], t[s]), `border on ${s}`).toBeGreaterThanOrEqual(3);
      }
      // No words drawn faded, on the pages that use faded hints most: the page and its chrome (the bar, the dock, Find's
      // pill), and a drawn glyph (the bar's ⓘ, a ::before or ::after with content) as well as text.
      for (const path of ['/accessibility', '/appearance', '/setup', '/', '/inbox']) {
        await open(p, path);
        const faded = await p.evaluate(() => {
          const out: string[] = [];
          const chain = (el: Element, pseudo?: string) => { let o = pseudo ? Number(getComputedStyle(el, pseudo).opacity) : 1; for (let e: Element | null = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; };
          for (const el of document.body.querySelectorAll('*')) {
            if (!el.checkVisibility()) continue;
            for (const ps of ['::before', '::after']) {
              const c = getComputedStyle(el, ps).content;
              if (c && c !== 'none' && c !== 'normal' && c.replace(/["']/g, '').trim() && chain(el, ps) > 0 && chain(el, ps) < 1) out.push(`${el.className} ${ps} ${c} (${chain(el, ps).toFixed(2)})`);
            }
          }
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const el = n.parentElement;
            if (!el || !n.textContent?.trim() || !el.checkVisibility()) continue;
            let o = 1;
            for (let e: Element | null = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
            // 0 is hidden, not faded (Neon's dock names show on a hold; each key has its aria-label).
            if (o > 0 && o < 1) out.push(`${n.textContent.trim().slice(0, 30)} (${o.toFixed(2)})`);
          }
          return out;
        });
        expect(faded, path).toEqual([]);
      }
      // A stronger focus ring: 3 px, in the text's own colour.
      await open(p, '/accessibility');
      await group(p, 'Higher contrast').getByRole('radio', { name: 'On', exact: true }).focus();
      await p.keyboard.press('ArrowRight'); await p.keyboard.press('ArrowLeft');
      const ring = await p.evaluate(() => { const e = document.activeElement!; const s = getComputedStyle(e); return { w: s.outlineWidth, style: s.outlineStyle }; });
      expect(ring).toEqual({ w: '3px', style: 'solid' });
      // Neon's glows are off with it.
      if (look === 'neon') expect(await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--glow-key').trim())).toBe('0 0 0 0');
      expect((await seen(p)).wide).toBeLessThanOrEqual(390);
      await choose(p, { contrast: 'follow' });
      await p.context().close();
    }, 90_000);
  }

  it('the choices follow the person: a second device wears them before its first paint once it has heard', async () => {
    const phoneA = await phone({ prefs: { look: 'neon', motion: 'follow', contrast: 'follow', zoom: false } });
    await open(phoneA, '/accessibility');
    const saving = phoneA.waitForResponse((r) => r.url().endsWith('/appearance/prefs') && r.request().method() === 'POST');
    await group(phoneA, 'Reduce motion').getByRole('radio', { name: 'On', exact: true }).click();
    expect((await saving).status()).toBe(200);
    const saving2 = phoneA.waitForResponse((r) => r.url().endsWith('/appearance/prefs') && r.request().method() === 'POST');
    await group(phoneA, 'Higher contrast').getByRole('radio', { name: 'On', exact: true }).click();
    expect((await saving2).status()).toBe(200);

    // A second device, its own sign-in, nothing kept: it takes loom's copy, and keeps one.
    const laptop = await phone();
    await open(laptop, '/');
    await expect.poll(() => html(laptop)).toMatchObject({ motion: 'reduce', contrast: 'more' });
    expect(await laptop.evaluate(() => [localStorage.getItem('loom-motion'), localStorage.getItem('loom-contrast')])).toEqual(['on', 'on']);
    // From then on, its first paint has them (the boot script, before the app runs).
    await laptop.reload();
    await laptop.locator('.loom-top h1').waitFor();
    expect((await seen(laptop)).first).toEqual({ motion: 'reduce', contrast: 'more' });
    await open(laptop, '/accessibility');
    expect(await checked(laptop, 'Reduce motion')).toBe('On');
    expect(await checked(laptop, 'Higher contrast')).toBe('On');
    await choose(laptop, { motion: 'follow', contrast: 'follow' });
    await phoneA.context().close(); await laptop.context().close();
  }, 90_000);
});
