/**
 * Hiding the agents' rail and the dock (docs/specs/agent-desk.md, "Hiding"; t-1959 phase 4): a right-click on either
 * offers Always show, Minimize to strip and Auto-hide, kept per device. A strip brings it back; auto-hide brings it in
 * over the apps from its edge and away again, never moving the tiles; a glowing dot while anything is unread or asks.
 * With the rail hidden, Comms keeps its comm screen. Ctrl+Shift+N opens the Nth agent's thread. At 1280, 1440 and 1920
 * in all three looks. Needs `age`.
 *
 * Runs where the app is built (npm run build) and a Chrome is installed (GitHub's runners have one).
 */
import { describe, it, expect as vexpect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright-core';
import { deskHome, type DeskHome } from './agent-desk.fixture.js';
import type { Thread } from '../comms.js';

vi.setConfig({ testTimeout: 90_000 });
const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);
const hasAge = spawnSync('sh', ['-c', 'command -v age && command -v age-keygen'], { encoding: 'utf-8' }).status === 0;
const SHOTS = process.env.LOOM_DESK_SHOTS;
const expect = Object.assign(((v: unknown, m?: string) => vexpect(v, m)) as typeof vexpect, vexpect,
  { poll: (f: () => unknown, o?: { timeout?: number }) => vexpect.poll(f, { timeout: 10_000, ...o }) }) as typeof vexpect;
const KEY = (label: string) => `.loom-dock-bar [data-part="item"][aria-label="${label}"]`;

