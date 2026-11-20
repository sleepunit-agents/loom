/**
 * The Tasks page, as Jonathan's mock has it (t-1925, "Tasks: the list, with a side column"): the side column's chart
 * without a Show data button (the chart is the point), Find and sort as one search field, one sort switch and rows of
 * chips that never wrap, and a task row that opens in place to its goal, why and done-when, with Open task inside.
 * A fake tasks piece answers in the vocabulary (docs/extensions.md, "Blocks": list `more`, filters `switch` and
 * `chips`). Real Chrome: a 1920 and a 1280 desktop (one tile, the side column beside the list), a ~480 px tile beside
 * the Inbox and others, and a 390 phone.
 *
 * Runs where the app is built (npm run build) and a Chrome is installed (GitHub's runners have one).
 */
import { describe, it, expect as vexpect, beforeAll, afterAll, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { createToken, loadHousehold, type Household } from '../household.js';
import { createConversationTables } from '../backends/conversations.js';
import { closeAllBackends } from '../backends/index.js';
import { clearPieceCache } from './pieces.js';

vi.setConfig({ testTimeout: 90_000 });
const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);
const expect = Object.assign(((v: unknown, m?: string) => vexpect(v, m)) as typeof vexpect, vexpect,
  { poll: (f: () => unknown, o?: { timeout?: number }) => vexpect.poll(f, { timeout: 15_000, ...o }) }) as typeof vexpect;
const SHOTS = process.env.LOOM_TEST_SHOTS;

const task = (id: string, title: string, goal: string, why: string, doneWhen: string) => ({
  text: title, meta: `${goal} · ${id}`, page: `task/${id}`, avatar: 'A',
  more: { items: [{ label: 'Goal', value: goal }, { label: 'Why', value: why }, { label: 'Done when', value: doneWhen }], open: 'Open task' },
});
const PAGE = {
  title: 'Tasks', add: { page: 'new', label: 'New task' },
  sections: [
    { id: 'yours', title: 'Waiting on you · 1', tone: 'warn', fold: 'open', blocks: [{ type: 'list', who: true, items: [
      task('t-1901', 'Sign Claude Code in again before the saved login ends', 'Art\'s sessions keep running past November 22.', 'The saved login ends on November 22.', 'A fresh login is saved and a session starts with it.')] }] },
    { id: 'doing', title: 'In progress · 2', fold: 'open', blocks: [{ type: 'list', who: true, items: [
      task('t-1290', 'Make the field box installer survive power loss', 'An installer cut off mid-run picks up where it stopped on the next boot.', 'Two Livonia boxes came back with empty config files after a power cut.', 'A pulled plug mid-install recovers on boot, tested three times.'),
      task('t-1925', 'Desktop polish pass from Jonathan\'s walkthrough', 'loom\'s desktop feels like a real OS at every tile size.', 'The walkthrough found rough edges.', 'Every app matches its mock.')] }] },
    { id: 'show', title: 'Find and sort', place: 'side', blocks: [{
      type: 'filters', param: 'sort', search: 'Find a task', switch: true,
      options: [{ value: '', label: 'Priority' }, { value: 'new', label: 'Newest' }, { value: 'updated', label: 'Updated' }],
      chips: [
        { param: 'show', label: 'Status', options: [{ value: 'yours', label: 'Needs you' }, { value: 'doing', label: 'In progress' }, { value: 'blocked', label: 'Blocked' }, { value: 'open', label: 'Open' }, { value: 'done', label: 'Done' }] },
        { param: 'tag', label: 'Project', options: ['loom', 'pond', 'Art', 'Hocket', 'taskstore', 'wunder', 'backup'].map((t) => ({ value: t.toLowerCase(), label: t })) },
      ] }] },
    { id: 'weeks', title: 'Opened and done', place: 'side', blocks: [{
      type: 'chart', kind: 'bar', caption: 'By week', summary: { label: 'Open', value: '9', detail: '+2 this week' },
      series: [{ key: 'opened', label: 'Opened', color: 'pink' }, { key: 'done', label: 'Done', color: 'olive' }],
      data: ['Sep 15', 'Sep 22', 'Sep 29', 'Oct 6', 'Oct 13', 'Oct 20', 'Oct 27', 'This week'].map((label, i) => ({ label, opened: 3 + (i % 4), done: 2 + (i % 3) })) }] },
  ],
};

