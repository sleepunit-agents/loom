/**
 * The launcher (t-1925 G; the app mockups, 2026-11-06): every app in one grid, from the dock's last key or
 * Ctrl+Shift+Space. Search has focus at once and filters as you type; Enter opens the first match as a tile; Esc
 * closes; the arrow keys move between apps. Setup and Places are no dock keys and no tiles on a desktop: an old link
 * to either opens the launcher. A phone keeps its More and Places. Real Chrome, in every look.
 *
 * Runs where the app is built (npm run build) and a Chrome is installed (GitHub's runners have one).
 */
import { describe, it, expect as vexpect, beforeAll, afterAll, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const LAUNCHER = '.loom-launcher';
/** A piece with a tab: its label, its kind (a place, or a setting), and the line its tile says. */
const piece = (label: string, kind: string, value: string) => `#!/usr/bin/env node
const args = process.argv.slice(2).join(' ');
if (args === 'ui --json') { process.stdout.write(JSON.stringify({ v: 2, tab: { label: ${JSON.stringify(label)}, kind: ${JSON.stringify(kind)} }, tile: { label: ${JSON.stringify(label)}, value: ${JSON.stringify(value)} } })); process.exit(0); }
let input = ''; process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => { process.stdout.write(JSON.stringify({ title: ${JSON.stringify(label)}, sections: [{ id: 'a', blocks: [{ type: 'text', text: 'Here.' }] }] })); });
`;

describe.runIf(built)('the launcher\'s chunk', () => {
  it('is its own: the first page carries none of it', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const assets = readdirSync(`${root}dist/web/assets`);
    expect(assets.some((f) => /^launcher-.*\.js$/.test(f))).toBe(true);
    const index = readFileSync(`${root}dist/web/index.html`, 'utf-8');
    const first = assets.filter((x) => /\.(js|css)$/.test(x) && index.includes(x));
    expect(first.length).toBeGreaterThan(0);
    for (const f of first) expect(readFileSync(`${root}dist/web/assets/${f}`, 'utf-8'), f).not.toMatch(/loom-launcher__foot|loom-lsec__name/);
  });
});

