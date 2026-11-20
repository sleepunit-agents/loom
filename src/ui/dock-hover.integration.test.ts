/**
 * A dock key grown under the pointer (dock.tsx, 1.65x and lifted) is drawn whole, its name over it too (Jonathan,
 * 2026-11-05: "when the icons grow on hover, the top of them is cut off"): on the desktop shell at 1280 px and at a
 * phone's width with a mouse, for the first, a middle and the last key. Nothing that clips (an overflow or a clip-path,
 * up to the fixed dock bar) cuts either, and nothing over the dock (Find's pill) covers them. And nothing else moves:
 * the dock still scrolls sideways, and at rest its keys sit where they did, 10 px under the bar's rule. To a finger (a
 * real touch, pointerType "touch") nothing grows, and a held key's name sits right over it. Real Chrome, Neon Noir.
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

/** The key's visual and its name, as drawn, and whatever cuts or covers either. */
type Seen = { visualH: number; itemH: number; nameOpacity: number; gapOverKey: number; cut: string[]; covered: string[] };
function look(el: Element): Seen {
  const v = el.querySelector('[data-part="visual"]')!.getBoundingClientRect();
  const lab = el.querySelector('[data-part="label"]')!;
  const l = lab.getBoundingClientRect();
  const cut: string[] = [];
  const inside = (r: DOMRect, c: DOMRect) => r.top >= c.top - 0.5 && r.bottom <= c.bottom + 0.5 && r.left >= c.left - 0.5 && r.right <= c.right + 0.5;
  for (let a = el.parentElement; a; a = a.parentElement) {
    const cs = getComputedStyle(a);
    // The dock bar is fixed: past it, an overflow (the page's own) doesn't clip it.
    const last = cs.position === 'fixed';
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || cs.clipPath !== 'none') {
      const c = a.getBoundingClientRect(), what = a.getAttribute('data-part') ?? a.className.toString().slice(0, 40);
      if (!inside(v, c)) cut.push(`the key, by ${what}`);
      if (!inside(l, c)) cut.push(`its name, by ${what}`);
    }
    if (last) break;
  }
  // Nothing over the dock covers either: the key takes the pointer, so what's on top at its grown top is the key; its
  // name takes none (it can't be hit-tested), so whatever over the dock overlaps it (Find's pill) must sit under the bar.
  const covered: string[] = [];
  const top = document.elementFromPoint(v.left + v.width / 2, v.top + 4);
  if (top && !el.contains(top)) covered.push(`the key's top, by ${top.className.toString().slice(0, 40)}`);
  const bar = el.closest('.loom-dock-bar')!, barZ = Number(getComputedStyle(bar).zIndex) || 0;
  const meets = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  for (const over of document.querySelectorAll('.loom-find-pill')) {
    const r = over.getBoundingClientRect();
    if ((meets(r, l) || meets(r, v)) && (Number(getComputedStyle(over).zIndex) || 0) >= barZ) covered.push(`its name or the key, by ${over.className.toString().slice(0, 40)}`);
  }
  return { visualH: v.height, itemH: el.getBoundingClientRect().height, nameOpacity: +getComputedStyle(lab).opacity, gapOverKey: v.top - l.bottom, cut, covered };
}

describe.runIf(built && chrome)('a grown dock key', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-dock-hover-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db')); createConversationTables(db); db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
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

  async function device(width: number, touch: boolean): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: touch, isMobile: touch, reducedMotion: 'no-preference', serviceWorkers: 'block' });
    await ctx.addInitScript(() => { localStorage.setItem('loom-look', 'neon'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1'); });
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    await p.goto(`${base}/`);
    await p.locator('.loom-dock-bar [data-part="item"]').first().waitFor();
    await p.waitForTimeout(600);
    return p;
  }
  /** At rest: the keys' place under the bar's rule (the bar's top + 22 px, looks: .loom-dock-bar::before), and whether
   * the dock still scrolls sideways. */
  const rest = (p: Page) => p.evaluate(() => {
    const bar = document.querySelector('.loom-dock-bar')!.getBoundingClientRect();
    const item = document.querySelector('.loom-dock-bar [data-part="item"]')!.getBoundingClientRect();
    const vp = document.querySelector('.loom-dock-bar [data-part="viewport"]')!;
    return { underRule: item.top - (bar.top + 22), scrolls: ['auto', 'scroll'].includes(getComputedStyle(vp).overflowX) };
  });

  for (const width of [1280, 390]) {
    it(`${width} px, a mouse: the first, a middle and the last key, grown, are whole and uncovered, their names over them`, async () => {
      const p = await device(width, false);
      if (width === 1280) expect(await p.locator('.loom-desk').count(), 'the desktop shell').toBe(1);
      expect(await rest(p)).toEqual({ underRule: 10, scrolls: true });
      const items = p.locator('.loom-dock-bar [data-part="item"]');
      const n = await items.count();
      for (const i of [0, 1, n - 1]) {
        const item = items.nth(i);
        const b = (await item.boundingBox())!;
        await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
        await expect.poll(() => item.evaluate((el) => el.querySelector('[data-part="visual"]')!.getBoundingClientRect().height / el.getBoundingClientRect().height), { timeout: 4000 }).toBeGreaterThan(1.6);
        await p.waitForTimeout(300);
        const seen = await item.evaluate(look);
        const at = `${width} px, key ${i}`;
        expect(seen.nameOpacity, at).toBe(1);
        expect(seen.gapOverKey, at).toBeGreaterThanOrEqual(4);
        expect(seen.cut, at).toEqual([]);
        expect(seen.covered, at).toEqual([]);
      }
      // Away from the dock, nothing moved.
      await p.mouse.move(5, 5);
      await p.waitForTimeout(400);
      expect(await rest(p)).toEqual({ underRule: 10, scrolls: true });
      await p.context().close();
    }, 60_000);
  }

  it('390 px, a finger (a real touch): nothing grows, and a held key\'s name sits right over it', async () => {
    const p = await device(390, true);
    expect(await rest(p)).toEqual({ underRule: 10, scrolls: true });
    const item = p.locator('.loom-dock-bar [data-part="item"]').nth(1);
    const b = (await item.boundingBox())!;
    const cdp = await p.context().newCDPSession(p);
    const point = [{ x: b.x + b.width / 2, y: b.y + b.height / 2 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point });
    // A finger that wanders a little over the key, as one does: pointermoves, pointerType "touch".
    for (const dx of [2, 4, 2]) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point[0].x + dx, y: point[0].y }] });
    await p.waitForTimeout(900);
    expect(await item.evaluate((el) => (el as HTMLElement).style.getPropertyValue('--dock-item-scale')), 'no magnifying to a finger').toBe('1');
    const seen = await item.evaluate(look);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    expect(seen.visualH).toBeLessThan(seen.itemH * 1.1);
    // Where its name is held (whether it shows on a hold is the phone bar's test: phone-bar.integration.test.ts).
    expect(seen.gapOverKey).toBeGreaterThanOrEqual(4);
    expect(seen.gapOverKey).toBeLessThan(12);
    expect(seen.cut).toEqual([]);
    await p.context().close();
  }, 60_000);
});