describe.runIf(built && chrome)('the Tasks page', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    clearPieceCache();
    const home = mkdtempSync(join(tmpdir(), 'loom-tasks-page-'));
    mkdirSync(join(home, 'agents', 'art'), { recursive: true });
    writeFileSync(join(home, 'agents', 'art', 'IDENTITY.md'), '# art\n');
    const db = new BetterSqlite3(join(home, 'agents', 'art', 'memories.db')); createConversationTables(db); db.close();
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], default: 'art', owner: 'jonathan', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
    for (const k of ['LOOM_HOME', 'XDG_CONFIG_HOME', 'PATH']) saved[k] = process.env[k];
    process.env.LOOM_HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'tasks.json'), JSON.stringify({ v: 2, tab: { label: 'Tasks' }, asks: [] }));
    writeFileSync(join(bin, 'page.json'), JSON.stringify(PAGE));
    // Two more pieces so a narrow tile has neighbours.
    for (const [n, l] of [['garden', 'Garden'], ['shed', 'Shed']]) {
      // Garden wants the big slot, so Tasks (which wants it too) lands beside it in a narrow tile.
      writeFileSync(join(bin, `${n}.json`), JSON.stringify({ v: 2, tab: { label: l, ...(n === 'garden' ? { fit: { big: true, ideal: 1300 } } : {}) } }));
      writeFileSync(join(bin, `loom-${n}`), `#!/bin/sh\ncase "$1 $2" in "ui --json") cat "${join(bin, `${n}.json`)}" ;; *) echo '{"title":"${l}","sections":[{"id":"a","blocks":[{"type":"text","text":"hi"}]}]}' ;; esac\n`);
      chmodSync(join(bin, `loom-${n}`), 0o755);
    }
    writeFileSync(join(bin, 'loom-tasks'), `#!/bin/sh\ncase "$1 $2" in\n  "ui --json") cat "${join(bin, 'tasks.json')}" ;;\n  "ui page") cat "${join(bin, 'page.json')}" ;;\n  *) exit 1 ;;\nesac\n`);
    chmodSync(join(bin, 'loom-tasks'), 0o755);
    process.env.PATH = `${bin}:${saved.PATH}`;
    h = loadHousehold(home)!;
    token = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: 'jonathan' }).token;
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

  async function open(width: number, height: number, phone = false): Promise<{ ctx: BrowserContext; p: Page }> {
    const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', serviceWorkers: 'block', ...(phone ? { isMobile: true, hasTouch: true } : {}) });
    await ctx.addInitScript(`localStorage.setItem('loom-look', 'neon'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    return { ctx, p: await ctx.newPage() };
  }

  /** Each chip row is one line: every chip at the same top, the row no taller than one chip (with its padding), and a
   * row that runs on scrolls sideways (the Project row, seven chips, is wider than the side column). The sort is one
   * switch of three, on one line. */
  async function findAndSortOneLine(scope: Locator) {
    const rows = scope.locator('.loom-chip-row');
    await expect.poll(() => rows.count()).toBe(2);
    for (let i = 0; i < 2; i++) {
      const r = await rows.nth(i).evaluate((el) => {
        const chips = [...el.children] as HTMLElement[];
        return { tops: new Set(chips.map((c) => Math.round(c.getBoundingClientRect().top))).size, chip: chips[0].offsetHeight, row: el.clientHeight, n: chips.length };
      });
      expect(r.tops, `chip row ${i}: every chip on one line`).toBe(1);
      expect(r.row, `chip row ${i}: one chip tall`).toBeLessThanOrEqual(r.chip + 12);
    }
    const tags = rows.nth(1);
    expect(await tags.evaluate((el) => getComputedStyle(el).overflowX)).toBe('auto');
    if (await tags.evaluate((el) => el.scrollWidth > el.clientWidth)) {
      // The last chip is reachable: scrolled to, it's inside the row.
      const last = tags.locator('[data-slot="toggle-group-item"]').last();
      await last.scrollIntoViewIfNeeded();
      expect(await tags.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
      const [lb, rb] = [await last.boundingBox(), await tags.boundingBox()];
      expect(lb!.x + lb!.width).toBeLessThanOrEqual(rb!.x + rb!.width + 1);
    }
    // Keyboard: a chip takes focus and shows it.
    const first = rows.nth(0).locator('[data-slot="toggle-group-item"]').first();
    await first.focus();
    expect(await first.evaluate((el) => el === document.activeElement)).toBe(true);
    // The sort is one switch of three, on one line.
    const sw = scope.locator('[aria-label="Sort"]').locator('[data-slot="toggle-group-item"]');
    const tops = await sw.evaluateAll((bs) => new Set(bs.map((b) => Math.round(b.getBoundingClientRect().top))).size);
    expect(tops).toBe(1);
    expect(await sw.count()).toBe(3);
  }

  /** No Show data button and no visible data table: the chart's numbers only in a visually hidden table. */
  async function chartWithoutData(scope: Locator) {
    await expect.poll(() => scope.locator('.loom-chart svg').count()).toBeGreaterThan(0);
    expect(await scope.getByRole('button', { name: /show data|hide data/i }).count()).toBe(0);
    const tables = await scope.locator('.loom-chart table').evaluateAll((ts) => ts.map((t) => ({ sr: t.classList.contains('v-sr'), clip: getComputedStyle(t).clipPath, pos: getComputedStyle(t).position })));
    expect(tables.length, 'the numbers are still there for a screen reader').toBeGreaterThan(0);
    // Visually hidden (clipped away, out of the flow), not drawn.
    expect(tables.every((t) => t.sr && t.clip === 'inset(50%)' && t.pos === 'absolute'), JSON.stringify(tables)).toBe(true);
  }

  /** A row opens in place to goal, why and done-when, with Open task inside; the page doesn't go anywhere. */
  async function rowOpensInPlace(p: Page, scope: Locator) {
    const before = p.url();
    const row = scope.getByRole('button', { name: /Make the field box installer survive power loss/ });
    await row.click();
    await expect.poll(() => row.getAttribute('aria-expanded')).toBe('true');
    const more = scope.locator('.loom-row-more');
    await expect.poll(() => more.count()).toBe(1);
    for (const t of ['Goal', 'Why', 'Done when', 'Two Livonia boxes came back', 'A pulled plug mid-install']) expect(await more.getByText(t).count(), t).toBeGreaterThan(0);
    const link = more.getByRole('link', { name: 'Open task' });
    expect(await link.getAttribute('href')).toMatch(/\/p\/tasks\/task\/t-1290$/);
    expect(p.url()).toBe(before);
    await row.click();
    await expect.poll(() => more.count()).toBe(0);
  }

  for (const [w, hgt] of [[1920, 1080], [1280, 800]] as const) {
    it(`at ${w}: the side column beside the list, its chart without Show data, Find and sort on single lines, rows opening in place`, async () => {
      const { ctx, p } = await open(w, hgt);
      await p.goto(`${base}/p/tasks`);
      // The desktop first (its tiles): the page drawn before them is replaced by its tile, and a field focused in it
      // with it.
      await p.locator('.loom-tiles .loom-tile').first().waitFor({ timeout: 20_000 });
      // A tile 1100 px wide or more has the side column beside the list (fixed width); a narrower one (1280's, beside
      // the desk's widgets) folds it at the top.
      await p.locator('aside.loom-side-col, .loom-side-fold').first().waitFor({ timeout: 20_000 });
      const column = await p.locator('aside.loom-side-col').count() > 0;
      if (w === 1920) expect(column, 'a 1920 desktop has the side column').toBe(true);
      if (!column) await p.locator('.loom-side-fold > summary').click();
      const side = p.locator('.loom-side-col');
      await chartWithoutData(side);
      await findAndSortOneLine(side);
      if (column) expect((await side.boundingBox())!.width).toBeLessThanOrEqual(300);
      await rowOpensInPlace(p, p.locator('main, .loom-tile').first());
      if (SHOTS) {
        await p.getByRole('button', { name: /Make the field box installer/ }).click();
        await p.locator('.loom-row-more').waitFor();
        await p.screenshot({ path: join(SHOTS, `tasks-${w}.png`) });
      }
      // A chip goes in the query; another joins it; the switch sets the sort. (A folded side column folds again when
      // the page changes: open it each time.)
      const unfold = async () => { if (!column && !(await p.locator('.loom-side-fold').evaluate((d) => (d as HTMLDetailsElement).open))) await p.locator('.loom-side-fold > summary').click(); };
      await side.locator('.loom-chip-row').first().getByRole('button', { name: 'In progress' }).click();
      await expect.poll(() => new URL(p.url()).searchParams.get('show')).toBe('doing');
      await unfold();
      await side.locator('.loom-chip-row').first().getByRole('button', { name: 'Needs you' }).click();
      await expect.poll(() => new URL(p.url()).searchParams.get('show')).toBe('yours,doing');
      await unfold();
      await side.locator('[aria-label="Sort"]').locator('[data-slot="toggle-group-item"]', { hasText: 'Newest' }).click();
      await expect.poll(() => new URL(p.url()).searchParams.get('sort')).toBe('new');
      expect(new URL(p.url()).searchParams.get('show')).toBe('yours,doing');
      await ctx.close();
    });
  }

  it('in a narrow tile beside others: side folded on top, chips on single lines, rows opening in place', async () => {
    const { ctx, p } = await open(1920, 1080);
    await p.goto(`${base}/inbox?t=*inbox`);
    await p.locator('.loom-tile').first().waitFor();
    for (const l of ['Garden', 'Shed', 'Tasks']) {
      const n = await p.locator('.loom-tile').count();
      await p.click(`.loom-dock-bar [data-part="item"][aria-label="${l}"]`);
      await expect.poll(() => p.locator('.loom-tile').count()).toBe(n + 1);
    }
    const tile = p.locator('.loom-tile[data-tile="/p/tasks"]');
    await tile.locator('.loom-side-fold').waitFor({ timeout: 20_000 });
    const tw = (await tile.boundingBox())!.width;
    expect(tw).toBeGreaterThan(300);
    expect(tw).toBeLessThan(700);
    // Folded, the chart is a line over the fold (t-1925): its number and its shape, one row high, before it's opened.
    const line = tile.locator('.loom-chartline');
    await line.waitFor();
    expect(await line.locator('.loom-chartline__num b').textContent()).toMatch(/^\d[\d,]*$/);
    expect(await line.locator('.loom-chartline__spark rect').count()).toBeGreaterThan(0);
    expect((await line.boundingBox())!.height).toBeLessThanOrEqual(48);
    expect(await line.evaluate((el) => el.compareDocumentPosition(el.parentElement!.querySelector('.loom-side-fold')!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();
    await tile.locator('.loom-side-fold > summary').click();
    await chartWithoutData(tile);
    await findAndSortOneLine(tile);
    await rowOpensInPlace(p, tile);
    if (SHOTS) {
      await tile.getByRole('button', { name: /Make the field box installer/ }).click();
      await tile.locator('.loom-row-more').waitFor();
      await p.screenshot({ path: join(SHOTS, `tasks-tile-${Math.round(tw)}.png`) });
    }
    // Nothing in the tile is wider than the tile.
    expect(await tile.locator('.loom-tile__page').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await ctx.close();
  });

  it('on a 390 phone: the same, and nothing wider than the phone', async () => {
    const { ctx, p } = await open(390, 844, true);
    await p.goto(`${base}/p/tasks`);
    const fold = p.locator('.loom-side-fold');
    await fold.waitFor({ timeout: 20_000 });
    await fold.locator('summary').click();
    const body = p.locator('body');
    await chartWithoutData(body);
    await findAndSortOneLine(body);
    await rowOpensInPlace(p, body);
    if (SHOTS) {
      await p.getByRole('button', { name: /Make the field box installer/ }).click();
      await p.locator('.loom-row-more').waitFor();
      await p.screenshot({ path: join(SHOTS, 'tasks-390.png'), fullPage: true });
    }
    expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await ctx.close();
  });
});
