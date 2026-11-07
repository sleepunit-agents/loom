/**
 * Desk tiling, phase 5 (docs/specs/desk-tiling.md, criteria 15, 16 and 19): the keys, a tile's own sheets and
 * dialogs, the announcements and reduced motion. A sheet opened in a tile is modal to that tile only: its scrim is
 * inside the tile, Tab stays in it, the other tiles still answer a click, and nothing outside it is hidden from a
 * screen reader. Alt+Shift moves between and arranges the tiles; reduced motion starts no View Transition. Real Chrome.
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
import { agentDir, createToken, loadHousehold, type Household } from '../household.js';
import { createConversationTables, recordTurn, writeDigest } from '../backends/conversations.js';
import { closeAllBackends } from '../backends/index.js';

const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);
const expect = Object.assign(((v: unknown, m?: string) => vexpect(v, m)) as typeof vexpect, vexpect,
  { poll: (f: () => unknown, o?: { timeout?: number }) => vexpect.poll(f, { timeout: 10_000, ...o }) }) as typeof vexpect;
const ASK = 'OK to turn off the recycle bin on Sonarr for a quick rename?';

describe.runIf(built && chrome)('desk tiling: keys, a tile\'s own sheets, reduced motion', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-desk-keys-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db')); createConversationTables(db); db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', owner: 'jonathan', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
    for (const k of ['LOOM_HOME', 'XDG_CONFIG_HOME', 'PATH']) saved[k] = process.env[k];
    // A piece whose page has a choice of many (a select), to open one inside a tile.
    const bin = join(home, 'bin');
    mkdirSync(bin);
    const kinds = ['Tomato', 'Basil', 'Chard', 'Leek', 'Onion', 'Radish', 'Squash'].map((l) => ({ value: l.toLowerCase(), label: l }));
    writeFileSync(join(bin, 'garden.json'), JSON.stringify({ v: 2, tab: { label: 'Garden' } }));
    writeFileSync(join(bin, 'page.json'), JSON.stringify({ title: 'Garden', sections: [{ id: 'plant', title: 'Plant', blocks: [{ type: 'form', action: 'plant', submit: 'Plant', fields: [{ name: 'kind', label: 'Kind', kind: 'choice', options: kinds }] }] }] }));
    writeFileSync(join(bin, 'loom-garden'), `#!/bin/sh\ncase "$1 $2" in "ui --json") cat "${join(bin, 'garden.json')}" ;; *) cat "${join(bin, 'page.json')}" ;; esac\n`);
    chmodSync(join(bin, 'loom-garden'), 0o755);
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.LOOM_HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    h = loadHousehold(home)!;
    token = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: 'jonathan' }).token;
    // An ask, so the Inbox has something whose sheet opens.
    const art = agentDir(h, 'art');
    const conv = recordTurn(art, 'art', { venue: 'wake', place: 'lane:making', label: 't-738: sonarr', at: new Date().toISOString(), from: { kind: 'schedule' }, kind: 'wake' }, 'runtime:clock').conversation;
    writeDigest(art, { conversation: conv, run: 'r1' }, { summary: 'Checked.', needs_owner: { ask: ASK, why: 'Deleting takes hours.', answers: 'words' } } as never);
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

  /** Tiling on, this device only; `motion: true` lets motion run (else reduced, as the browser says); View
   * Transitions counted in `window.__vt`. */
  async function screen(width: number, height: number, path: string, o: { motion?: boolean } = {}): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: o.motion ? 'no-preference' : 'reduce', serviceWorkers: 'block' });
    await ctx.addInitScript(`localStorage.setItem('loom-look', 'neon'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');
      window.__vt = 0; window.__named = []; const s = Document.prototype.startViewTransition;
      if (s) Document.prototype.startViewTransition = function (...a) {
        window.__vt++;
        // what each tile, and each tile's body, is named for this transition, as it starts
        window.__named.push([...document.querySelectorAll('.loom-tile')].map((t) => [t.getAttribute('data-tile'), getComputedStyle(t).viewTransitionName, getComputedStyle(t.querySelector('.loom-tile__body')).viewTransitionName]));
        return s.apply(this, a);
      };`);
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    await p.goto(`${base}${path}`);
    await p.locator('.loom-tile').first().waitFor();
    await p.waitForTimeout(400);
    return p;
  }
  const query = (p: Page, k: string) => new URL(p.url()).searchParams.get(k);
  const labels = (p: Page) => p.$$eval('.loom-tile', (ts) => ts.map((t) => (t.getAttribute('aria-label') ?? '').replace(/^tile \d+ of \d+, /, '')));
  const focusedTile = (p: Page) => p.evaluate(() => document.activeElement?.closest('.loom-tile')?.getAttribute('data-tile') ?? null);
  const said = (p: Page) => p.locator('.loom-tiles > p[aria-live]').textContent();
  const key = async (p: Page, k: string) => { await p.keyboard.press(k); await p.waitForTimeout(150); };

  for (const [w, hgt] of [[1024, 768], [1280, 800], [1920, 1080]]) {
    it(`16. a sheet in one tile is that tile's: its scrim inside, Tab stays, the other tile answers, nothing else hidden, at ${w}×${hgt}`, async () => {
      const p = await screen(w, hgt, '/members?t=*members,people');
      // Members is Setup's page, its tile named Setup.
      await expect.poll(async () => (await labels(p)).sort()).toEqual(['People', 'Setup']);
      const inbox = p.locator('.loom-tile[data-tile="/setup"]');
      const hiddenOutside = () => p.evaluate(() => [...document.querySelectorAll('[aria-hidden="true"]')].filter((e) => !e.closest('.loom-tile[data-tile="/setup"]')).length);
      const before = await hiddenOutside();
      // A member's row on Members (Setup's page): its sheet (the Inbox's ask was one, until it became a reader: t-1925).
      await inbox.getByText('Owns every agent').first().click();
      const sheet = inbox.locator('.loom-tile__layer [role="dialog"][data-state="open"]');
      await sheet.waitFor();
      // its scrim covers its tile, and only its tile; the sheet is inside the tile's box
      const box = await inbox.boundingBox(), s = await sheet.boundingBox();
      const scrimOf = (t: string) => p.locator(`.loom-tile[data-tile="${t}"] .loom-tile__layer`).evaluate((e) => getComputedStyle(e).backgroundColor);
      expect(await scrimOf('/setup')).not.toMatch(/^rgba\(0, 0, 0, 0\)$|transparent/);
      expect(await scrimOf('/people')).toMatch(/^rgba\(0, 0, 0, 0\)$|transparent/);
      for (const b of [s!]) {
        expect(b.x).toBeGreaterThanOrEqual(box!.x - 0.5); expect(b.y).toBeGreaterThanOrEqual(box!.y - 0.5);
        expect(b.x + b.width).toBeLessThanOrEqual(box!.x + box!.width + 0.5); expect(b.y + b.height).toBeLessThanOrEqual(box!.y + box!.height + 0.5);
      }
      expect(await inbox.getAttribute('data-blocked')).not.toBeNull();
      // Tab goes round inside the tile
      for (let i = 0; i < 12; i++) { await p.keyboard.press('Tab'); expect(await focusedTile(p), `Tab ${i + 1}`).toBe('/setup'); }
      for (let i = 0; i < 4; i++) { await p.keyboard.press('Shift+Tab'); expect(await focusedTile(p), `Shift+Tab ${i + 1}`).toBe('/setup'); }
      // nothing outside the tile was hidden from a screen reader
      expect(await hiddenOutside()).toBe(before);
      // the other tile still answers a click, and the sheet stays open in its own tile
      await p.locator('.loom-tile[data-tile="/people"] a[href^="/people/"]').first().click();
      await expect.poll(() => p.locator('.loom-tile[data-tile="/people"] .loom-tile__path').textContent()).toMatch(/^loom\/people\/./);
      expect(await sheet.count()).toBe(1);
      // Esc closes the sheet, never a tile
      await inbox.locator('.loom-tile__layer [role="dialog"] button').first().focus();
      await p.keyboard.press('Escape');
      await expect.poll(() => sheet.count()).toBe(0);
      expect((await labels(p)).sort()).toEqual(['People', 'Setup']);
      expect(await inbox.getAttribute('data-blocked')).toBeNull();
      await p.context().close();
    }, 60_000);
  }

  it('15. the keys: focus by direction (and the live region says where), make it the big one, swap, minimize, Home and back, Back in one tile only; a field keeps its keys; Esc closes no tile', async () => {
    const p = await screen(1920, 1080, '/inbox?t=*inbox,people,comms&w=');
    await expect.poll(() => labels(p)).toEqual(['Inbox', 'People', 'Comms']);
    await p.locator('.loom-tile[data-tile="/inbox"] .loom-tile__bar h2').focus();
    // → from the big slot: position 1, the upper of the two on the right
    await key(p, 'Alt+Shift+ArrowRight');
    await expect.poll(() => focusedTile(p)).toBe('/people');
    await expect.poll(() => said(p)).toBe('tile 2 of 3, People');
    await key(p, 'Alt+Shift+ArrowDown');
    await expect.poll(() => focusedTile(p)).toBe('/comms');
    await expect.poll(() => said(p)).toBe('tile 3 of 3, Comms');
    await key(p, 'Alt+Shift+ArrowLeft');
    await expect.poll(() => focusedTile(p)).toBe('/inbox');
    await key(p, 'Alt+Shift+ArrowRight'); await key(p, 'Alt+Shift+ArrowDown');
    // make it the big one
    await key(p, 'Alt+Shift+Enter');
    await expect.poll(() => query(p, 't')).toBe('*comms!,inbox,people');
    // drawn so too: the big slot on the left
    const at = () => p.$$eval('.loom-tile', (ts) => ts.map((t) => { const r = t.getBoundingClientRect(); return [t.getAttribute('data-tile'), Math.round(r.x), Math.round(r.y)] as [string, number, number]; }));
    await expect.poll(() => labels(p)).toEqual(['Comms', 'Inbox', 'People']);
    expect((await at())[0][1]).toBeLessThan((await at())[1][1]);
    // swap with the one after (it isn't pinned once it leaves the big slot), then back
    await key(p, 'Alt+Shift+Period');
    await expect.poll(() => query(p, 't')).toBe('inbox,*comms,people');
    await expect.poll(() => labels(p)).toEqual(['Inbox', 'Comms', 'People']);
    expect((await at()).map((x) => x[0])).toEqual(['/inbox', '/comms', '/people']);
    await key(p, 'Alt+Shift+Comma');
    await expect.poll(() => query(p, 't')).toBe('*comms,inbox,people');
    await expect.poll(() => labels(p)).toEqual(['Comms', 'Inbox', 'People']);
    // minimize; close
    await key(p, 'Alt+Shift+KeyM');
    await expect.poll(() => [query(p, 't'), query(p, 'm')]).toEqual(['inbox,*people', 'comms']);
    // Home: every app to the dock; again: back in their order
    await key(p, 'Alt+KeyH');
    await expect.poll(() => p.locator('.loom-tile').count()).toBe(0);
    await key(p, 'Alt+KeyH');
    await expect.poll(() => labels(p)).toEqual(['Inbox', 'People']);
    // Back and Forward in the focused tile only
    const people = p.locator('.loom-tile[data-tile="/people"]');
    await people.locator('a[href^="/people/"]').first().click();
    await expect.poll(() => people.locator('.loom-tile__path').textContent()).toMatch(/^loom\/people\/./);
    const inboxAt = await p.locator('.loom-tile[data-tile="/inbox"] .loom-tile__path').textContent();
    await key(p, 'Alt+ArrowLeft');
    await expect.poll(() => people.locator('.loom-tile__path').textContent()).toBe('loom/people');
    expect(await p.locator('.loom-tile[data-tile="/inbox"] .loom-tile__path').textContent()).toBe(inboxAt);
    await key(p, 'Alt+ArrowRight');
    await expect.poll(() => people.locator('.loom-tile__path').textContent()).toMatch(/^loom\/people\/./);
    // close
    await people.locator('.loom-tile__bar h2').focus();
    await key(p, 'Alt+Shift+KeyW');
    await expect.poll(() => labels(p)).toEqual(['Inbox']);
    // with a field focused, the tiles' keys are the field's
    await p.click('.loom-dock-bar [data-part="item"][aria-label="Comms"]');
    await expect.poll(() => labels(p)).toEqual(['Inbox', 'Comms']);
    const comms = p.locator('.loom-tile[data-tile="/comms"]');
    await comms.locator('button', { hasText: 'New thread' }).click();
    const field = comms.locator('textarea').first();
    await field.focus();
    await key(p, 'Alt+Shift+ArrowLeft');
    expect(await p.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
    // Esc with no pop-up open closes no tile
    await comms.locator('.loom-tile__bar h2').focus();
    await key(p, 'Escape');
    expect(await labels(p)).toEqual(['Inbox', 'Comms']);
    await p.context().close();
  }, 60_000);

  it('15. the arrows reach a widget too, a key in the strip included, and say which', async () => {
    const p = await screen(1024, 768, '/inbox?t=*inbox,comms&w=needs,art');
    await expect.poll(() => p.locator('.loom-tiles').getAttribute('data-widgets')).toBe('strip');
    await p.locator('.loom-tile[data-tile="/comms"] .loom-tile__bar h2').focus();
    // the key whose centre is nearest Comms's (Art's, the lower of the two), then up to Needs you
    await key(p, 'Alt+Shift+ArrowRight');
    await expect.poll(() => p.evaluate(() => document.activeElement?.closest('[data-widget]')?.getAttribute('data-widget'))).toBe('art');
    await expect.poll(() => said(p)).toMatch(/^art.*, widget$/i);
    await key(p, 'Alt+Shift+ArrowUp');
    await expect.poll(() => p.evaluate(() => document.activeElement?.closest('[data-widget]')?.getAttribute('data-widget'))).toBe('needs');
    await expect.poll(() => said(p)).toMatch(/^Needs you.*, widget$/);
    await p.context().close();
  }, 60_000);

  it('16. a choice of many in a tile is the browser\'s own list, so nothing outside the tile is hidden while it\'s used', async () => {
    const p = await screen(1280, 800, '/p/garden?t=*garden,inbox&w=');
    const garden = p.locator('.loom-tile[data-tile="/p/garden"]');
    const select = garden.locator('select.loom-native-select');
    await garden.waitFor();
    await select.waitFor();
    expect(await garden.locator('[data-slot="select-trigger"]').count()).toBe(0);
    const hidden = () => p.evaluate(() => [...document.querySelectorAll('[aria-hidden="true"]')].filter((e) => !e.closest('.loom-tile[data-tile="/p/garden"]')).length);
    const before = await hidden();
    await select.focus();
    await select.selectOption('chard');
    expect(await select.inputValue()).toBe('chard');
    expect(await hidden()).toBe(before);
    await p.context().close();
  }, 60_000);

  for (const [w, hgt] of [[1024, 768], [1280, 800], [1920, 1080]]) it(`19. reduced motion starts no View Transition; with motion, opening a second app morphs every tile, and a page change in one names only that one, at ${w}×${hgt}`, async () => {
    const still = await screen(w, hgt, '/inbox?t=*inbox&w=');
    await still.click('.loom-dock-bar [data-part="item"][aria-label="People"]');
    await expect.poll(() => labels(still)).toEqual(['Inbox', 'People']);
    expect(await still.evaluate(() => (window as unknown as { __vt: number }).__vt)).toBe(0);
    await still.context().close();
    const moving = await screen(w, hgt, '/inbox?t=*inbox&w=', { motion: true });
    await moving.click('.loom-dock-bar [data-part="item"][aria-label="People"]');
    await expect.poll(() => labels(moving)).toEqual(['Inbox', 'People']);
    expect(await moving.evaluate(() => (window as unknown as { __vt: number }).__vt)).toBeGreaterThanOrEqual(1);
    type Named = [string, string, string][][];
    const named = () => moving.evaluate(() => (window as unknown as { __named: Named }).__named);
    // the reflow: every tile named for itself, no body named
    const reflow = (await named()).at(-1)!;
    expect(reflow.every((x) => x[1] !== 'none' && x[2] === 'none')).toBe(true);
    expect(new Set(reflow.map((x) => x[1])).size).toBe(reflow.length);
    // a page change in People (a page it has shown, so it's here at once): only People's body is named
    const people = moving.locator('.loom-tile[data-tile="/people"]');
    await people.locator('a[href^="/people/"]').first().click();
    await expect.poll(() => people.locator('.loom-tile__path').textContent()).toMatch(/^loom\/people\/./);
    await people.locator('.loom-tile__btn[aria-label^="Back"]').click();
    await expect.poll(() => people.locator('.loom-tile__path').textContent()).toBe('loom/people');
    const page = (await named()).at(-1)!;
    expect(page).toEqual([['/inbox', 'none', 'none'], ['/people', 'none', 'loom-tile-page']]);
    await moving.context().close();
  }, 60_000);
});
