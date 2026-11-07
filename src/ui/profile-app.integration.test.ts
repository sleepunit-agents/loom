/**
 * Profile (t-1925 G; web/src/account.tsx): who you are and how you sign in. Jonathan approved the mock with one change,
 * the name top LEFT: in a big window two columns, the left starting with the name card then the passkeys, whose header
 * carries a normal-size "Add a passkey" (never a full-width bar); the right their agents, notifications, another device
 * and Sign out. In a ~480 px tile and on a 390 px phone, one column, the name first. Measured, not eyeballed: bounding
 * boxes in real Chrome, Neon Noir.
 *
 * Runs where the app is built (npm run build) and a Chrome is installed (GitHub's runners have one).
 */
import { describe, it, expect as vexpect, beforeAll, afterAll, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { createToken, loadHousehold, type Household } from '../household.js';
import { createConversationTables } from '../backends/conversations.js';
import { closeAllBackends } from '../backends/index.js';
import { sessionStore } from './sessions.js';

const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);
const expect = Object.assign(((v: unknown, m?: string) => vexpect(v, m)) as typeof vexpect, vexpect,
  { poll: (f: () => unknown, o?: { timeout?: number }) => vexpect.poll(f, { timeout: 10_000, ...o }) }) as typeof vexpect;
const KEY = (label: string) => `.loom-dock-bar [data-part="item"][aria-label="${label}"]`;
type Box = { x: number; y: number; width: number; height: number };

