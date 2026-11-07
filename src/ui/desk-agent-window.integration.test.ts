/**
 * An agent's window (t-1925 D; the app mockups, 2026-11-06): its pixel face in a Neon frame and no 000h shapes, its
 * name with a working pill, a plain description (never its creed) its owner edits in place, its sections as a sidebar
 * inside the window (an icon rail when the window is narrow), a letter in the window's corner, and its desk card and
 * its window one app at two sizes: Expand grows the card into the window, Shrink folds it back. A phone keeps the
 * dock's swap, with the same header. Real Chrome.
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
const SHOTS = process.env.LOOM_SHOTS;
const CREED = 'You are Art E Fish, a persistent personal assistant with a creed.';

describe.runIf(built && chrome)('an agent\'s window', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  const tokens: Record<string, string> = {};
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-desk-agent-window-'));
    for (const [a, name] of [['art', 'Art E Fish'], ['mark', 'Visual Mark']]) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${name}\n\n${a === 'art' ? CREED : 'You are Mark.'}\n`);
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db')); createConversationTables(db); db.close();
    }
    // Jonathan owns the household; Sam owns Art only (an agent owner: sees the description, can't change it).
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', owner: 'jonathan',
      members: [{ person: 'jonathan', role: 'owner', agents: '*' }, { person: 'sam', role: 'owner', agents: ['art'] }] }));
    for (const k of ['LOOM_HOME', 'XDG_CONFIG_HOME']) saved[k] = process.env[k];
    process.env.LOOM_HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    h = loadHousehold(home)!;
    tokens.jonathan = createToken(h, { role: { kind: 'owner' }, label: 'jonathan' }).token;
    tokens.sam = createToken(h, { role: { kind: 'owner', member: 'sam' }, label: 'sam' }).token;
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

  async function screen(width: number, height: number, path: string, o: { who?: string; motion?: 'reduce' | 'no-preference'; look?: string } = {}): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: o.motion ?? 'reduce', serviceWorkers: 'block', ...(width < 600 ? { hasTouch: true, isMobile: true } : {}) });
    await ctx.addInitScript(`if (!sessionStorage.getItem('t')) { sessionStorage.setItem('t', '1'); localStorage.setItem('loom-look', '${o.look ?? 'neon'}'); } sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
    await ctx.request.post(`${base}/login`, { form: { token: tokens[o.who ?? 'jonathan'] }, maxRedirects: 0 });
    const p = await ctx.newPage();
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    (p as Page & { errors: string[] }).errors = errors;
    await p.goto(`${base}${path}`);
    await p.waitForTimeout(400);
    return p;
  }
  const win = (p: Page, agent = 'art') => p.locator(`.loom-tile[data-tile="/a/${agent}"] .loom-agentwin`);
  const labels = (p: Page) => p.$$eval('.loom-tile', (ts) => ts.map((t) => (t.getAttribute('aria-label') ?? '').replace(/^tile \d+ of \d+, /, '')));
  const shot = async (p: Page, name: string) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/agent-${name}.png` }); };

  for (const [w, hgt] of [[1280, 800], [1920, 1080]] as const) {
    it(`a window: its face framed, no shapes, no creed; a letter in its corner; its sections down the side, at ${w}×${hgt}`, async () => {
      const p = await screen(w, hgt, '/a/art?t=*art');
      const aw = win(p);
      await aw.waitFor();
      await shot(p, `${w}`);
      // The header: the face in its frame, its name; no profile card, no shapes, no clock stat, no creed.
      expect(await aw.locator('.loom-aghead .loom-faceframe').count()).toBe(1);
      expect(await aw.locator('.loom-aghead__name').textContent()).toMatch(/^Art E Fish/);
      expect(await p.locator('.loom-tile .loom-profile, .loom-tile .loom-profile__shape').count()).toBe(0);
      expect(await p.locator('.loom-tile').textContent()).not.toContain('persistent personal assistant');
      // No clock element in the header: no time, no "clock".
      expect(await aw.locator('.loom-aghead').textContent()).not.toMatch(/\bclock\b|\b\d{1,2}:\d\d\b/i);
      // The window's corner: a letter, not a cropped face.
      expect(await p.locator('.loom-tile[data-tile="/a/art"] .loom-tile__bar .loom-letter').textContent()).toBe('A');
      // Its sections, from its own tabs, down the side; Today is the one it's on.
      const nav = aw.locator('nav.loom-agentwin__nav');
      expect(await nav.locator('a').allInnerTexts()).toEqual(expect.arrayContaining(['Today', 'Mind', 'Setup']));
      expect(await nav.locator('a[aria-current="page"]').textContent()).toBe('Today');
      // A section opens in the same window: the dock doesn't swap, no second tile.
      await nav.locator('a', { hasText: 'Mind' }).click();
      await expect.poll(() => new URL(p.url()).pathname).toBe('/a/art/mind');
      await expect.poll(() => nav.locator('a[aria-current="page"]').textContent()).toBe('Mind');
      expect(await labels(p)).toEqual(['Art E Fish']);
      expect(await p.locator('.loom-agent-dock').count()).toBe(0);
      // The header stays on its other sections.
      expect(await aw.locator('.loom-aghead__name').count()).toBe(1);
      expect((p as Page & { errors: string[] }).errors).toEqual([]);
      await p.context().close();
    });
  }

  it('a narrow window (about 480 px): its sections are an icon rail, every one still named for a screen reader', async () => {
    const p = await screen(1280, 800, '/inbox?t=inbox,comms,*art');
    const aw = win(p);
    await aw.waitFor();
    const width = await p.locator('.loom-tile[data-tile="/a/art"]').evaluate((e) => e.getBoundingClientRect().width);
    expect(width).toBeLessThan(640);
    await expect.poll(() => aw.getAttribute('data-narrow')).toBe('true');
    await shot(p, 'narrow');
    const nav = aw.locator('nav.loom-agentwin__nav');
    expect(await nav.evaluate((n) => n.getBoundingClientRect().width)).toBeLessThan(64);
    expect(await nav.locator('a').first().getAttribute('aria-label')).toBe('Today');
    expect(await nav.locator('.loom-agentwin__navlabel').first().evaluate((e) => e.getBoundingClientRect().width)).toBeLessThanOrEqual(1);
    // Nothing sideways.
    expect(await p.locator('.loom-tile[data-tile="/a/art"] .loom-tile__body').evaluate((b) => b.scrollWidth - b.clientWidth)).toBeLessThanOrEqual(1);
    await p.context().close();
  });

  it('the description: the owner writes it in place, it stays; an agent owner reads it and can\'t change it', async () => {
    const p = await screen(1280, 800, '/a/art?t=*art');
    const aw = win(p);
    await aw.waitFor();
    expect(await aw.locator('.loom-aghead__none').textContent()).toBe('No description yet.');
    await aw.getByRole('button', { name: 'Write one' }).click();
    const box = aw.getByLabel('Art E Fish\'s description');
    await box.fill('Art keeps the house running: backups, machines and the task list, with you.');
    await aw.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => aw.locator('.loom-aghead__desc p').first().textContent()).toBe('Art keeps the house running: backups, machines and the task list, with you.');
    // Esc on an edit puts it back as it was.
    await aw.getByRole('button', { name: 'Edit' }).click();
    await aw.getByLabel('Art E Fish\'s description').fill('Not this.');
    await p.keyboard.press('Escape');
    expect(await aw.locator('.loom-aghead__desc p').first().textContent()).toBe('Art keeps the house running: backups, machines and the task list, with you.');
    await p.reload(); await win(p).waitFor();
    expect(await win(p).locator('.loom-aghead__desc p').first().textContent()).toBe('Art keeps the house running: backups, machines and the task list, with you.');
    await p.context().close();
    // Sam owns Art, not the household: the words, no Edit, no Regenerate.
    const s = await screen(1280, 800, '/a/art?t=*art', { who: 'sam' });
    await win(s).waitFor();
    await expect.poll(() => win(s).locator('.loom-aghead__desc p').first().textContent()).toBe('Art keeps the house running: backups, machines and the task list, with you.');
    expect(await win(s).getByRole('button', { name: /Edit|Regenerate|Write one|to write it/ }).count()).toBe(0);
    await s.context().close();
  });

  for (const motion of ['no-preference', 'reduce'] as const) {
    it(`the card grows into the window and folds back (motion: ${motion})`, async () => {
      const p = await screen(1920, 1080, '/?w=needs,art,mark', { motion });
      await p.locator('[data-widget="art"]').waitFor();
      // The trip: an outline in the agent's colour travels from the card to the window, with motion; none without.
      const trip = p.waitForSelector('.loom-morph', { state: 'attached', timeout: 2000 }).then(() => true, () => false);
      await p.locator('[data-widget="art"] button[aria-label="Expand Art E Fish into its window"]').click();
      expect(await trip).toBe(motion === 'no-preference');
      await win(p).waitFor();
      expect(await labels(p)).toEqual(['Art E Fish']);
      // The card stands aside while its window is open (one app at two sizes); Mark's stays.
      await expect.poll(() => p.locator('[data-widget="art"]').count()).toBe(0);
      expect(await p.locator('[data-widget="mark"]').count()).toBe(1);
      await p.locator('.loom-tile[data-tile="/a/art"] button[aria-label="Shrink Art E Fish to its card"]').click();
      await expect.poll(() => p.locator('.loom-tile').count()).toBe(0);
      await p.locator('[data-widget="art"]').waitFor();
      expect(new URL(p.url()).searchParams.get('w')).toBe('needs,art,mark');
      await p.waitForTimeout(400);
      expect(await p.locator('.loom-morph').count()).toBe(0);
      await p.context().close();
    });
  }

  it('Shrink to widget with no card on the desktop puts one there', async () => {
    const p = await screen(1280, 800, '/a/art?t=*art&w=needs');
    await p.locator('.loom-tile[data-tile="/a/art"] button[aria-label="Shrink Art E Fish to its card"]').click();
    await expect.poll(() => p.locator('[data-widget="art"]').count()).toBe(1);
    expect(new URL(p.url()).searchParams.get('w')).toBe('needs,art');
    await p.context().close();
  });

  it('a phone: the same header, no sidebar; the dock keeps the agent\'s sections', async () => {
    const p = await screen(390, 844, '/a/art');
    await p.locator('.loom-agentwin').waitFor();
    await shot(p, '390');
    expect(await p.locator('.loom-agentwin nav.loom-agentwin__nav').count()).toBe(0);
    expect(await p.locator('.loom-aghead .loom-faceframe').count()).toBe(1);
    expect(await p.locator('.loom-agent-dock').count()).toBe(1);
    expect(await p.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await p.context().close();
  });

  for (const look of ['neon', 'lowlight', 'daylight']) {
    it(`reads in ${look}`, async () => {
      const p = await screen(1280, 800, '/a/art?t=*art', { look });
      await win(p).waitFor();
      await shot(p, look);
      const ratio = await p.evaluate(() => {
        const px = (c: string) => { const x = document.createElement('canvas').getContext('2d')!; x.fillStyle = c; x.fillRect(0, 0, 1, 1); return [...x.getImageData(0, 0, 1, 1).data].slice(0, 3); };
        const lum = (c: number[]) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const ratio = (sel: string) => {
          const node = document.querySelector(sel)!;
          let el: Element | null = node;
          let bg = 'rgba(0, 0, 0, 0)';
          while (el && /rgba\(0, 0, 0, 0\)|transparent/.test(bg)) { bg = getComputedStyle(el).backgroundColor; el = el.parentElement; }
          const [a, b] = [lum(px(bg)), lum(px(getComputedStyle(node).color))].sort((x, y) => y - x);
          return (a + 0.05) / (b + 0.05);
        };
        // The name, and the description (owner: "No description yet."), each against what's behind it.
        return Math.min(ratio('.loom-aghead__name'), ratio('.loom-aghead__desc p'));
      });
      expect(ratio).toBeGreaterThan(4.5);
      await p.context().close();
    });
  }
});