describe.runIf(built && chrome && hasAge)('hiding the agents\' rail and the dock', () => {
  let d: DeskHome;
  let browser: Browser;
  let markT: Thread;
  let artT: Thread;
  const errors: string[] = [];

  beforeAll(async () => {
    if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    d = await deskHome({ art: 'Art E Fish', mark: 'Visual Mark' });
    artT = d.thread('jonathan', 'art', 'Backups?', 'An offsite copy for the backup');
    markT = d.thread('jonathan', 'mark', 'The week?', 'Plan for the week');
    d.reply(markT, 'Ready for your review.');
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  }, 90_000);
  afterAll(async () => { await browser?.close(); await d?.close(); });

  async function screen(w: number, h: number, path: string, o: { look?: string; init?: string } = {}): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await ctx.addInitScript(`localStorage.setItem('loom-look', '${o.look ?? 'neon'}'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1'); ${o.init ?? ''}`);
    await ctx.request.post(`${d.base}/login`, { form: { token: d.tok.jonathan }, maxRedirects: 0 });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${d.base}${path}`);
    await p.locator('.loom-tiles').waitFor();
    return p;
  }
  const menu = (p: Page) => p.locator('[role="menu"].loom-cmenu');
  const items = (p: Page) => menu(p).locator('[role="menuitem"]').evaluateAll((es) => es.map((e) => e.textContent));
  const tileW = (p: Page) => p.locator('.loom-tile').first().evaluate((e) => Math.round(e.getBoundingClientRect().width));
  const kept = (p: Page, k: string) => p.evaluate((k) => localStorage.getItem(k), k);

  for (const look of ['neon', 'lowlight', 'daylight'] as const) for (const [w, h] of [[1280, 800], [1440, 900], [1920, 1080]] as const) {
    it(`at ${w}×${h} (${look}): right-click the rail, Minimize to strip; the tile takes the room, a dot glows, the strip brings it back`, async () => {
      const p = await screen(w, h, '/inbox?t=*inbox', { look });
      await p.locator('.loom-arail').waitFor();
      const before = await tileW(p);
      await p.locator('.loom-arail .loom-rcard').first().click({ button: 'right' });
      await menu(p).waitFor();
      expect(await menu(p).getAttribute('aria-label')).toBe('Agents rail');
      expect(await items(p)).toEqual(['Always showon', 'Minimize to strip', 'Auto-hide']);
      await menu(p).locator('[role="menuitem"]', { hasText: 'Minimize to strip' }).click();
      await p.locator('.loom-rstrip').waitFor();
      expect(await p.locator('.loom-arail').count()).toBe(0);
      expect(await tileW(p)).toBeGreaterThan(before + 250);
      expect(await kept(p, 'loom-rail')).toBe('strip');
      // Mark's reply is unread: the strip glows.
      await expect.poll(() => p.locator('.loom-rstrip .loom-glow').count()).toBe(1);
      if (SHOTS) await p.screenshot({ path: `${SHOTS}/strip-${look}-${w}.png` });
      // Kept for this device: a reload has the strip.
      await p.reload(); await p.locator('.loom-rstrip').waitFor();
      await p.locator('.loom-rstrip').click();
      await p.locator('.loom-arail').waitFor();
      expect(await kept(p, 'loom-rail')).toBe('always');
      await p.context().close();
    });
  }

  it('auto-hide: the tiles keep the whole width; the edge brings the rail in over them and leaving sends it away', async () => {
    const p = await screen(1440, 900, '/inbox?t=*inbox', { init: `localStorage.setItem('loom-rail', 'auto');` });
    await p.locator('.loom-redge').waitFor();
    expect(await p.locator('.loom-arail').count()).toBe(0);
    const full = await tileW(p);
    expect(full).toBeGreaterThan(1440 - 48 - 20);
    const edge = (await p.locator('.loom-redge').boundingBox())!;
    await p.mouse.move(edge.x + edge.width - 2, edge.y + edge.height / 2);
    await p.locator('.loom-arail.loom-arail--over').waitFor();
    // Its own width, over the apps: the tile didn't move.
    expect(Math.round((await p.locator('.loom-arail--over').boundingBox())!.width)).toBe(340);
    expect(await p.locator('.loom-arail--over .loom-rcard').count()).toBe(2);
    expect(await tileW(p)).toBe(full);
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/auto-peek-1440.png` });
    await p.mouse.move(200, 400);
    await expect.poll(() => p.locator('.loom-arail').count()).toBe(0);
    // Esc sends it away too.
    await p.mouse.move(edge.x + edge.width - 2, edge.y + edge.height / 2);
    await p.locator('.loom-arail--over').waitFor();
    await p.keyboard.press('Escape');
    await expect.poll(() => p.locator('.loom-arail').count()).toBe(0);
    await p.context().close();
  });

  it('with the rail hidden, Comms keeps its comm screen in the band', async () => {
    const p = await screen(1440, 900, `/comms/${markT.id.slice(3)}?t=*comms`, { init: `localStorage.setItem('loom-rail', 'strip');` });
    await p.locator('.comms-band .comms-screen').waitFor();
    expect(await p.locator('.loom-rscreen').count()).toBe(0);
    // Shown again: the rail's card is the screen, the band's goes.
    await p.locator('.loom-rstrip').click();
    await p.locator('.loom-rscreen[data-agent="mark"] .comms-screen').waitFor();
    expect(await p.locator('.comms-band .comms-screen').count()).toBe(0);
    await p.context().close();
  });

  it('the dock: right-click Home for its menu; Minimize to strip hides it and the desktop takes the room; Auto-hide comes up from the bottom edge', async () => {
    const p = await screen(1440, 900, '/');
    await p.locator(KEY('Home')).click({ button: 'right' });
    await menu(p).waitFor();
    expect(await menu(p).getAttribute('aria-label')).toBe('Dock');
    await menu(p).locator('[role="menuitem"]', { hasText: 'Minimize to strip' }).click();
    await p.locator('.loom-dstrip').waitFor();
    await expect.poll(() => p.locator('.loom-dock-bar').isVisible()).toBe(false);
    expect(await kept(p, 'loom-dock')).toBe('strip');
    const cards = await p.locator('.loom-bigcard').first().evaluate((e) => e.getBoundingClientRect().bottom);
    expect(cards).toBeGreaterThan(900 - 60);
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/dock-strip-1440.png` });
    await p.locator('.loom-dstrip').click({ button: 'right' });
    await menu(p).locator('[role="menuitem"]', { hasText: 'Auto-hide' }).click();
    await p.locator('.loom-dedge').waitFor();
    const bar = () => p.locator('.loom-dock-bar').evaluate((e) => Math.round(e.getBoundingClientRect().top));
    expect(await bar()).toBeGreaterThanOrEqual(900);
    await p.mouse.move(720, 897);
    await expect.poll(bar).toBeLessThan(900);
    await p.mouse.move(720, 300);
    await expect.poll(bar).toBeGreaterThanOrEqual(900);
    await p.context().close();
  });

  it('Ctrl+Shift+N opens the Nth agent\'s thread, in the cards\' order, typing or not', async () => {
    const p = await screen(1440, 900, '/');
    await p.locator('.loom-bigcard').first().waitFor();
    await p.keyboard.press('Control+Shift+Digit2');
    await expect.poll(() => new URL(p.url()).pathname).toBe(`/comms/${markT.id.slice(3)}`);
    await p.locator('.loom-tile .comms-composer textarea').focus();
    await p.keyboard.press('Control+Shift+Digit1');
    await expect.poll(() => new URL(p.url()).pathname).toBe(`/comms/${artT.id.slice(3)}`);
    // No third agent: nothing happens.
    await p.keyboard.press('Control+Shift+Digit3');
    await p.waitForTimeout(300);
    expect(new URL(p.url()).pathname).toBe(`/comms/${artT.id.slice(3)}`);
    await p.context().close();
  });

  it('under 1280 the rail is a strip whatever was chosen, and its strip brings it in over the apps', async () => {
    const p = await screen(1100, 800, '/inbox?t=*inbox');
    await p.locator('.loom-rstrip').click();
    await p.locator('.loom-arail--over').waitFor();
    expect(await kept(p, 'loom-rail')).toBeNull();
    await p.context().close();
  });

  it('no page threw', () => { expect(errors).toEqual([]); });
});
