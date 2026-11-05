/**
 * An app's window finds its way around, and its side column is the app's (Jonathan, 2026-11-05: "I open tasks, I open
 * details for a particular task... I have no real way back to the task list"; "something in the vein of lately, but
 * related to what we're looking at"). In real Chrome, Neon Noir, over a piece that draws like the Tasks piece: a list
 * with filters, a chart of what was opened and done, and recently updated beside it; a task's own page; and a page
 * with nothing for the side.
 *
 * - The window's Back and Forward walk this app's own history: Back from a task is the list you came from, with its
 *   query and its scroll; Alt+← and Alt+→ do the same while the window has the keys, and leave the browser's Back
 *   alone; the browser's own Back still works, and agrees.
 * - The strip's trail ("Tasks › the task") goes up, folds its middle into "…" when it's long, and never scrolls.
 * - At 1280 the page's side sections are in the window's right-hand column; a page with none gets Recent here (this
 *   app's pages only). Nothing in the column scrolls sideways, whatever it holds.
 * - Narrower, and on a phone, they fold into one block at the top of the page, closed. A phone's back chevron goes to
 *   the page before this one in the app, as it was left.
 * - The chart's two series are two colours, named in its legend, though the app's tint is one of them.
 *
 * Runs where the app is built (npm run build) and a Chrome is installed (GitHub's runners have one).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

/** A word with nowhere to break, as an id or an address can be: the column must wrap it, not widen. */
const UNBROKEN = 'x'.repeat(240);
const LONG_TITLE = `A task whose title goes on ${'and on '.repeat(30)}past any strip`;

/** The piece: a list (its query said back in its intro, so a page shows which query it was opened at), with filters,
 * a chart and recently updated in the side column; a task's page, its facts at the side; and About, with nothing there. */
const PIECE = `#!/usr/bin/env node
const args = process.argv.slice(2).join(' ');
if (args === 'ui --json') { process.stdout.write(JSON.stringify({ v: 2, tab: { label: 'Tasks' } })); process.exit(0); }
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const req = JSON.parse(input || '{}');
  const q = req.query || {};
  const task = /^task\\/t-(\\d+)$/.exec(req.path || '');
  let page;
  if (req.path === '') {
    page = { title: 'Tasks', intro: 'sorted ' + (q.sort || 'priority') + (q.q ? ', finding ' + q.q : ''), sections: [
      { id: 'all', title: 'All', blocks: [{ type: 'list', items: Array.from({ length: 40 }, (_, i) => ({ text: i === 6 ? ${JSON.stringify(LONG_TITLE)} : 'Task ' + (i + 1), meta: 't-' + (i + 1), page: 'task/t-' + (i + 1) })) }] },
      { id: 'weeks', title: 'Opened and done', place: 'side', blocks: [{ type: 'chart', kind: 'bar', caption: 'Opened and done, by week',
        series: [{ key: 'opened', label: 'Opened', color: 'pink' }, { key: 'done', label: 'Done', color: 'olive' }],
        data: [{ label: 'Oct 20', opened: 4, done: 2 }, { label: 'Oct 27', opened: 3, done: 5 }, { label: 'This week', opened: 6, done: 4 }] }] },
      { id: 'show', title: 'Filter and sort', place: 'side', blocks: [{ type: 'filters', param: 'sort', search: 'Find a task',
        options: [{ value: '', label: 'Priority' }, { value: 'new', label: 'Newest' }, { value: 'updated', label: 'Updated' }] }] },
      { id: 'recent', title: 'Recently updated', place: 'side', blocks: [{ type: 'list', items: [
        { text: 'Task 3', meta: 'just now', page: 'task/t-3' },
        { text: ${JSON.stringify(UNBROKEN)}, meta: ${JSON.stringify(UNBROKEN)}, page: 'task/t-4' }] },
        { type: 'kv', items: [{ label: 'Ref', value: ${JSON.stringify(UNBROKEN)} }] }] },
    ] };
  } else if (task) {
    const n = Number(task[1]);
    page = { title: n === 7 ? ${JSON.stringify(LONG_TITLE)} : 'Task ' + n, sections: [
      { id: 'task', blocks: [{ type: 'prose', text: 'What it is for.' }, { type: 'link', text: 'Next task', page: 'task/t-' + (n + 1) }] },
      { id: 'facts', place: 'side', blocks: [{ type: 'kv', items: [{ label: 'Status', value: 'Open' }] }] },
    ] };
  } else if (req.path === 'about') {
    page = { title: 'About tasks', sections: [{ id: 'a', blocks: [{ type: 'text', text: 'Nothing for the side.' }] }] };
  } else page = { title: 'Not found', sections: [] };
  process.stdout.write(JSON.stringify(page));
});
`;

