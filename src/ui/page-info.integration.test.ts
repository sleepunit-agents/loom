/**
 * A page's info behind its name in Neon's phone bar (Jonathan, 2026-11-05: "I like the idea of the helper icon thing
 * but right now it's also wasting vertical space"), in a real browser at 390 px with touch: no line under the bar; the
 * page's name is a button ("About <page>") exactly when the page has a line or an intro, and opens a sheet with the
 * line first, then the intro; a page without either has a plain name; a sub-page keeps its way back beside the name;
 * nothing is wider than 390 px; and 000h and a wide screen keep their header, its line and its ⓘ.
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

const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);

type Look = 'neon' | '000h';

describe.runIf(built && chrome)('a page\'s info behind its name in Neon\'s phone bar', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  const saved = process.env.LOOM_HOME;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-page-info-'));
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

  async function device(o: { look?: 'neon' | '000h'; width?: number } = {}): Promise<Page> {
    const w = o.width ?? 390, touch = w < 600;
    const ctx = await browser.newContext({ viewport: { width: w, height: 844 }, reducedMotion: 'reduce', isMobile: touch, hasTouch: touch, serviceWorkers: 'block' });
    await ctx.addInitScript((l) => {
      localStorage.setItem('loom-look', l); sessionStorage.setItem('loom-arrived', '1');
      const x = window as unknown as { __wide: number; __buzz: number };
      x.__wide = 0; x.__buzz = 0;
      Object.defineProperty(Navigator.prototype, 'vibrate', { configurable: true, value() { x.__buzz++; return true; } });
      const watch = () => { x.__wide = Math.max(x.__wide, document.documentElement.scrollWidth); requestAnimationFrame(watch); };
      requestAnimationFrame(watch);
    }, o.look ?? 'neon');
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`${p.url()}: ${m.text()}`); });
    return p;
  }
  /** Console errors on any page, any test (docs/specs/ui-app.md: the pages load with none). */
  const errors: string[] = [];
  const open = async (p: Page, path: string) => { await p.goto(`${base}${path}`); await p.locator('.loom-top h1').waitFor(); await p.waitForTimeout(600); };
  const wide = (p: Page) => p.evaluate(() => (window as unknown as { __wide: number }).__wide);
  /** What the bar's header holds besides the bar itself, and the name: a button (its name) or plain. */
  const bar = (p: Page) => p.evaluate(() => {
    const top = document.querySelector('.loom-top--bar')!;
    const b = top.querySelector<HTMLButtonElement>('.loom-pbar__name h1 button');
    return { under: top.querySelector('.loom-pbar')!.nextElementSibling?.outerHTML ?? null, words: top.querySelectorAll('p').length,
      name: document.querySelector('.loom-pbar__name h1')!.textContent, button: b?.getAttribute('aria-label') ?? null,
      mark: b ? getComputedStyle(b, '::after').content : null, markPx: b ? parseFloat(getComputedStyle(b, '::after').fontSize) : null,
      markColor: b ? getComputedStyle(b, '::after').color : null, nameColor: getComputedStyle(document.querySelector('.loom-pbar__name')!).color };
  });
  const intro = (p: Page, path: string) => p.evaluate(async (u) => ((await (await fetch(u, { headers: { accept: 'application/json' } })).json()) as { page?: { intro?: string } }).page?.intro, path);

  it('Neon on a phone: no line under the bar; the name is the way to the page\'s info exactly when it has some', async () => {
    const p = await device();
    for (const [path, title, has] of [['/', 'Home', false], ['/inbox', 'Inbox', false], ['/members', 'Members', true], ['/people', 'People', true], ['/pieces', 'Pieces', true]] as const) {
      await open(p, path);
      const b = await bar(p);
      expect({ path, under: b.under, words: b.words }).toEqual({ path, under: null, words: 0 });
      expect({ path, name: b.name }).toEqual({ path, name: title });
      expect({ path, button: b.button }).toEqual({ path, button: has ? `About ${title}` : null });
      expect({ path, wide: await wide(p) }).toEqual({ path, wide: 390 });
      // The page doesn't print its own intro in its body as well: loom's pages say it only behind the name.
      const said = await intro(p, path);
      if (said) expect({ path, inBody: (await p.locator('main').innerText()).includes(said.split(/(?<=[.!?])\s+/)[0]) }).toEqual({ path, inBody: false });
      if (has) {
        expect(b.mark).toMatch(/ⓘ/);
        expect(b.markPx).toBeGreaterThanOrEqual(9);
        expect(b.markPx).toBeLessThanOrEqual(10);
        expect(b.markColor).toBe(b.nameColor);
        // A finger's target, though the bar is 24 px.
        expect((await p.locator('.loom-pbar__info').boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
    }
    expect(errors).toEqual([]);
    await p.context().close();
  }, 90_000);

  it('a tap on the name opens a sheet: the page\'s line first, then the rest of its intro; it closes, and moves on with the page', async () => {
    const p = await device();
    await open(p, '/members');
    const full = (await intro(p, '/members'))!;
    const line = full.split(/(?<=[.!?])\s+/)[0];
    await p.waitForTimeout(1500); // haptics' chunk, loaded once the first page is up
    const before = await p.evaluate(() => (window as unknown as { __buzz: number }).__buzz);
    await p.getByRole('button', { name: 'About Members' }).tap();
    const sheet = p.getByRole('dialog');
    await sheet.waitFor();
    // A tick, through the haptics module.
    await expect.poll(() => p.evaluate(() => (window as unknown as { __buzz: number }).__buzz)).toBeGreaterThan(before);
    expect(await sheet.getByRole('heading').first().textContent()).toBe('Members');
    const text = await sheet.innerText();
    // The line, then the rest of the intro; the line is said once.
    const rest = full.slice(line.length).trim();
    expect(text.indexOf(line)).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(rest)).toBeGreaterThan(text.indexOf(line));
    expect(text.split(line).length - 1).toBe(1);
    // The page's own line is the sheet's description; the rest of the intro is under it.
    expect(await sheet.locator('[data-slot="drawer-description"]').textContent()).toBe(line);
    expect(await sheet.locator('.loom-page-info__more').textContent()).toBe(rest);
    expect(await p.locator('.loom-pbar__info').getAttribute('aria-expanded')).toBe('true');
    expect(await wide(p)).toBeLessThanOrEqual(390);
    // Closed by a finger: its Close button.
    await sheet.getByRole('button', { name: 'Close' }).tap();
    await expect.poll(() => sheet.count()).toBe(0);
    // A page whose intro is its one line: said once.
    await open(p, '/pieces');
    await p.getByRole('button', { name: 'About Pieces' }).tap();
    await p.getByRole('dialog').waitFor();
    const once = (await intro(p, '/pieces'))!;
    expect((await p.getByRole('dialog').innerText()).split(once).length - 1).toBe(1);
    await p.context().close();
  }, 60_000);

  it('a sub-page: the way back sits beside the name, and still goes back', async () => {
    const p = await device();
    // A fact of its own, added the way a person adds one: its page is below Knowledge.
    await open(p, '/new-fact');
    await p.locator('#fact-add-title').fill('Cone 6 is about 1222 °C');
    await p.locator('#fact-add-domain').fill('ceramics');
    await p.locator('#fact-add-body').fill('Cone 6 is about 1222 °C at a medium heating rate.');
    await p.locator('#fact-add-source').fill('https://example.com/cones');
    await p.getByRole('button', { name: /add|save/i }).last().click();
    await expect.poll(() => p.evaluate(() => location.pathname)).toMatch(/^\/knowledge\/.+/);
    await p.locator('.loom-top h1').waitFor();
    const back = p.locator('.loom-pbar__back');
    await back.waitFor();
    expect(await back.getAttribute('aria-label')).toBe('Back to Knowledge');
    const name = p.locator('.loom-pbar__info');
    expect(await name.getAttribute('aria-label')).toMatch(/^About Cone 6/);
    const [bb, nb] = [(await back.boundingBox())!, (await name.boundingBox())!];
    expect(nb.x).toBeGreaterThanOrEqual(bb.x + bb.width - 1);
    expect(nb.x - (bb.x + bb.width)).toBeLessThan(12);
    expect(Math.abs((nb.y + nb.height / 2) - (bb.y + bb.height / 2))).toBeLessThan(6);
    expect((await bar(p)).under).toBeNull();
    expect(await wide(p)).toBeLessThanOrEqual(390);
    await back.tap();
    await expect.poll(() => p.evaluate(() => location.pathname)).toBe('/knowledge');
    await p.context().close();
  }, 60_000);

  for (const [look, width] of [['000h', 390], ['neon', 1280]] as const) {
    it(`${look} at ${width} px: the header as it was, its line under the title and its ⓘ`, async () => {
      const p = await device({ look, width });
      await open(p, '/members');
      expect(await p.locator('.loom-pbar').count()).toBe(0);
      expect(await p.locator('.loom-top h1').textContent()).toBe('Members');
      expect(await p.locator('.loom-top h1 button').count()).toBe(0);
      expect(await p.locator('.loom-top p', { hasText: 'The people who own this household' }).count()).toBe(1);
      await p.getByRole('button', { name: 'What this is' }).click();
      expect(await p.locator('.loom-head-more').textContent()).toContain('A household owner owns every agent');
      if (width <= 390) expect(await wide(p)).toBeLessThanOrEqual(390);
      await p.context().close();
    }, 60_000);
  }
});
