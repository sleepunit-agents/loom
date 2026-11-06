/**
 * Tiling, the only desktop (docs/specs/desk-tiling.md, criterion 18; "A fresh desktop", "One window at a time"). With
 * nothing chosen and nothing saved, a big screen is the tiled desktop, seeded; Appearance has no Desktop choice; the
 * old window is gone. One window at a time is Accessibility's: the same desktop, one app tile at most, opening another
 * sends the one there to the dock with a toast; turned on with two open, the focused one stays. A device that kept the
 * old choice as One window at a time (`loom-tiling` off) starts with it on. Real Chrome, Neon Noir.
 *
 * Runs where the app is built (npm run build) and a Chrome is installed (GitHub's runners have one).
 */
import { describe, it, expect as vexpect, beforeAll, afterAll, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });
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
const expect = Object.assign(((v: unknown, m?: string) => vexpect(v, m)) as typeof vexpect, vexpect,
  { poll: (f: () => unknown, o?: { timeout?: number }) => vexpect.poll(f, { timeout: 10_000, ...o }) }) as typeof vexpect;
const KEY = (label: string) => `.loom-dock-bar [data-part="item"][aria-label="${label}"]`;

describe.runIf(built && chrome)('tiling is the only desktop', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  /** One member per test that chooses (a choice is the person's, kept by loom, so it would choose for the next). */
  const tokens: Record<string, string> = {};
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-desk-tiling-only-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db')); createConversationTables(db); db.close();
    }
    const people = ['jonathan', 'sam', 'kim', 'lee'];
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', owner: 'jonathan',
      members: people.map((person) => ({ person, role: 'owner', agents: '*' })) }));
    for (const k of ['LOOM_HOME', 'XDG_CONFIG_HOME']) saved[k] = process.env[k];
    process.env.LOOM_HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    h = loadHousehold(home)!;
    for (const person of people) tokens[person] = createToken(h, { role: { kind: 'owner', ...(person === 'jonathan' ? {} : { member: person }) }, label: person }).token;
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

  /** A fresh device this size, signed in as `who`: nothing chosen, nothing saved, but what `init` puts there. */
  async function screen(width: number, height: number, who: string, o: { path?: string; init?: string } = {}): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await ctx.addInitScript(`if (!sessionStorage.getItem('t')) { sessionStorage.setItem('t', '1'); localStorage.setItem('loom-look', 'neon'); ${o.init ?? ''} } sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
    await ctx.request.post(`${base}/login`, { form: { token: tokens[who] }, maxRedirects: 0 });
    const p = await ctx.newPage();
    await p.goto(`${base}${o.path ?? '/'}`);
    await p.locator('.loom-tiles').waitFor();
    await p.waitForTimeout(300);
    return p;
  }
  const query = (p: Page, k: string) => new URL(p.url()).searchParams.get(k);
  const labels = (p: Page) => p.$$eval('.loom-tile', (ts) => ts.map((t) => (t.getAttribute('aria-label') ?? '').replace(/^tile \d+ of \d+, /, '')));
  const widgets = (p: Page) => p.$$eval('[data-widget]', (ws) => ws.map((w) => w.getAttribute('data-widget')));
  const toast = (p: Page, words: string) => p.getByText(words, { exact: false }).count();

  for (const [w, hgt] of [[1280, 800], [1920, 1080]]) {
    it(`18. a fresh session lands on the seeded widgets with no setting chosen; Appearance has no Desktop choice, at ${w}×${hgt}`, async () => {
      const p = await screen(w, hgt, 'jonathan');
      // The seed (widgets.ts SEED), the whole desktop: Needs you, each agent's card (its face), Vitals, Backup, the ticker.
      await expect.poll(() => widgets(p)).toEqual(['needs', 'art', 'mark', 'vitals', 'backup', 'ticker']);
      expect(query(p, 'w')).toBe('needs,art,mark,vitals,backup,ticker');
      expect(await p.locator('.loom-desk-home .loom-desk-headline').count()).toBe(1);
      expect(await p.locator('[data-widget="art"] .loom-agent__face').count()).toBe(1);
      expect(await p.locator('.loom-tile').count()).toBe(0);
      // No old window, ever: an app is a tile.
      await p.click(KEY('Setup'));
      await expect.poll(() => labels(p)).toEqual(['Setup']);
      expect(await p.locator('.loom-window').count()).toBe(0);
      const setup = p.locator('.loom-tile');
      await setup.locator('a, button', { hasText: 'Appearance' }).first().click();
      await setup.locator('[aria-label="Look"]').waitFor();
      expect(await setup.locator('[aria-label="Desktop"]').count()).toBe(0);
      expect(await setup.getByText('One window at a time').count()).toBe(0);
      await p.context().close();
    }, 60_000);
  }

  for (const [w, hgt, who] of [[1280, 800, 'sam'], [1920, 1080, 'kim']] as const) {
    it(`18. One window at a time, in Accessibility: one app tile, the next sends it to the dock with a toast; on with two open, the focused one stays, at ${w}×${hgt}`, async () => {
      const p = await screen(w, hgt, who);
      await p.click(KEY('Inbox')); await expect.poll(() => labels(p)).toEqual(['Inbox']);
      await p.click(KEY('Setup')); await expect.poll(() => labels(p)).toEqual(['Inbox', 'Setup']);
      // Accessibility, in the Setup tile (focused): turned on, the Inbox goes to the dock, at once and with no reload.
      const setup = p.locator('.loom-tile[aria-label$=", Setup"]');
      await setup.locator('a, button', { hasText: 'Accessibility' }).first().click();
      const choice = setup.locator('[aria-label="One window at a time"]');
      await choice.waitFor();
      await choice.locator('[role="radio"]', { hasText: 'On' }).click();
      await expect.poll(() => labels(p)).toEqual(['Setup']);
      expect(query(p, 'm')).toBe('inbox');
      // The widgets stay, beside the one app.
      expect((await widgets(p)).length).toBeGreaterThan(0);
      // Opening another: the one there goes to the dock, kept where it was, said in a toast.
      await p.click(KEY('Comms'));
      await expect.poll(() => labels(p)).toEqual(['Comms']);
      await expect.poll(() => toast(p, 'Setup went to the dock to make room for Comms: one window at a time is on')).toBeGreaterThan(0);
      expect(query(p, 'm')).toBe('inbox,setup');
      // Back from the dock: on the page it was on.
      await p.click(KEY('Setup'));
      await expect.poll(() => labels(p)).toEqual(['Setup']);
      await expect.poll(() => new URL(p.url()).pathname).toBe('/accessibility');
      await expect.poll(() => toast(p, 'Comms went to the dock to make room for Setup')).toBeGreaterThan(0);
      // It's the person's: a reload keeps it.
      await p.reload(); await p.locator('.loom-tiles').waitFor();
      await p.click(KEY('Inbox')); await expect.poll(() => labels(p)).toEqual(['Inbox']);
      // Off again: two tiles.
      await p.click(KEY('Setup')); await expect.poll(() => labels(p)).toEqual(['Setup']);
      await p.locator('[aria-label="One window at a time"] [role="radio"]', { hasText: 'Off' }).click();
      await p.click(KEY('Comms')); await expect.poll(() => labels(p)).toEqual(['Setup', 'Comms']);
      await p.context().close();
    }, 60_000);
  }

  it('18. a device that kept the old Desktop choice as One window at a time starts with it on', async () => {
    const p = await screen(1280, 800, 'lee', { init: `localStorage.setItem('loom-tiling', 'off');` });
    await p.click(KEY('Inbox')); await expect.poll(() => labels(p)).toEqual(['Inbox']);
    await p.click(KEY('Comms')); await expect.poll(() => labels(p)).toEqual(['Comms']);
    await expect.poll(() => toast(p, 'Inbox went to the dock to make room for Comms: one window at a time is on')).toBeGreaterThan(0);
    expect(await p.evaluate(() => localStorage.getItem('loom-tiling'))).toBe('off');
    await p.context().close();
  }, 60_000);
});