describe.runIf(built && chrome)('an app\'s window: Back, Forward, its trail and its side column', { timeout: 60_000 }, () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-app-nav-'));
    for (const a of ['art']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db')); createConversationTables(db); db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], default: 'art', owner: 'jonathan', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'loom-work'), PIECE);
    chmodSync(join(bin, 'loom-work'), 0o755);
    for (const k of ['LOOM_HOME', 'XDG_CONFIG_HOME', 'PATH']) saved[k] = process.env[k];
    process.env.LOOM_HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    process.env.PATH = `${bin}:${saved.PATH}`;
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

  async function screen(width: number, path: string, height = 800, phone = false): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: phone, isMobile: phone, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await ctx.addInitScript(() => { localStorage.setItem('loom-look', 'neon'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1'); });
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    (p as Page & { errors: string[] }).errors = errors;
    await p.goto(`${base}${path}`);
    await p.locator('main > *').first().waitFor();
    await p.waitForTimeout(300);
    return p;
  }
  const where = (p: Page) => { const u = new URL(p.url()); return u.pathname + u.search; };
  // (the strip's words are drawn in capitals: what they say is their text)
  const titled = (p: Page, title: string) => expect.poll(() => p.locator('#loom-window-title').textContent(), { timeout: 8000 }).toBe(title);
  const mainOf = (p: Page) => p.locator('.loom-window main');
  const step = (p: Page, which: 'Back' | 'Forward') => p.locator(`.loom-window__step[aria-label^="${which}"]`);

  it('1280: Back from a task is the list it came from, at its query and its scroll; Forward goes again; the browser\'s Back agrees', async () => {
    const p = await screen(1280, '/p/work?sort=new');
    await titled(p, 'Tasks');
    expect(await step(p, 'Back').isDisabled()).toBe(true);   // nowhere yet: the app opened here
    expect(await step(p, 'Forward').isDisabled()).toBe(true);
    await mainOf(p).evaluate((m) => { m.scrollTop = 400; });
    const top = await mainOf(p).evaluate((m) => m.scrollTop);
    expect(top).toBeGreaterThan(100);
    await p.locator('.loom-window main a[href$="/task/t-12"]').click();
    await titled(p, 'Task 12');
    expect(where(p)).toBe('/p/work/task/t-12');
    // The trail: the app, then this page.
    expect(await p.locator('.loom-window__trail a').allTextContents()).toEqual(['Tasks']);
    expect(await step(p, 'Back').getAttribute('aria-label')).toBe('Back to Tasks');
    await step(p, 'Back').click();
    await titled(p, 'Tasks');
    expect(where(p)).toBe('/p/work?sort=new');
    await expect.poll(() => mainOf(p).evaluate((m) => m.scrollTop)).toBe(top);
    expect(await step(p, 'Forward').getAttribute('aria-label')).toBe('Forward to Task 12');
    await step(p, 'Forward').click();
    await titled(p, 'Task 12');
    // A crumb goes up to the list as it was left (its query), as a new page.
    await p.locator('.loom-window__trail a', { hasText: 'Tasks' }).click();
    await titled(p, 'Tasks');
    expect(where(p)).toBe('/p/work?sort=new');
    // The browser's Back still goes back, and the window's history agrees with it.
    await p.goBack();
    await titled(p, 'Task 12');
    expect(where(p)).toBe('/p/work/task/t-12');
    expect(await step(p, 'Back').isDisabled()).toBe(false);
    expect((p as Page & { errors: string[] }).errors).toEqual([]);
    await p.context().close();
  });

  it('1280: Alt+← and Alt+→ are the window\'s Back and Forward while it has the keys, and nothing in a field', async () => {
    const p = await screen(1280, '/p/work?sort=updated');
    await titled(p, 'Tasks');
    await p.locator('.loom-window main a[href$="/task/t-2"]').click();
    await titled(p, 'Task 2');
    await p.locator('#loom-window-title').focus();
    await p.keyboard.press('Alt+ArrowLeft');
    await titled(p, 'Tasks');
    expect(where(p)).toBe('/p/work?sort=updated');
    await p.keyboard.press('Alt+ArrowRight');
    await titled(p, 'Task 2');
    // In a field, Alt+← is the field's (a word back, on a Mac): the page stays.
    await p.locator('.loom-window__step[aria-label^="Back"]').click();
    await titled(p, 'Tasks');
    const find = p.locator('.loom-window__side input[type="search"]');
    await find.fill('some words');
    await find.press('Alt+ArrowRight');
    await p.waitForTimeout(400);
    expect(where(p)).toBe('/p/work?sort=updated');
    // With nowhere to go that way, the window leaves the key to the browser: it doesn't swallow it.
    const swallowed = await p.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      const e = new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true, cancelable: true });
      dispatchEvent(e);
      return e.defaultPrevented;
    });
    expect(swallowed).toBe(false);
    await p.context().close();
  });

  it('1280: the side sections stand in the window\'s right-hand column, and nothing in it scrolls sideways', async () => {
    const p = await screen(1280, '/p/work');
    await titled(p, 'Tasks');
    const side = p.locator('aside.loom-window__side');
    await side.locator('.loom-chart').waitFor();
    // All three of the page's side sections are there, and none of them in the page itself; no fold either.
    for (const t of ['Opened and done', 'Filter and sort', 'Recently updated']) expect(await side.getByText(t, { exact: true }).count()).toBe(1);
    expect(await mainOf(p).locator('.loom-chart, input[type="search"]').count()).toBe(0);
    expect(await p.locator('.loom-side-fold').count()).toBe(0);
    // A fixed width, beside the page, inside the window.
    const box = await side.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(300);
    expect(box!.x + box!.width).toBeLessThanOrEqual(1280);
    // Never sideways: not the column, and nothing in it reaches past its edge (the unbroken word wraps).
    // (once the chart has measured the column: it draws at a default width for its first frame)
    const measure = () => side.evaluate((s) => {
      const r = s.getBoundingClientRect();
      const out = [...s.querySelectorAll('*')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.right > r.right + 0.5; })
        .map((e) => `${e.tagName}.${e.getAttribute('class') ?? ''}`);
      return { sw: s.scrollWidth, cw: s.clientWidth, out };
    });
    await expect.poll(async () => (await measure()).out, { timeout: 10_000 }).toEqual([]);
    const m = await measure();
    expect(m.sw).toBeLessThanOrEqual(m.cw);
    expect(await side.getByText(UNBROKEN).count()).toBeGreaterThan(0);
    // The filters work from the side, keeping the page's own query.
    await side.getByRole('radio', { name: 'Newest' }).click();
    await expect.poll(() => where(p)).toBe('/p/work?sort=new');
    await p.context().close();
  });

  it('1280: the chart\'s two series are two colours, each named in its legend, in an app whose tint is one of them', async () => {
    const p = await screen(1280, '/p/work');
    const chart = p.locator('aside.loom-window__side .loom-chart');
    await chart.waitFor();
    // Tasks wears olive (tint.ts): its page re-points --v-pink at olive, and its "Opened" pink went olive with it.
    expect(await mainOf(p).getAttribute('data-accent')).toBe('olive');
    expect(await chart.locator('.v-chart-legend__item').allInnerTexts()).toEqual(['Opened', 'Done']);
    const keys = await chart.locator('.v-chart-legend__item .v-chart-key').evaluateAll((ks) => ks.map((k) => getComputedStyle(k).backgroundColor));
    expect(new Set(keys).size).toBe(2);
    // The bars themselves: two fills, the legend's.
    const fills = await chart.locator('[data-slot="chart-mark"]').evaluateAll((ms) => [...new Set(ms.map((m) => getComputedStyle(m).fill))]);
    expect(fills.sort()).toEqual([...keys].sort());
    // Drawn shorter beside the page.
    expect((await chart.locator('[data-slot="chart-plot"]').boundingBox())!.height).toBeLessThan(200);
    await p.context().close();
  });

  it('1280: a page with nothing for the side gets Recent here, this app\'s pages only', async () => {
    const p = await screen(1280, '/appearance');
    await titled(p, 'Appearance');
    await p.goto(`${base}/p/work/task/t-5`); await titled(p, 'Task 5');
    await p.goto(`${base}/p/work/about`); await titled(p, 'About tasks');
    const recent = p.locator('nav.loom-window__side[aria-label="Recent here"]');
    await recent.waitFor();
    const names = await recent.locator('a').allInnerTexts();
    expect(names).toContain('Task 5');
    expect(names).not.toContain('Appearance');   // another app's page: not here
    expect(names).not.toContain('About tasks');   // the page you're on
    await p.context().close();
  });

  it('a long trail folds into "…" and the strip never scrolls', async () => {
    for (const w of [1024, 1280]) {
      const p = await screen(w, '/p/work');
      await p.locator('.loom-window main a[href$="/task/t-7"]').click();
      await titled(p, LONG_TITLE);
      const m = await p.locator('.loom-window__bar').evaluate((b) => ({ sw: b.scrollWidth, cw: b.clientWidth, where: (() => { const x = b.querySelector('.loom-window__where')!; return { sw: x.scrollWidth, cw: x.clientWidth }; })() }));
      expect(m.sw, `${w}: the strip`).toBeLessThanOrEqual(m.cw);
      expect(m.where.sw, `${w}: the trail`).toBeLessThanOrEqual(m.where.cw + 1);
      // The title is cut short, not the strip widened; the app's crumb stays.
      expect(await p.locator('.loom-window__trail a').first().textContent()).toBe('Tasks');
      await p.context().close();
    }
  });

  it('an agent\'s page starts its trail at the agent; squeezed, the middle folds into "…", which still goes up', async () => {
    const p = await screen(1024, '/a/art/people/nobody');
    await p.locator('.loom-window__trail').waitFor();
    expect(await p.locator('.loom-window__trail a').allTextContents()).toEqual(['art', 'People']);
    // A strip with less room than the trail needs (as a long agent's name and page would leave it): the middle folds
    // before the page's own name is cut short.
    await p.addStyleTag({ content: '.loom-window__where{max-width:150px}' });
    await expect.poll(() => p.locator('.loom-window__trail a').allTextContents()).toEqual(['art', '…']);
    const box = await p.locator('.loom-window__where').evaluate((x) => ({ sw: x.scrollWidth, cw: x.clientWidth }));
    expect(box.sw).toBeLessThanOrEqual(box.cw + 1);
    expect(await p.locator('#loom-window-title').evaluate((t) => t.scrollWidth <= t.clientWidth + 1)).toBe(true);
    expect(await p.locator('.loom-window__trail a', { hasText: '…' }).getAttribute('aria-label')).toBe('Up to People');
    await p.locator('.loom-window__trail a', { hasText: '…' }).click();
    await expect.poll(() => new URL(p.url()).pathname).toBe('/a/art/people');
    await p.context().close();
  });

  it('a narrower window (1024) folds the side sections into one closed block at the top of the page', async () => {
    const p = await screen(1024, '/p/work');
    await titled(p, 'Tasks');
    const fold = mainOf(p).locator('details.loom-side-fold');
    await fold.waitFor();
    expect(await fold.evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false);
    expect(await fold.locator('summary .loom-side-fold__name').innerText()).toBe('Filters & more');
    // At the top: before the page's own sections.
    expect(await mainOf(p).evaluate((m) => m.querySelector('.loom-side-fold')!.compareDocumentPosition(m.querySelector('[data-slot="card"]')!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();
    expect(await p.locator('.loom-window__side').count()).toBe(0);
    await p.context().close();
  });

  it('390 (a phone): the side folds at the top, closed; open, nothing scrolls sideways; the chevron goes back to the list as it was left', async () => {
    const p = await screen(390, '/p/work?sort=new', 844, true);
    const fold = p.locator('main details.loom-side-fold');
    await fold.waitFor();
    expect(await fold.evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false);
    expect(await fold.locator('.loom-chart').isVisible()).toBe(false);
    await fold.locator('summary').click();
    await fold.locator('.loom-chart').waitFor();
    const keys = await fold.locator('.v-chart-legend__item .v-chart-key').evaluateAll((ks) => ks.map((k) => getComputedStyle(k).backgroundColor));
    expect(new Set(keys).size).toBe(2);
    const m = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
    expect(m.sw).toBeLessThanOrEqual(m.iw);
    // The block itself, and everything in it, inside the screen (the page clips what overflows, so the page's own
    // width alone wouldn't tell).
    await expect.poll(() => fold.evaluate((d) => [d, ...d.querySelectorAll('*')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.right > innerWidth + 0.5; }).length), { timeout: 10_000 }).toBe(0);
    // A task, from the list at its query: the chevron is the way back to that list, not to the list's start.
    await p.locator('main a[href$="/task/t-9"]').click();
    await expect.poll(() => where(p)).toBe('/p/work/task/t-9');
    const chevron = p.locator('.loom-pbar__back');
    await chevron.waitFor();
    expect(await chevron.getAttribute('aria-label')).toBe('Back to Tasks');
    await chevron.click();
    await expect.poll(() => where(p)).toBe('/p/work?sort=new');
    await p.context().close();
    // A task opened straight from a link, in a new tab, has nothing before it in the app: the chevron is its parent.
    const q = await screen(390, '/p/work/task/t-3', 844, true);
    await q.locator('.loom-pbar__back').waitFor();
    await q.locator('.loom-pbar__back').click();
    await expect.poll(() => where(q)).toBe('/p/work');
    await q.context().close();
  });
});
