/**
 * Knowledge as a reader (t-1925, Jonathan's approved mock 2026-11-06; docs/specs/ui-app.md, "Master/detail"): Recently
 * verified, Due a check and the topic tree as folders, each page's freshness as a dot, the reader with its sources and
 * what cites it, Still true and Check again; chips and the reader over the list in a narrow tile and on a phone.
 * Picking a page reads it without a reload. Real Chrome, Neon Noir.
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
import { agentDir, createToken, loadHousehold, type Household } from '../household.js';
import { createConversationTables } from '../backends/conversations.js';
import { knowledgeWrite } from '../tools/knowledge-write.js';
import { closeAllBackends } from '../backends/index.js';

const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);
const expect = Object.assign(((v: unknown, m?: string) => vexpect(v, m)) as typeof vexpect, vexpect,
  { poll: (f: () => unknown, o?: { timeout?: number }) => vexpect.poll(f, { timeout: 10_000, ...o }) }) as typeof vexpect;

describe.runIf(built && chrome)('Knowledge, a reader', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  const saved: Record<string, string | undefined> = {};
  const PAGES: Array<[string, string, string, string]> = [
    ['norns-softcut-voices', 'norns softcut: exactly 6 voices', 'music/norns', 'softcut has **exactly six voices**. See [[norns-clock-tempo]].'],
    ['norns-clock-tempo', 'norns clock: clock.tempo = n is a no-op', 'music/norns', 'Use params:set("clock_tempo", n).'],
    ['elektron-digitakt-midi', 'Digitakt sends MIDI clock on port A', 'music/gear/elektron', 'Port A only.'],
    ['homelab-backup', 'The nightly backup runs at 03:00', 'ours/homelab', 'restic, to wunder.'],
  ];

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-knowledge-app-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db')); createConversationTables(db); db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', owner: 'jonathan' }));
    for (const k of ['LOOM_HOME', 'XDG_CONFIG_HOME']) saved[k] = process.env[k];
    process.env.LOOM_HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    h = loadHousehold(home)!;
    for (const [slug, title, domain, body] of PAGES) {
      await knowledgeWrite(agentDir(h, 'art'), { slug, title, domain, body, citations: [{ claim: title, source_kind: 'docs', source_locator: 'https://example.com/norns', excerpt: title }] } as never, 'art');
    }
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

  async function screen(width: number, height: number, path: string, touch = false): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', serviceWorkers: 'block', ...(touch ? { hasTouch: true, isMobile: true } : {}) });
    await ctx.addInitScript(`if (!sessionStorage.getItem('t')) { sessionStorage.setItem('t', '1'); localStorage.setItem('loom-look', 'neon'); } sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    await p.goto(`${base}${path}`);
    await p.locator('.loom-split').waitFor();
    await p.waitForTimeout(300);
    await p.evaluate(() => { (window as unknown as { kept: number }).kept = 1; });
    return p;
  }
  const mode = (p: Page) => p.locator('.loom-kn').getAttribute('data-mode');
  const kept = (p: Page) => p.evaluate(() => (window as unknown as { kept?: number }).kept);
  const row = (p: Page, words: string) => p.locator('[data-split-row]', { hasText: words });
  const reader = '.loom-split__reader';
  const shot = async (p: Page, name: string) => { if (process.env.LOOM_SHOTS) await p.screenshot({ path: join(process.env.LOOM_SHOTS, `${name}.png`) }); };

  for (const [w, hgt] of [[1280, 800], [1920, 1080]] as const) {
    it(`a big Knowledge tile: folders from the domains, freshness dots, and the reader with sources and cited by, no reload, at ${w}×${hgt}`, async () => {
      const p = await screen(w, hgt, '/knowledge?t=*knowledge');
      await expect.poll(() => mode(p)).toBe('three');
      const folders = await p.locator('.loom-split__nav .loom-split__folder-name').allTextContents();
      expect(folders.slice(0, 3)).toEqual(['All pages', 'Recently verified', 'Due a check']);
      expect(folders).toEqual(expect.arrayContaining(['music', 'norns', 'gear/elektron', 'ours', 'homelab']));
      await p.locator('.loom-split__folder', { hasText: /^norns/ }).click();
      expect(await p.locator('[data-split-row]').count()).toBe(2);
      expect(await row(p, 'exactly 6 voices').locator('.loom-kn__dot').getAttribute('data-fresh')).toBe('fresh');
      await row(p, 'exactly 6 voices').click();
      await expect.poll(() => p.locator(`${reader} h2`).textContent()).toBe('norns softcut: exactly 6 voices');
      await expect.poll(() => p.locator(`${reader} .loom-kn__body`).textContent()).toMatch(/exactly six voices/);
      expect(await p.locator(`${reader} [aria-label="Sources"]`).textContent()).toMatch(/example\.com\/norns/);
      expect(await p.locator(`${reader} .loom-kn__pill`).textContent()).toMatch(/Fresh/);
      await shot(p, `after-knowledge-${w}`);
      // What it cites opens from the other page's Cited by.
      await row(p, 'clock.tempo').click();
      await expect.poll(() => p.locator(`${reader} [aria-label="Cited by"]`).textContent()).toMatch(/exactly 6 voices/);
      await p.locator(`${reader} [aria-label="Cited by"] button`).click();
      await expect.poll(() => p.locator(`${reader} h2`).textContent()).toBe('norns softcut: exactly 6 voices');
      // Check again: due a check, said on its pill and its dot, still no reload.
      await p.locator(`${reader} button:text-is("Check again")`).click();
      await expect.poll(() => p.locator(`${reader} .loom-kn__pill`).textContent()).toMatch(/Due a check/);
      await expect.poll(() => row(p, 'exactly 6 voices').locator('.loom-kn__dot').getAttribute('data-fresh')).toBe('due');
      // Still true puts it back.
      await p.locator(`${reader} button:text-is("Still true")`).click();
      await expect.poll(() => p.locator(`${reader} .loom-kn__pill`).textContent()).toMatch(/Fresh/);
      // The folder it was read in is where it was left.
      expect(await p.locator('.loom-split__folder[aria-current="true"]').textContent()).toMatch(/^norns/);
      expect(await kept(p)).toBe(1);
      expect(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      await p.context().close();
    });
  }

  it('a narrow tile: topic chips, the list, then the reader slides over it; Escape goes back to the row', async () => {
    const p = await screen(1280, 800, '/knowledge?t=*knowledge,comms&w=needs,art');
    await expect.poll(() => mode(p)).toBe('one');
    expect(await p.locator('.loom-split__chips button').allTextContents()).toEqual(expect.arrayContaining([expect.stringMatching(/^norns/)]));
    await p.locator('.loom-split__chips button', { hasText: /^homelab/ }).click();
    await shot(p, 'after-knowledge-narrow');
    await row(p, 'nightly backup').click();
    await expect.poll(() => p.locator(`${reader} h2`).textContent()).toBe('The nightly backup runs at 03:00');
    await shot(p, 'after-knowledge-narrow-open');
    await p.keyboard.press('Escape');
    await expect.poll(() => p.locator(reader).count()).toBe(0);
    await expect.poll(() => p.evaluate(() => document.activeElement?.hasAttribute('data-split-row'))).toBe(true);
    expect(await kept(p)).toBe(1);
    await p.context().close();
  });

  it('keys: down the list, beside the reader, reads each page in turn', async () => {
    const p = await screen(1920, 1080, '/knowledge?t=*knowledge');
    // From the first row: the order is newest first, and the tests before this one touched some.
    await p.locator('[data-split-row]').first().focus();
    await p.keyboard.press('ArrowDown');
    await expect.poll(() => p.locator(`${reader} h2`).count()).toBe(1);
    const first = await p.locator(`${reader} h2`).textContent();
    await p.keyboard.press('ArrowDown');
    await expect.poll(() => p.locator(`${reader} h2`).textContent()).not.toBe(first);
    await p.context().close();
  });

  it('a copied desk address on a phone keeps its list (the tiles\' t is not a topic), and Add a fact is there', async () => {
    const p = await screen(390, 844, '/knowledge?t=*knowledge,comms', true);
    await expect.poll(() => p.locator('[data-split-row]').count()).toBe(4);
    expect(await p.locator('.loom-split__list-head h2').textContent()).toBe('All pages');
    expect(await p.locator('.loom-kn__add').textContent()).toBe('Add a fact');
    await p.context().close();
  });

  it('every look draws it from its tokens: no row, dot or pill colour is the same in all three', async () => {
    const seen: string[] = [];
    for (const look of ['neon', 'lowlight', 'daylight']) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
      await ctx.addInitScript(`localStorage.setItem('loom-look', '${look}'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
      await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
      const p = await ctx.newPage();
      await p.goto(`${base}/knowledge?t=*knowledge`);
      await p.locator('[data-split-row]').first().click();
      await p.locator(`${reader} .loom-kn__pill`).waitFor();
      seen.push(await p.locator(`${reader}`).evaluate((r) => [getComputedStyle(r.querySelector('.loom-split__head')!).color, getComputedStyle(r.querySelector('.loom-kn__pill')!).color].join(' ')));
      await ctx.close();
    }
    expect(new Set(seen).size).toBe(3);
  });

  it('a phone (390): one pane, the page with Back', async () => {
    const p = await screen(390, 844, '/knowledge', true);
    await expect.poll(() => mode(p)).toBe('one');
    await row(p, 'Digitakt').tap();
    await expect.poll(() => p.locator(`${reader} h2`).textContent()).toBe('Digitakt sends MIDI clock on port A');
    await shot(p, 'after-knowledge-390');
    await p.locator('.loom-split__back').tap();
    await expect.poll(() => p.locator('.loom-split__list').isVisible()).toBe(true);
    expect(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await p.context().close();
  });
});
