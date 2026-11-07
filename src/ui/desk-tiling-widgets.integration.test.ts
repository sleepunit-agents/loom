/**
 * Desk tiling, phase 4 (docs/specs/desk-tiling.md, criteria 13, 14's widgets and 17 with widgets): Home's
 * widgets are tiles. A fresh device starts with the seed (widgets.ts SEED); with no app open they are the desktop, and with
 * apps open they move to the right edge (columns, a rail, or the strip). Chat on an agent's card opens its latest Comms
 * thread beside the rail; an agent's tile pins its card; × removes one; the + key and Find add them; they update live.
 * Real Chrome, Neon Noir.
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
import { createConversationTables, recordTurn, writeDigest } from '../backends/conversations.js';
import { closeAllBackends } from '../backends/index.js';
import { openThread } from '../comms.js';

const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);
const expect = Object.assign(((v: unknown, m?: string) => vexpect(v, m)) as typeof vexpect, vexpect,
  { poll: (f: () => unknown, o?: { timeout?: number }) => vexpect.poll(f, { timeout: 10_000, ...o }) }) as typeof vexpect;
const KEY = (label: string) => `.loom-dock-bar [data-part="item"][aria-label="${label}"]`;
type Box = { id: string; x: number; y: number; w: number; h: number };

describe.runIf(built && chrome)('desk tiling: widgets are tiles', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  let artLatest: string;
  let markLatest: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-desk-widgets-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db')); createConversationTables(db); db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', owner: 'jonathan', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
    for (const k of ['LOOM_HOME', 'XDG_CONFIG_HOME']) saved[k] = process.env[k];
    process.env.LOOM_HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    h = loadHousehold(home)!;
    token = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: 'jonathan' }).token;
    // Art's older thread, Art's latest, then Mark's, the household's newest: Chat on a card opens that agent's latest,
    // not the newest thread there is.
    const later = () => new Promise((r) => setTimeout(r, 30));
    openThread(h, process.env, h.members[0], { agent: 'art', id: 'aaaaaaaaaaaaaaaa', text: 'An older thread' });
    await later();
    artLatest = openThread(h, process.env, h.members[0], { agent: 'art', id: 'cccccccccccccccc', text: 'The latest with Art' }).thread.id;
    await later();
    markLatest = openThread(h, process.env, h.members[0], { agent: 'mark', id: 'bbbbbbbbbbbbbbbb', text: 'Mark\'s thread' }).thread.id;
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

  async function screen(width: number, height: number, path = '/'): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await ctx.addInitScript(`localStorage.setItem('loom-look', 'neon'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    await p.goto(`${base}${path}`);
    await p.locator('.loom-tiles').waitFor();
    await p.waitForTimeout(300);
    return p;
  }
  const query = (p: Page, k: string) => new URL(p.url()).searchParams.get(k);
  const labels = (p: Page) => p.$$eval('.loom-tile', (ts) => ts.map((t) => (t.getAttribute('aria-label') ?? '').replace(/^tile \d+ of \d+, /, '')));
  const widgets = (p: Page) => p.$$eval('[data-widget]', (ws) => ws.map((w) => w.getAttribute('data-widget')));
  const boxes = (p: Page, sel: string, id: string): Promise<Box[]> => p.$$eval(sel, (ts, id) => ts.map((t) => {
    const r = t.getBoundingClientRect();
    return { id: t.getAttribute(id) ?? '', x: r.x, y: r.y, w: r.width, h: r.height };
  }), id);

  for (const [w, hgt] of [[1280, 800], [1920, 1080]]) {
    it(`a fresh device starts with today's Home set, as the desktop, then beside the apps; Chat opens the latest thread beside the rail, at ${w}×${hgt}`, async () => {
      const p = await screen(w, hgt);
      // The seed (widgets.ts SEED), laid out as Home: Needs you, each agent's card, Vitals and Backup; no headline.
      await expect.poll(() => widgets(p)).toEqual(['needs', 'art', 'mark', 'vitals', 'backup']);
      expect(await p.locator('.loom-desk-home .loom-desk-headline').count()).toBe(0);
      expect(query(p, 'w')).toBe('needs,art,mark,vitals,backup');
      // An app opens: the widgets move to the right edge, never a split of their own (each at most 340 px wide).
      await p.click(KEY('Inbox'));
      await expect.poll(() => labels(p)).toEqual(['Inbox']);
      await p.locator('.loom-wrail').waitFor();
      const app = (await boxes(p, '.loom-tile', 'data-tile'))[0];
      for (const b of await boxes(p, '.loom-wrail [data-widget]', 'data-widget')) {
        expect(b.w, b.id).toBeLessThanOrEqual(340);
        expect(b.x, `${b.id} right of the app`).toBeGreaterThanOrEqual(app.x + app.w);
      }
      // Chat on Art's card: Comms opens last (next to the rail) on Art's latest thread.
      await p.locator('[data-widget="art"] button', { hasText: /chat/i }).or(p.locator('[data-widget="art"] button[aria-label="Chat with art"]')).first().click();
      await expect.poll(() => labels(p)).toEqual(['Inbox', 'Comms']);
      await expect.poll(() => new URL(p.url()).pathname).toBe(`/comms/${artLatest}`);
      expect(query(p, 't')).toBe('inbox,*comms');
      // and Mark's card: Mark's thread, in the Comms tile that's open
      await p.locator('[data-widget="mark"] button[aria-label^="Chat with"]').click();
      await expect.poll(() => new URL(p.url()).pathname).toBe(`/comms/${markLatest}`);
      expect(await labels(p)).toEqual(['Inbox', 'Comms']);
      await p.context().close();
    }, 60_000);
  }

  // "Pin card to the desktop" on an agent's pages: the agent's tile's strip carries it (an agent's pages are its tile).
  for (const [w, hgt] of [[1280, 800], [1920, 1080]]) it(`13. Pin card to the desktop on an agent's pages (its tile) adds its card; × removes a widget; the + key and Find add them, at ${w}×${hgt}`, async () => {
    const p = await screen(w, hgt, '/a/mark?t=*mark&w=needs');
    await expect.poll(() => labels(p)).toEqual(['mark']);
    expect(await widgets(p)).toEqual(['needs']);
    await p.locator('.loom-tile button[aria-label^="Pin"]').click();
    await expect.poll(() => widgets(p)).toEqual(['needs', 'mark']);
    expect(query(p, 'w')).toBe('needs,mark');
    expect(await p.locator('.loom-tile button[aria-pressed="true"]').count()).toBe(1);
    // ×
    await p.locator('[data-widget="needs"] .loom-wtile__x').click();
    await expect.poll(() => widgets(p)).toEqual(['mark']);
    expect(query(p, 'w')).toBe('mark');
    // the + key: what can go on the desktop; one already there says so
    await p.click(KEY('Add a widget'));
    const list = p.locator('[role="dialog"][aria-label="Add a widget"]');
    await list.waitFor();
    expect(await list.locator('button', { hasText: 'Mark' }).textContent()).toMatch(/on the desktop/);
    await list.locator('button', { hasText: 'Vitals' }).click();
    await expect.poll(() => widgets(p)).toEqual(['mark', 'vitals']);
    expect(await list.count()).toBe(0);
    // Find: "Add widget: …"
    await p.keyboard.press('Control+k');
    await p.locator('input[aria-label="Find anything"]').fill('backup');
    await p.locator('[role="option"]', { hasText: 'Add widget: Backup' }).click();
    await expect.poll(() => widgets(p)).toEqual(['mark', 'vitals', 'backup']);
    // one that's on the desktop already: the + key focuses it
    await p.click(KEY('Add a widget'));
    await list.locator('button', { hasText: 'Vitals' }).click();
    await expect.poll(() => p.evaluate(() => document.activeElement?.closest('[data-widget]')?.getAttribute('data-widget'))).toBe('vitals');
    // with no app and no widget: how to get some
    for (const id of ['mark', 'vitals', 'backup']) await p.locator(`[data-widget="${id}"] .loom-wtile__x`).click();
    await p.click(KEY('Home'));
    await expect.poll(() => p.getByText('Open an app from the dock, or add a widget with the + key.').count()).toBe(1);
    await p.context().close();
  }, 60_000);

  it('13. every widget is live: a new ask shows in Needs you without a reload', async () => {
    const p = await screen(1920, 1080, '/inbox?t=*inbox&w=needs,art');
    await p.locator('[data-widget="needs"]').waitFor();
    expect(await p.locator('[data-widget="needs"]').textContent()).not.toMatch(/recycle bin/);
    const art = agentDir(h, 'art');
    const conv = recordTurn(art, 'art', { venue: 'wake', place: 'lane:making', label: 't-738: sonarr', at: new Date().toISOString(), from: { kind: 'schedule' }, kind: 'wake' }, 'runtime:clock').conversation;
    writeDigest(art, { conversation: conv, run: 'r1' }, { summary: 'Checked.', needs_owner: { ask: 'OK to turn off the recycle bin on Sonarr for a quick rename?', why: 'Deleting takes hours.', if_yes: 'I turn it off.', if_no: 'I plan a rework.' } } as never);
    await expect.poll(() => p.locator('[data-widget="needs"]').textContent(), { timeout: 30_000 }).toMatch(/recycle bin/);
    await p.context().close();
  }, 60_000);

  for (const [w, hgt] of [[1280, 800], [1920, 1080]]) it(`14. a reload restores the widgets in their order, at ${w}×${hgt}`, async () => {
    const p = await screen(w, hgt, '/comms?t=inbox!,*comms&w=art,needs');
    await expect.poll(() => labels(p)).toEqual(['Inbox', 'Comms']);
    // two apps leave room for a rail: it stacks them in the order added
    const drawn = ['art', 'needs'];
    await expect.poll(() => widgets(p)).toEqual(drawn);
    await p.reload(); await p.locator('.loom-tile').first().waitFor();
    await expect.poll(() => widgets(p)).toEqual(drawn);
    expect(decodeURIComponent(new URL(p.url()).search)).toBe('?t=inbox!,*comms&w=art,needs');
    await p.context().close();
  }, 60_000);

  it('focus and reading order: the widgets as drawn, column by column, not as added (the board at 1920)', async () => {
    const p = await screen(1920, 1080, '/comms?t=*comms&w=art,needs');
    await expect.poll(() => p.locator('.loom-tiles').getAttribute('data-widgets')).toBe('board');
    const xs = Object.fromEntries((await boxes(p, '.loom-wrail [data-widget]', 'data-widget')).map((b) => [b.id, b.x]));
    expect(xs.needs).toBeLessThan(xs.art);
    expect(await widgets(p)).toEqual(['needs', 'art']);
    expect(query(p, 'w')).toBe('art,needs');
    await p.context().close();
  }, 60_000);

  it('a tile 1,100 px wide or wider sharing the screen, on a page with no side sections of its own, has Recent here', async () => {
    const p = await screen(3000, 1440, '/people?t=*people,inbox&w=');
    const people = p.locator('.loom-tile[data-tile="/people"]');
    expect(await people.evaluate((t) => t.getBoundingClientRect().width)).toBeGreaterThanOrEqual(1100);
    await people.locator('a[href^="/people/"]').first().click();
    await expect.poll(() => new URL(p.url()).pathname).toMatch(/^\/people\/./);
    await people.locator('.loom-tile__btn[aria-label^="Back"]').click();
    await expect.poll(() => new URL(p.url()).pathname).toBe('/people');
    await expect.poll(() => people.locator('nav.loom-tile__side[aria-label="Recent here"] a').count()).toBeGreaterThan(0);
    await p.context().close();
  }, 60_000);

  for (const [w, hgt] of [[1280, 800], [1920, 1080]]) it(`17. with Needs you, Art and Mark at ${w}×${hgt}: nothing overlaps, everything inside the desk, apps then widgets in the DOM`, async () => {
    const p = await screen(w, hgt, '/?w=needs,art,mark');
    const bars = await p.locator('.loom-top').evaluate((e) => e.getBoundingClientRect().bottom);
    const dock = await p.locator('.loom-dock-bar').evaluate((e) => e.getBoundingClientRect().top);
    for (const label of ['Inbox', 'Comms', 'People', 'Knowledge']) {
      await p.click(KEY(label));
      await expect.poll(() => labels(p)).toContain(label);
      await p.waitForTimeout(200);
      const all = [...await boxes(p, '.loom-tile', 'data-tile'), ...await boxes(p, '.loom-wrail [data-widget]', 'data-widget')];
      const rail = await p.locator('.loom-wrail').evaluate((e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
      // The rail itself is inside the desk; a widget is inside the rail (a rail taller than the desk scrolls inside
      // itself, so one below its fold is inside the rail's scroll, never over the dock).
      expect(rail.top, 'the rail: under the bars').toBeGreaterThanOrEqual(bars - 0.5);
      expect(rail.bottom, 'the rail: over the dock').toBeLessThanOrEqual(dock + 0.5);
      for (const t of all) {
        expect(t.x).toBeGreaterThanOrEqual(0); expect(t.x + t.w).toBeLessThanOrEqual(w);
        if (t.id.startsWith('/')) {
          expect(t.y, `${t.id}: under the bars`).toBeGreaterThanOrEqual(bars - 0.5);
          expect(t.y + t.h, `${t.id}: over the dock`).toBeLessThanOrEqual(dock + 0.5);
        } else expect(t.y, `${t.id}: inside the rail`).toBeGreaterThanOrEqual(rail.top - 0.5);
      }
      for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
        const [a, b] = [all[i], all[j]];
        expect(a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5, `${a.id}/${b.id}`).toBe(false);
      }
      expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      // DOM order: the apps in `t` order, then the widgets
      const order = await p.$$eval('.loom-tile, .loom-wrail [data-widget]', (es) => es.map((e) => e.getAttribute('data-tile') ?? `w:${e.getAttribute('data-widget')}`));
      const n = (await labels(p)).length;
      expect(order.slice(n)).toEqual(['w:needs', 'w:art', 'w:mark']);
    }
    await p.context().close();
  }, 60_000);

  it('the strip: no room for a rail beside the apps folds the widgets to 64 px keys that open their app', async () => {
    const p = await screen(1024, 768, '/comms?t=inbox,*comms&w=needs,art,mark');
    await expect.poll(() => p.locator('.loom-tiles').getAttribute('data-widgets')).toBe('strip');
    const keys = await boxes(p, '.loom-wrail [data-widget]', 'data-widget');
    expect(keys.map((k) => [k.id, Math.round(k.w), Math.round(k.h)])).toEqual([['needs', 64, 64], ['art', 64, 64], ['mark', 64, 64]]);
    await p.locator('[data-widget="art"] a').click();
    await expect.poll(() => labels(p)).toContain('art');
    await p.context().close();
  }, 60_000);


  it('Comms in a tile under 620 px is one pane (loom#565 measures its own box): the list, then the thread with its way back', async () => {
    const p = await screen(1280, 800, '/comms?t=people,*comms&w=needs');
    const comms = p.locator('.loom-tile[data-tile="/comms"]');
    await comms.locator('.comms-list').waitFor();
    expect(await comms.evaluate((t) => t.getBoundingClientRect().width)).toBeLessThan(620);
    // shown: there, and drawn (one pane at a time may leave the other out, or hide it)
    const shown = (sel: string) => comms.evaluate((t, sel) => { const e = t.querySelector(sel); return !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0; }, sel);
    expect(await shown('.comms-list')).toBe(true);
    expect(await shown('.comms-blank')).toBe(false);
    // a thread: only the thread, filling the tile, with Back to the list
    await comms.locator('.comms-row__btn').first().click();
    await expect.poll(() => new URL(p.url()).pathname).toMatch(/^\/comms\/th/);
    await comms.locator('.comms-thread').waitFor();
    expect(await shown('.comms-list')).toBe(false);
    const [tw, th] = await Promise.all([comms.locator('.comms-thread').evaluate((e) => e.getBoundingClientRect().width), comms.locator('.comms').evaluate((e) => e.getBoundingClientRect().width)]);
    expect(tw).toBeGreaterThan(th - 4);
    await comms.locator('button[aria-label="Back to threads"]').click();
    await expect.poll(() => new URL(p.url()).pathname).toBe('/comms');
    expect(await shown('.comms-list')).toBe(true);
    // wide again (Comms alone): two panes, the list beside the thread, and no Back
    await p.locator('.loom-tile[data-tile="/people"] button[aria-label="Close People"]').click();
    await expect.poll(() => comms.evaluate((t) => t.getBoundingClientRect().width)).toBeGreaterThan(620);
    await expect.poll(() => shown('.comms-blank')).toBe(true);
    await comms.locator('.comms-row__btn').first().click();
    await comms.locator('.comms-thread').waitFor();
    const two = async (page: Page, sel: string) => page.locator(sel).evaluate((c) => {
      const l = c.querySelector('.comms-list')!.getBoundingClientRect(), t = c.querySelector('.comms-thread')!.getBoundingClientRect();
      const back = c.querySelector<HTMLElement>('button[aria-label="Back to threads"]');
      return { list: Math.round(l.width), beside: t.left >= l.right - 1, back: !!back && getComputedStyle(back).display !== 'none' };
    });
    expect(await two(p, '.loom-tile[data-tile="/comms"] .comms')).toEqual({ list: 320, beside: true, back: false });
    await p.context().close();
  }, 60_000);
});
