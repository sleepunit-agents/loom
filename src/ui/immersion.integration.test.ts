/**
 * A phone's app, not a web page (Jonathan, 2026-11-05: "We need to disable anything that lets me break the illusion"),
 * in a real browser at 390 px with touch, in every look: the viewport doesn't zoom and iOS's pinch
 * (gesturestart) is turned down, unless the person allows zoom (Accessibility), and then neither is; every field is at
 * least 16 px, so iOS doesn't zoom in on focus; the app's chrome (the bar, the dock, Find's pill, buttons, chips, a
 * card's head) doesn't select and has no long-press menu or tap flash, while a message's words still select; the page
 * has no rubber band or pull to refresh, and its canvas is the app's own colour, which the browser's bar wears too; the
 * installed app holds portrait; and nothing is wider than 390 px.
 *
 * Chrome has no -webkit-touch-callout (it's iOS's), so that one is read through a stand-in: loom's own stylesheets,
 * fetched as shipped, with the property renamed to a custom property (which cascades and inherits as it does, media
 * queries and layers included), added to the page, and read off each element.
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
import { MANIFEST } from './pwa.js';

const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);

type Look = 'neon' | 'lowlight' | 'daylight';

describe.runIf(built && chrome)('a phone\'s app, not a web page', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  const saved = process.env.LOOM_HOME;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-immersion-'));
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
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await handle?.close();
    await closeAllBackends();
    if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved;
    if (h) rmSync(h.home, { recursive: true, force: true });
  });

  /** A phone (390 × 844, touch) in a look, with Allow zoom as given, said to loom as the person's Appearance; the widest
   * the document has been is watched. */
  async function phone(o: { look?: Look; zoom?: boolean; width?: number; touch?: boolean; fresh?: boolean } = {}): Promise<Page> {
    const look = o.look ?? 'neon';
    const touch = o.touch ?? true;
    const ctx = await browser.newContext({ viewport: { width: o.width ?? 390, height: 844 }, reducedMotion: 'reduce', isMobile: touch, hasTouch: touch, serviceWorkers: 'block' });
    await ctx.addInitScript((l) => {
      localStorage.setItem('loom-look', l); sessionStorage.setItem('loom-arrived', '1');
      const w = window as unknown as { __wide: number };
      w.__wide = 0;
      const watch = () => { w.__wide = Math.max(w.__wide, document.documentElement.scrollWidth); requestAnimationFrame(watch); };
      requestAnimationFrame(watch);
    }, look);
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    // A person who has never chosen anything, on a device that has never been told.
    if (o.fresh) return p;
    await p.goto(`${base}/appearance`);
    await p.locator('.loom-top h1').waitFor();
    const csrf = await p.evaluate(async () => ((await (await fetch('/appearance', { headers: { accept: 'application/json' } })).json()) as { chrome: { csrf: string } }).chrome.csrf);
    const prefs = { look, zoom: o.zoom ?? false };
    expect(await p.evaluate(async ([c, b]) => (await fetch('/appearance/prefs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ _csrf: c, ...b }) })).status, [csrf, prefs] as const)).toBe(200);
    return p;
  }
  const open = async (p: Page, path: string) => { await p.goto(`${base}${path}`); await p.locator('.loom-top h1').waitFor(); await p.waitForTimeout(800); };
  const wide = (p: Page) => p.evaluate(() => (window as unknown as { __wide: number }).__wide);
  const viewport = (p: Page) => p.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name="viewport"]')!.content);
  /** Whether a pinch iOS would start (its gesturestart, then gesturechange) is turned down. */
  const pinchStopped = (p: Page) => p.evaluate(() => ['gesturestart', 'gesturechange'].map((t) => {
    const e = new Event(t, { bubbles: true, cancelable: true });
    document.querySelector('main')!.dispatchEvent(e);
    return e.defaultPrevented;
  }));
  /** Each field on the page that takes words, by its font size. */
  const fields = (p: Page) => p.locator('input:not([type="hidden"], [type="checkbox"], [type="radio"]), textarea, select').evaluateAll((es) => es
    .filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => ({ what: e.getAttribute('aria-label') || e.id || e.tagName, px: parseFloat(getComputedStyle(e).fontSize) })));

  /** -webkit-touch-callout as iOS would compute it: loom's stylesheets again, with it renamed --loom-test-callout. */
  const standIn = (p: Page) => p.evaluate(async () => {
    let n = 0;
    for (const l of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
      const css = await (await fetch(l.href)).text();
      if (!/-webkit-touch-callout/.test(css)) continue;
      const s = document.createElement('style');
      s.textContent = css.replace(/-webkit-touch-callout(\s*):/g, '--loom-test-callout$1:');
      document.head.append(s);
      n++;
    }
    return n;
  });
  const callout = (p: Page, sel: string) => p.locator(sel).first().evaluate((e) => getComputedStyle(e).getPropertyValue('--loom-test-callout').trim() || 'default');
  const style = (p: Page, sel: string) => p.locator(sel).first().evaluate((e) => {
    const s = getComputedStyle(e);
    return { select: s.userSelect || s.webkitUserSelect, touch: s.touchAction, flash: s.getPropertyValue('-webkit-tap-highlight-color') };
  });

  // First, before any test has set this person's Appearance (they share one person, and run in order).
  it('Allow zoom is off by default: a person who has never chosen, on a device that has never been told', async () => {
    const p = await phone({ fresh: true });
    await open(p, '/accessibility');
    expect(await p.evaluate(() => localStorage.getItem('loom-zoom'))).toBeNull();
    const prefs = await p.evaluate(async () => ((await (await fetch('/appearance', { headers: { accept: 'application/json' } })).json()) as { chrome: { prefs: Record<string, unknown> } }).chrome.prefs);
    expect(prefs.zoom).toBeUndefined();
    expect(await viewport(p)).toContain('maximum-scale=1, user-scalable=no');
    expect(await pinchStopped(p)).toEqual([true, true]);
    await expect.poll(() => p.getByRole('radiogroup', { name: 'Allow zoom' }).getByRole('radio', { name: 'Off' }).getAttribute('aria-checked')).toBe('true');
    await p.context().close();
  }, 60_000);

  it('no zoom unless allowed: the viewport is capped and iOS\'s pinch is turned down; Allow zoom lifts both', async () => {
    const p = await phone({ look: 'neon' });
    await open(p, '/');
    expect(await viewport(p)).toBe('width=device-width, initial-scale=1.0, viewport-fit=cover, maximum-scale=1, user-scalable=no');
    expect(await pinchStopped(p)).toEqual([true, true]);
    // Pinch and double-tap zoom: the page only pans (main's and the bar's pan-y narrow it further).
    expect(await p.evaluate(() => getComputedStyle(document.documentElement).touchAction)).toBe('pan-x pan-y');
    expect(await p.evaluate(() => document.documentElement.dataset.zoom)).toBeUndefined();

    // Accessibility: Allow zoom, off by default, turned on here.
    await open(p, '/accessibility');
    const allow = p.getByRole('radiogroup', { name: 'Allow zoom' });
    await expect.poll(() => allow.getByRole('radio', { name: 'Off' }).getAttribute('aria-checked')).toBe('true');
    await allow.getByRole('radio', { name: 'On' }).click();
    await expect.poll(() => viewport(p)).toBe('width=device-width, initial-scale=1.0, viewport-fit=cover');
    expect(await pinchStopped(p)).toEqual([false, false]);
    expect(await p.evaluate(() => getComputedStyle(document.documentElement).touchAction)).toBe('auto');
    // Left alone means the page's too: gestures' pan-y gives way (double-tap, and a zoomed page pans sideways).
    expect(await p.evaluate(() => getComputedStyle(document.querySelector('main')!).touchAction)).toBe('auto');
    // It's the person's: a fresh load (and so any device they sign in on) has it.
    await open(p, '/');
    expect(await viewport(p)).toBe('width=device-width, initial-scale=1.0, viewport-fit=cover');
    expect(await pinchStopped(p)).toEqual([false, false]);
    // And off again.
    await open(p, '/accessibility');
    await allow.getByRole('radio', { name: 'Off' }).click();
    await expect.poll(() => viewport(p)).toContain('user-scalable=no');
    expect(await pinchStopped(p)).toEqual([true, true]);
    await p.context().close();

    // A device that has never heard of it takes loom's copy: here, allowed.
    const q = await phone({ look: 'lowlight', zoom: true });
    await q.evaluate(() => localStorage.removeItem('loom-zoom'));
    await open(q, '/');
    await expect.poll(() => viewport(q)).toBe('width=device-width, initial-scale=1.0, viewport-fit=cover');
    await q.context().close();
  }, 90_000);

  for (const look of ['neon', 'daylight'] as const) {
    it(`${look}: every field is at least 16 px, so iOS doesn't zoom in on focus (Find, an ask's reply, a form)`, async () => {
      const p = await phone({ look });
      const seen: { what: string; px: number }[] = [];
      // Find.
      await open(p, '/');
      await p.locator('.loom-find-pill').tap();
      await p.locator('.loom-find input').waitFor();
      seen.push(...await fields(p));
      await standIn(p);
      expect(await callout(p, '.loom-find input')).toBe('default');
      await p.keyboard.press('Escape');
      // An ask's reply, in its sheet.
      await open(p, '/inbox');
      await p.getByRole('button', { name: /recycle bin/ }).first().tap();
      await p.locator('#loom-reply').waitFor();
      seen.push(...await fields(p));
      await p.keyboard.press('Escape');
      // A form: a new fact's title, domain, words and source.
      await open(p, '/new-fact');
      seen.push(...await fields(p));
      const what = seen.map((f) => f.what);
      expect(what).toContain('Find anything');
      expect(what).toContain('loom-reply');
      expect(what).toContain('fact-add-body');
      expect(seen.length).toBeGreaterThanOrEqual(6);
      expect(seen.filter((f) => f.px < 16)).toEqual([]);
      // Find's own bigger words stay bigger.
      expect(seen.find((f) => f.what === 'Find anything')!.px).toBeGreaterThan(16);
      expect(await wide(p)).toBeLessThanOrEqual(390);
      await p.context().close();
    }, 90_000);

    it(`${look}: chrome doesn't select, flash or open a long-press menu; a message's words still select`, async () => {
      const p = await phone({ look });
      await open(p, '/');
      expect(await standIn(p)).toBeGreaterThan(0);
      const chromeParts = ['.loom-dock-bar [data-part="item"]', '.loom-top h1', '.loom-find-pill', 'main [data-slot="card"] button', 'main [data-slot="badge"]'];
      for (const sel of chromeParts) {
        const s = await style(p, sel);
        expect({ sel, select: s.select }).toEqual({ sel, select: 'none' });
        expect({ sel, flash: s.flash }).toEqual({ sel, flash: 'rgba(0, 0, 0, 0)' });
        expect({ sel, callout: await callout(p, sel) }).toEqual({ sel, callout: 'none' });
      }
      // The dock, Find's pill: a touch is theirs whole (gestures); the page pans and never zooms.
      expect((await style(p, '.loom-dock-bar [data-part="item"]')).touch).toBe('none');
      expect((await style(p, 'main')).touch).toBe('pan-y pinch-zoom');
      // The tap flash is gone from components too (base.css keeps the browser's on them).
      expect((await style(p, '[data-slot="card"]')).flash).toBe('rgba(0, 0, 0, 0)');

      // An ask's sheet: its words are content, and select; its buttons are chrome; its reply field takes words.
      await open(p, '/inbox');
      await p.getByRole('button', { name: /recycle bin/ }).first().tap();
      await p.locator('#loom-reply').waitFor();
      const dialog = '[role="dialog"]';
      const words = `${dialog} :is(p, h2, span):text-matches("Deleting a big show")`;
      expect((await style(p, words)).select).not.toBe('none');
      await standIn(p);
      expect(await callout(p, words)).toBe('default');
      // A field keeps iOS's own menu (Paste), even Find's, inside its label; and it selects.
      expect(await callout(p, '#loom-reply')).toBe('default');
      expect((await style(p, '#loom-reply')).select).toBe('text');
      expect((await style(p, `${dialog} button:text-is("Yes")`)).select).toBe('none');
      // A long press there selects the words: a real selection, made the way a finger makes one, isn't refused.
      const picked = await p.locator(words).first().evaluate((e) => { const r = document.createRange(); r.selectNodeContents(e); const s = getSelection()!; s.removeAllRanges(); s.addRange(r); return s.toString(); });
      expect(picked).toContain('Deleting a big show');
      // Links and images, even among a message's words, have no long-press menu, and images don't drag.
      await p.locator(words).first().evaluate((e) => { const a = document.createElement('a'); a.href = '/'; a.id = 't-link'; a.textContent = 'a link';
        const i = document.createElement('img'); i.id = 't-img'; e.append(a, i); });
      expect(await callout(p, '#t-link')).toBe('none');
      expect(await callout(p, '#t-img')).toBe('none');
      expect(await p.locator('#t-img').evaluate((i) => getComputedStyle(i).getPropertyValue('-webkit-user-drag'))).toBe('none');
      expect(await wide(p)).toBeLessThanOrEqual(390);
      await p.context().close();
    }, 90_000);
  }

  it('no flash, but a press still shows: a plain button dims while a finger is on it, and comes back after', async () => {
    const p = await phone({ look: 'neon' });
    await open(p, '/inbox');
    const row = p.getByRole('button', { name: /recycle bin/ }).first();
    const b = (await row.boundingBox())!;
    const opacity = () => row.evaluate((e) => getComputedStyle(e).opacity);
    expect(await opacity()).toBe('1');
    // Held (a pointer down, which is what :active follows; CDP's raw touches skip the tap gesture Chrome presses on).
    await p.mouse.move(b.x + 20, b.y + b.height / 2);
    await p.mouse.down();
    await expect.poll(opacity).toBe('0.72');
    await p.mouse.move(b.x + 20, b.y + 400);
    await p.mouse.up();
    await expect.poll(opacity).toBe('1');
    await p.context().close();
  }, 60_000);

  it('Android\'s long-press menu: turned down on a link, a key or a button by touch; a mouse\'s right click and a message\'s words are left alone', async () => {
    const p = await phone({ look: 'neon' });
    await open(p, '/');
    const menu = (sel: string, pointerType: string) => p.locator(sel).first().evaluate((e, pt) => {
      const ev = new PointerEvent('contextmenu', { bubbles: true, cancelable: true, pointerType: pt });
      e.dispatchEvent(ev);
      return ev.defaultPrevented;
    }, pointerType);
    expect(await menu('.loom-dock-bar [data-part="item"]', 'touch')).toBe(true);
    expect(await menu('main [data-slot="card"] button', 'touch')).toBe(true);
    expect(await menu('.loom-pbar__needs', 'touch')).toBe(true);
    expect(await menu('.loom-dock-bar [data-part="item"]', 'mouse')).toBe(false);
    await open(p, '/inbox');
    await p.getByRole('button', { name: /recycle bin/ }).first().tap();
    await p.locator('#loom-reply').waitFor();
    expect(await menu('[role="dialog"] :is(p, span):text-matches("Deleting a big show")', 'touch')).toBe(false);
    expect(await menu('#loom-reply', 'touch')).toBe(false);
    await p.context().close();
  }, 60_000);

  for (const [look, mode, canvas] of [['neon', 'dark', '#07070c'], ['lowlight', 'dark', '#15171a'], ['daylight', 'light', '#f5f3ee']] as const) {
    it(`${look}: no rubber band or pull to refresh, the canvas past the edges is the app's, and the browser's bar wears it`, async () => {
      const p = await phone({ look });
      await open(p, '/');
      await expect.poll(() => p.evaluate(() => document.documentElement.dataset.mode)).toBe(mode);
      const page = await p.evaluate(() => {
        const [h, b] = [document.documentElement, document.body].map((e) => getComputedStyle(e));
        return { html: h.overscrollBehaviorY + ' ' + h.overscrollBehaviorX, body: b.overscrollBehaviorY + ' ' + b.overscrollBehaviorX, bg: b.backgroundColor, htmlBg: h.backgroundColor,
          text: h.getPropertyValue('-webkit-text-size-adjust') || h.getPropertyValue('text-size-adjust') };
      });
      expect(page.html).toBe('none none');
      expect(page.body).toBe('none none');
      expect(page.text).toBe('100%');
      const hex = (c: string) => '#' + (c.match(/\d+/g) ?? []).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('');
      // Past the edges the browser paints body's background (<html> has none, so it's body's that reaches the canvas).
      expect(hex(page.bg)).toBe(canvas);
      expect(page.htmlBg).toBe('rgba(0, 0, 0, 0)');
      // The theme colour, whatever the device prefers: the look as it's worn.
      const bars = await p.evaluate(() => [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map((m) => m.content.toLowerCase()));
      expect(bars.length).toBeGreaterThan(0);
      expect(new Set(bars)).toEqual(new Set([canvas]));
      // iOS's home-screen status bar: black-translucent, the page under it (the phone bar expects it).
      expect(await p.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-status-bar-style"]')?.content)).toBe('black-translucent');
      expect(await wide(p)).toBeLessThanOrEqual(390);
      await p.context().close();
    }, 60_000);
  }

  it('inner scrollers keep scrolling: Find\'s list still scrolls on its own', async () => {
    const p = await phone({ look: 'neon' });
    await open(p, '/');
    await p.locator('.loom-find-pill').tap();
    const list = p.locator('#loom-find-list');
    await list.waitFor();
    const s = await list.evaluate((e) => ({ overflow: getComputedStyle(e).overflowY, over: getComputedStyle(e).overscrollBehaviorY }));
    expect(s.overflow).toBe('auto');
    expect(s.over).toBe('contain');
    await p.context().close();
  }, 60_000);

  it('the installed app holds portrait, its splash Neon\'s canvas', () => {
    const m = JSON.parse(MANIFEST) as { orientation?: string; background_color?: string; theme_color?: string; display?: string };
    expect(m).toMatchObject({ orientation: 'portrait', display: 'standalone', background_color: '#07070C', theme_color: '#07070C' });
  });

  it('a desktop keeps its browser\'s ways: a trackpad\'s pinch (a Mac\'s Safari fires gesturestart too) and a right click', async () => {
    const p = await phone({ look: 'neon', width: 1280, touch: false });
    await open(p, '/');
    expect(await p.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(false);
    expect(await pinchStopped(p)).toEqual([false, false]);
    expect(await p.evaluate(() => getComputedStyle(document.documentElement).touchAction)).toBe('auto');
    const ev = await p.locator('main').evaluate((e) => { const x = new PointerEvent('contextmenu', { bubbles: true, cancelable: true, pointerType: 'mouse' }); e.dispatchEvent(x); return x.defaultPrevented; });
    expect(ev).toBe(false);
    await p.context().close();
  }, 60_000);
});