describe.runIf(built && chrome)('Profile', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-profile-app-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db')); createConversationTables(db); db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', owner: 'jonathan',
      members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
    for (const k of ['LOOM_HOME', 'XDG_CONFIG_HOME', 'LOOM_PUBLIC_URL']) saved[k] = process.env[k];
    process.env.LOOM_HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    h = loadHousehold(home)!;
    token = createToken(h, { role: { kind: 'owner' }, label: 'jonathan' }).token;
    handle = await startHttpServer({ contextDir: join(home, 'agents', 'art'), host: '127.0.0.1', port: 0, household: h });
    // localhost is a secure origin, so this browser may add a passkey here: the header's button shows.
    base = `http://localhost:${handle.port}`;
    process.env.LOOM_PUBLIC_URL = base;
    const secret = createHash('sha256').update(token).digest('hex');
    for (const [id, label] of [['a1', 'MacBook Pro'], ['b2', 'iPhone']]) {
      sessionStore(home).addPasskey({ id, publicKey: 'x', alg: -7, counter: 0, label, created: Math.floor(Date.now() / 1000) - 86_400, secret });
    }
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await handle?.close();
    await closeAllBackends();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (h) rmSync(h.home, { recursive: true, force: true });
  });

  async function screen(width: number, height: number, path = '/account', mobile = false): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', serviceWorkers: 'block', ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
    await ctx.addInitScript(`if (!sessionStorage.getItem('t')) { sessionStorage.setItem('t', '1'); localStorage.setItem('loom-look', 'neon'); } sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    await p.goto(`${base}${path}`);
    await p.locator(path === '/' ? '.loom-tiles' : '[data-profile-name]').waitFor();
    await p.waitForTimeout(300);
    return p;
  }
  const box = async (p: Page, sel: string): Promise<Box> => (await p.locator(sel).first().boundingBox())!;
  const shot = async (p: Page, name: string) => { if (process.env.LOOM_PROFILE_SHOTS) await p.screenshot({ path: join(process.env.LOOM_PROFILE_SHOTS, `${name}.png`) }); };

  /** The name's card is the topmost thing in either column (two columns: level with the right's first panel; one
   * column: above every other panel), and the name is inside it. */
  const topLeft = async (p: Page, stacked = false) => {
    const me = await box(p, '.loom-profile__me');
    const name = await box(p, '[data-profile-name]');
    const tops = await p.$$eval('.loom-profile__col > *', (els) => els.map((e) => e.getBoundingClientRect().top));
    expect(me.y, 'the name card is the smallest top of the two columns').toBeLessThanOrEqual(Math.min(...tops) + 0.5);
    expect(name.y).toBeGreaterThanOrEqual(me.y);
    const others = await p.$$eval(stacked ? '.loom-profile__col > :not(.loom-profile__me)' : '.loom-profile__col:nth-child(1) > :not(.loom-profile__me)', (els) => els.map((e) => e.getBoundingClientRect().top));
    expect(name.y + name.height, 'the name sits above every other panel in its column').toBeLessThanOrEqual(Math.min(...others));
  };

  for (const [w, hgt] of [[1280, 800], [1920, 1080]]) {
    it(`a big window: two columns, the name top left, Add a passkey a normal button in the passkeys header, at ${w}×${hgt}`, async () => {
      const p = await screen(w, hgt);
      await shot(p, `profile-${w}`);
      // Real data: the member's name, what they are, since when (their oldest owner token), their agents and states.
      expect(await p.locator('[data-profile-name]').innerText()).toBe('Jonathan');
      expect(await p.locator('.loom-profile__role').innerText()).toMatch(/^Owner of the household · member since [A-Z][a-z]{2} \d{4}$/);
      const [left, right] = await Promise.all([box(p, '.loom-profile__col:nth-child(1)'), box(p, '.loom-profile__col:nth-child(2)')]);
      expect(right.x, 'two columns side by side').toBeGreaterThan(left.x + left.width - 1);
      const name = await box(p, '[data-profile-name]');
      const keys = await box(p, '.loom-profile__keys');
      expect(name.x, 'the name\'s left edge is left of the passkeys panel\'s right edge').toBeLessThan(keys.x + keys.width);
      expect(name.x, 'the name is in the left column').toBeLessThan(right.x);
      // Its top is the smallest of the two columns' contents: nothing sits above it, left or right.
      await topLeft(p);
      expect(keys.y, 'passkeys under the name').toBeGreaterThan(name.y);
      // Add a passkey: in the passkeys header, beside its title, not a full-width bar.
      const add = p.locator('.loom-profile__keys .loom-profile__head button', { hasText: 'Add a passkey' });
      expect(await add.count()).toBe(1);
      const a = (await add.boundingBox())!;
      expect(a.width).toBeLessThanOrEqual(240);
      const title = await box(p, '.loom-profile__keys .loom-profile__title');
      expect(a.y, 'the button is on the header\'s line').toBeLessThan(title.y + title.height);
      // The passkeys, each with Remove; the right column: your agents, then Sign out.
      expect(await p.locator('.loom-profile__keys .loom-profile__row-title').allInnerTexts()).toEqual(['MacBook Pro', 'iPhone']);
      expect(await p.locator('.loom-profile__keys button', { hasText: 'Remove' }).count()).toBe(2);
      const agents = p.locator('.loom-profile__col:nth-child(2) [aria-label="Your agents"] .loom-profile__row-title');
      expect((await agents.allInnerTexts()).length).toBe(2);
      expect(await p.locator('.loom-profile__col:nth-child(2) button', { hasText: 'Sign out' }).count()).toBe(1);
      // Adding opens a name field in the panel; Cancel puts the button back.
      await add.click();
      await p.locator('.loom-profile__keys input[aria-label="Name"]').waitFor();
      await p.locator('.loom-profile__keys button', { hasText: 'Cancel' }).click();
      await expect.poll(() => add.count()).toBe(1);
      await p.context().close();
    }, 60_000);
  }

  const oneColumn = async (p: Page) => {
    const [left, right] = await Promise.all([box(p, '.loom-profile__col:nth-child(1)'), box(p, '.loom-profile__col:nth-child(2)')]);
    expect(right.y, 'stacked').toBeGreaterThanOrEqual(left.y + left.height - 1);
    expect(Math.abs(right.x - left.x)).toBeLessThan(2);
    await topLeft(p, true);
    const a = (await p.locator('.loom-profile__head button', { hasText: 'Add a passkey' }).boundingBox())!;
    expect(a.width).toBeLessThanOrEqual(240);
    // No sideways scroll inside it.
    expect(await p.$eval('.loom-profile', (e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1);
  };

  it('a ~480 px tile beside others: one column, the name first', async () => {
    const p = await screen(1280, 800, '/');
    await p.click(KEY('Inbox'));
    await p.click(KEY('Comms'));
    await p.goto(`${base}/account${new URL(p.url()).search}`);
    await p.locator('[data-profile-name]').waitFor();
    await p.waitForTimeout(300);
    const w = (await box(p, '.loom-profile')).width;
    // Wherever the tiling put it, hold it at a narrow tile's width: the layout is the profile's own container query.
    if (w > 520) await p.$eval('.loom-profile', (e) => { (e as HTMLElement).style.width = '480px'; });
    await p.waitForTimeout(100);
    expect((await box(p, '.loom-profile')).width).toBeLessThanOrEqual(520);
    await shot(p, 'profile-tile-480');
    await oneColumn(p);
    await p.context().close();
  }, 60_000);

  it('a 390 px phone: one column, the name first', async () => {
    const p = await screen(390, 844, '/account', true);
    await shot(p, 'profile-390');
    await oneColumn(p);
    await p.context().close();
  }, 60_000);
});