describe.runIf(built && chrome)('the launcher', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-desk-launcher-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a === 'art' ? 'Art E Fish' : 'Visual Mark'}\n`);
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db')); createConversationTables(db); db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', owner: 'jonathan',
      members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    for (const [name, label, kind, value] of [['work', 'Work items', 'place', '9 open'], ['vault', 'Secrets', 'setting', '1 request']]) {
      writeFileSync(join(bin, `loom-${name}`), piece(label, kind, value)); chmodSync(join(bin, `loom-${name}`), 0o755);
    }
    for (const k of ['LOOM_HOME', 'XDG_CONFIG_HOME', 'PATH']) saved[k] = process.env[k];
    process.env.PATH = `${bin}:${saved.PATH}`;
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

  async function screen(width: number, height: number, o: { path?: string; look?: string; motion?: 'reduce' | 'no-preference' } = {}): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: o.motion ?? 'reduce', serviceWorkers: 'block' });
    await ctx.addInitScript(`if (!sessionStorage.getItem('t')) { sessionStorage.setItem('t', '1'); localStorage.setItem('loom-look', '${o.look ?? 'neon'}'); } sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    (p as Page & { errors: string[] }).errors = errors;
    await p.goto(`${base}${o.path ?? '/'}`);
    if (width >= 1024) await p.locator('.loom-tiles').waitFor();
    await p.waitForTimeout(300);
    return p;
  }
  const labels = (p: Page) => p.$$eval('.loom-tile', (ts) => ts.map((t) => (t.getAttribute('aria-label') ?? '').replace(/^tile \d+ of \d+, /, '')));
  const apps = (p: Page) => p.$$eval(`${LAUNCHER} .loom-lapp .loom-lapp__nm`, (ns) => ns.map((n) => n.textContent));
  const sections = (p: Page) => p.$$eval(`${LAUNCHER} .loom-lsec__name`, (ns) => ns.map((n) => n.textContent));

  for (const [w, hgt] of [[1280, 800], [1920, 1080]] as const) {
    it(`opens from the dock's last key with search focused; sections from loom's list; types, Enter opens a tile; Esc closes, at ${w}×${hgt}`, async () => {
      const p = await screen(w, hgt);
      // The dock: no Setup key, no More key for the setting pieces, no account key; the last key is All apps. A place
      // piece keeps its key.
      expect(await p.locator(KEY('Setup')).count()).toBe(0);
      expect(await p.locator(KEY('More')).count()).toBe(0);
      expect(await p.locator(KEY('Tasks')).count()).toBe(1);
      const keys = await p.$$eval('.loom-dock-bar [data-part="item"]', (ks) => ks.map((k) => k.getAttribute('aria-label')));
      expect(keys.at(-1)).toBe('All apps');
      await p.click(KEY('All apps'));
      await p.locator(LAUNCHER).waitFor();
      expect(await p.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Find an app');
      expect(await sections(p)).toEqual(['Work', 'People & agents', 'Library', 'System', 'Look & feel', 'Pieces']);
      const all = await apps(p);
      for (const a of ['Inbox', 'Activity', 'Projects', 'Tasks', 'Comms', 'Art E Fish', 'Visual Mark', 'People', 'Knowledge', 'Secrets', 'Members', 'Appearance', 'Accessibility', 'Pieces']) expect(all).toContain(a);
      // A setting piece is System's, with its tile's line; a place piece Work's.
      expect(await p.locator(`${LAUNCHER} .loom-lsec[aria-label="System"] .loom-lapp[aria-label^="Secrets"] .loom-lapp__sub`).textContent()).toBe('1 request');
      expect(await p.locator(`${LAUNCHER} .loom-lsec[aria-label="Work"] .loom-lapp[aria-label^="Tasks"]`).count()).toBe(1);
      // Live state under each name: the agents', the look's.
      expect(await p.locator(`${LAUNCHER} .loom-lapp[aria-label^="Appearance"] .loom-lapp__sub`).textContent()).toBe('Neon Noir');
      expect(await p.locator(`${LAUNCHER} .loom-lapp[aria-label^="Inbox"] .loom-lapp__sub`).textContent()).toBe('Nothing waiting');
      expect(await p.locator(`${LAUNCHER} .loom-lapp[aria-label^="Accessibility"] .loom-lapp__sub`).textContent()).toBe('As this device');
      // Enter's pick is marked before anything's typed too: the first app.
      expect(await p.locator(`${LAUNCHER} .loom-lapp[data-first] .loom-lapp__nm`).textContent()).toBe('Inbox');
      // It filters as you type; the first match is marked; Enter opens it as a tile.
      await p.keyboard.type('acc');
      // Profile's too: it's found by "account" (t-1970). Enter's pick is still the one whose name starts so.
      await expect.poll(() => apps(p)).toEqual(['Profile', 'Accessibility']);
      expect(await p.locator(`${LAUNCHER} .loom-lapp[data-first]`).count()).toBe(1);
      await p.keyboard.press('Enter');
      await expect.poll(() => p.locator(LAUNCHER).count()).toBe(0);
      await expect.poll(() => labels(p)).toEqual(['Accessibility']);
      expect(new URL(p.url()).pathname).toBe('/accessibility');
      // Again: a word with no app says so; Esc closes and opens nothing.
      await p.click(KEY('All apps'));
      await p.locator(LAUNCHER).waitFor();
      expect(await p.locator('input[aria-label="Find an app"]').inputValue()).toBe('');
      await p.keyboard.type('zzz');
      await expect.poll(() => p.locator(`${LAUNCHER} .loom-launcher__none`).count()).toBe(1);
      await p.keyboard.press('Escape');
      await expect.poll(() => p.locator(LAUNCHER).count()).toBe(0);
      expect(await labels(p)).toEqual(['Accessibility']);
      // An agent opens as its own tile; a second app goes beside the first.
      await p.click(KEY('All apps'));
      await p.locator(LAUNCHER).waitFor();
      await p.keyboard.type('art e');
      await p.keyboard.press('Enter');
      await expect.poll(() => labels(p)).toEqual(['Accessibility', 'Art E Fish']);
      // Opening one already open focuses it: no second tile.
      await p.click(KEY('All apps'));
      await p.locator(LAUNCHER).waitFor();
      await p.keyboard.type('accessi');
      await p.keyboard.press('Enter');
      await expect.poll(() => p.evaluate(() => document.querySelector('.loom-tile[data-focused], .loom-tile[aria-current="true"]')?.getAttribute('aria-label') ?? '')).toMatch(/Accessibility/);
      expect(await labels(p)).toEqual(['Accessibility', 'Art E Fish']);
      // A setting piece opens in a tile of its own.
      await p.click(KEY('All apps'));
      await p.locator(LAUNCHER).waitFor();
      await p.keyboard.type('secr');
      await p.keyboard.press('Enter');
      await expect.poll(() => labels(p)).toContain('Secrets');
      expect((p as Page & { errors: string[] }).errors).toEqual([]);
      await p.context().close();
    });
  }

  it('is fully keyboard-driven: Ctrl+Shift+Space opens and closes it, the arrows move between apps, Enter on one opens it', async () => {
    const p = await screen(1280, 800);
    await p.keyboard.press('Control+Shift+Space');
    await p.locator(LAUNCHER).waitFor();
    await p.keyboard.press('ArrowDown');
    expect(await p.evaluate(() => document.activeElement?.textContent)).toMatch(/^Inbox/);
    await p.keyboard.press('ArrowRight');
    const second = await p.evaluate(() => document.activeElement?.querySelector('.loom-lapp__nm')?.textContent);
    expect(second).not.toBe('Inbox');
    await p.keyboard.press('ArrowLeft');
    expect(await p.evaluate(() => document.activeElement?.querySelector('.loom-lapp__nm')?.textContent)).toBe('Inbox');
    // Down a row lands below; Up from the first row goes back to the search.
    await p.keyboard.press('ArrowDown');
    const below = await p.evaluate(() => document.activeElement?.querySelector('.loom-lapp__nm')?.textContent);
    expect(below).toBeTruthy();
    await p.keyboard.press('ArrowUp');
    await p.keyboard.press('ArrowUp');
    expect(await p.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Find an app');
    // Tab stays inside it (a dialog).
    for (let n = 0; n < 40; n++) await p.keyboard.press('Tab');
    expect(await p.evaluate(() => !!document.activeElement?.closest('.loom-launcher'))).toBe(true);
    await p.keyboard.press('Control+Shift+Space');
    await expect.poll(() => p.locator(LAUNCHER).count()).toBe(0);
    // Enter on a focused tile opens it.
    await p.keyboard.press('Control+Shift+Space');
    await p.locator(LAUNCHER).waitFor();
    await p.keyboard.type('know');
    await p.keyboard.press('ArrowDown');
    await p.keyboard.press('Enter');
    await expect.poll(() => labels(p)).toEqual(['Knowledge']);
    await p.context().close();
  });

  it('Profile is an app: "profile", "passkey" or "sign out" finds it, and Enter opens it (t-1970)', async () => {
    const p = await screen(1280, 800);
    for (const q of ['profile', 'passkey', 'sign out']) {
      await p.click(KEY('All apps'));
      await p.locator(LAUNCHER).waitFor();
      await p.keyboard.type(q);
      await expect.poll(() => apps(p)).toContain('Profile');
      expect(await p.locator(`${LAUNCHER} .loom-lapp[data-first] .loom-lapp__nm`).textContent()).toBe('Profile');
      expect(await p.locator(`${LAUNCHER} .loom-lsec[aria-label="System"] .loom-lapp[aria-label^="Profile"]`).count()).toBe(1);
      await p.keyboard.press('Enter');
      await expect.poll(() => p.locator(LAUNCHER).count()).toBe(0);
      await expect.poll(() => new URL(p.url()).pathname).toBe('/account');
    }
    await p.context().close();
  });

  it('an old link to Setup or More opens the launcher over the desktop, not a tile', async () => {
    for (const path of ['/setup', '/places', '/setup?from=an-old-link']) {
      const p = await screen(1280, 800, { path });
      await p.locator(LAUNCHER).waitFor();
      expect(await labels(p)).toEqual([]);
      await p.context().close();
    }
  });

  for (const look of ['neon', 'lowlight', 'daylight']) {
    it(`reads in ${look}: its text and its tiles' names stand off their ground (4.5:1)`, async () => {
      const p = await screen(1280, 800, { look });
      await p.click(KEY('All apps'));
      await p.locator(LAUNCHER).waitFor();
      const ratio = await p.evaluate(() => {
        const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
        const lum = (c: number[]) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const panel = rgb(getComputedStyle(document.querySelector('.loom-launcher')!).backgroundColor);
        const nm = rgb(getComputedStyle(document.querySelector('.loom-lapp__nm')!).color);
        const [a, b] = [lum(panel), lum(nm)].sort((x, y) => y - x);
        return (a + 0.05) / (b + 0.05);
      });
      expect(ratio).toBeGreaterThan(4.5);
      await p.context().close();
    });
  }

  for (const motion of ['reduce', 'no-preference'] as const) {
    it(`its rise and fade follow Reduce motion (${motion})`, async () => {
      const p = await screen(1280, 800, { motion });
      await p.click(KEY('All apps'));
      await p.locator(LAUNCHER).waitFor();
      const names = await p.evaluate(() => ['.loom-launcher', '.loom-lscrim'].map((s) => getComputedStyle(document.querySelector(s)!).animationName));
      if (motion === 'reduce') expect(names).toEqual(['none', 'none']);
      else expect(names.every((n) => n !== 'none')).toBe(true);
      await p.context().close();
    });
  }

  it('a phone keeps its More and Places (no launcher there)', async () => {
    const p = await screen(390, 844);
    await p.locator('.loom-dock-bar').waitFor();
    expect(await p.locator(KEY('All apps')).count()).toBe(0);
    expect(await p.locator(KEY('Places')).count()).toBe(1);
    await p.context().close();
  });
});
