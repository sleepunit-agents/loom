/**
 * The agents' rail when the cards don't all fit (docs/specs/agent-desk.md, "Work"; t-1959 phase 2): the accordion. Each
 * agent folds to one line (face, name, a dot, ASK, a count) and one stays a card: the agent whose thread Comms shows,
 * else one in a conversation now, else one with an ask, else one with something unread, else the first. Nothing spills
 * past the rail; with room again, the cards come back. At 1280, 1440 and 1920 in all three looks. Needs `age`.
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

describe.runIf(built && chrome && hasAge)('the agents\' rail, folded', () => {
  let d: DeskHome;
  let browser: Browser;
  let rookT: Thread;
  const errors: string[] = [];

  beforeAll(async () => {
    if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    d = await deskHome({ art: 'Art E Fish', mark: 'Visual Mark', nova: 'Nova', pip: 'Pip', rook: 'Rook', wren: 'Wren' });
    // Pip has something unread, Rook an ask; Wren a thread of its own, read.
    const pipT = d.thread('jonathan', 'pip', 'Grocery list?', 'Grocery list');
    d.reply(pipT, 'Added. The list has 14 things on it now.');
    rookT = d.thread('jonathan', 'rook', 'How is Station 13?', 'Station 13 keeps dropping');
    d.ask('rook', 'Can I reboot Station 13 tonight?');
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  }, 90_000);
  afterAll(async () => { await browser?.close(); await d?.close(); });

  async function screen(w: number, h: number, path: string, look = 'neon'): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await ctx.addInitScript(`localStorage.setItem('loom-look', '${look}'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
    await ctx.request.post(`${d.base}/login`, { form: { token: d.tok.jonathan }, maxRedirects: 0 });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${d.base}${path}`);
    await p.locator('.loom-arail').waitFor();
    return p;
  }
  const opened = (p: Page) => p.$$eval('.loom-arail .loom-rcard', (cs) => cs.map((c) => c.getAttribute('data-agent')));
  const rows = (p: Page) => p.$$eval('.loom-arail .loom-rrow', (cs) => cs.map((c) => c.getAttribute('data-agent')));
  const fits = (p: Page) => p.locator('.loom-arail').evaluate((e) => e.scrollHeight <= e.clientHeight + 1);

  for (const look of ['neon', 'lowlight', 'daylight'] as const) for (const [w, h] of [[1280, 800], [1440, 900], [1920, 1080]] as const) {
    it(`at ${w}×${h} (${look}): six agents fold to lines, one card open (the ask's), alphabetical, nothing past the rail`, async () => {
      const p = await screen(w, h, '/inbox?t=*inbox', look);
      await expect.poll(() => p.locator('.loom-arail').getAttribute('data-fold')).toBe('true');
      expect(await opened(p)).toEqual(['rook']);
      expect(await rows(p)).toEqual(['art', 'nova', 'pip', 'mark', 'wren']);
      expect(await p.$$eval('.loom-arail [data-agent]', (cs) => cs.map((c) => c.getAttribute('data-agent')))).toEqual(['art', 'nova', 'pip', 'rook', 'mark', 'wren']);
      expect(await fits(p)).toBe(true);
      // A line says what's waiting: Pip's count, an ASK where there is one.
      expect(await p.locator('.loom-rrow[data-agent="pip"] .loom-rrow__n').textContent()).toBe('1');
      expect(await p.locator('.loom-rrow .loom-askb').count()).toBe(0);
      if (SHOTS) await p.screenshot({ path: `${SHOTS}/rail-fold-${look}-${w}.png` });
      await p.context().close();
    });
  }

  it('the open card is the agent whose thread Comms shows; a line opens its agent\'s thread', async () => {
    const p = await screen(1440, 900, '/inbox?t=*inbox');
    await expect.poll(() => opened(p)).toEqual(['rook']);
    await p.locator('.loom-rrow[data-agent="pip"]').click();
    await expect.poll(() => new URL(p.url()).pathname).toMatch(/^\/comms\/[a-z2-7]{10}$/);
    await p.locator('.loom-tile .comms-thread').waitFor();
    await expect.poll(() => opened(p)).toEqual(['pip']);
    // Comms on Rook's thread: Rook's card.
    await p.goto(`${d.base}/comms/${rookT.id.slice(3)}?t=inbox,*comms`);
    await p.locator('.loom-tile .comms-thread').waitFor();
    await expect.poll(() => opened(p)).toEqual(['rook']);
    // Comms closed: back to the ask's.
    await p.locator('.loom-tile[data-tile="/comms"] button[aria-label="Close Comms"]').click();
    await expect.poll(() => opened(p)).toEqual(['rook']);
    await p.context().close();
  });

  it('with room for every card, no fold', async () => {
    const p = await screen(1920, 2600, '/inbox?t=*inbox');
    await expect.poll(() => opened(p)).toEqual(['art', 'nova', 'pip', 'rook', 'mark', 'wren']);
    expect(await rows(p)).toEqual([]);
    expect(await p.locator('.loom-arail').getAttribute('data-fold')).toBeNull();
    // Shorter again: it folds.
    await p.setViewportSize({ width: 1920, height: 1080 });
    await expect.poll(() => rows(p)).toHaveLength(5);
    await p.context().close();
  });

  it('no page threw', () => { expect(errors).toEqual([]); });
});
