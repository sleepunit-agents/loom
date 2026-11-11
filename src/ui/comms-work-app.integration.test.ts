/**
 * Work in this thread, in a real browser (docs/specs/comms.md, "The panel"; criterion 26): at 1280 px, in the Comms
 * tile, the panel sits in the thread's band under who's in the conversation, always open (a phone's is folded to "Work (N)"), in the route's order with its
 * status words; at 390 px it's the folded "Work (N)" strip,
 * which opens on a tap; nothing is wider than the viewport, and no console errors. LOOM_SHOT_DIR, when set, keeps a
 * screenshot of each (the PR's evidence).
 *
 * Runs where the app is built (npm run build), a Chrome is installed and age is.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from '../household.js';
import { createConversationTables } from '../backends/conversations.js';
import { parseLoomBlock } from '../cli/pieces-managed.js';
import { adapterCall, openThread, setTitle } from '../comms.js';
import { clearPieceCache } from './pieces.js';
import { stopCommsWatch } from './comms-live.js';

const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);
const hasAge = spawnSync('sh', ['-c', 'command -v age && command -v age-keygen'], { encoding: 'utf-8' }).status === 0;
const shots = process.env.LOOM_SHOT_DIR;

// Times before the fixture thread's messages (a note's when is its message's time), so the order holds whenever it runs.
const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const LONG_TITLE = ('Make the comm screen frame thinner and preserve every word of this task title. '.repeat(3)).slice(0, 190);
const ITEMS = [
  { title: LONG_TITLE, ref: 't-1881', status: 'Blocked', tone: 'bad', when: ago(3), page: 'task/t-1881', made: true },
  { title: 'Move the YOU panel under the portrait', ref: 't-1882', status: 'In progress', when: ago(2), page: 'task/t-1882', made: true },
  { title: 'Old dock tidy', ref: 't-12', status: 'Done', tone: 'ok', when: ago(96), page: 'task/t-12' },
];
const CHANGES = [
  { title: 'loom#545 Comms: a thinner frame', ref: 'github:sleepunit-agents/loom#545', status: 'Waiting on you', tone: 'warn', when: ago(1), page: 'c/github/sleepunit-agents/loom/545', made: true },
];

function piece(home: string, name: string, label: string, items: unknown[]): void {
  const loom = parseLoomBlock({ sections: { thread: { label, argv: [`loom-${name}`, 'thread-feed', '--json'] } } }, name, [`loom-${name}`]);
  if (typeof loom === 'string') throw new Error(loom);
  const dir = join(home, 'pieces', name);
  mkdirSync(join(dir, 'current'), { recursive: true });
  writeFileSync(join(dir, 'piece.json'), JSON.stringify({ v: 1, name, source: { repo: 'x/y', commit: 'a'.repeat(40) }, package: name, version: '1', installed: 'x',
    bins: [`loom-${name}`], loom: { settings: [], services: [], ...loom } }));
  const bin = join(dir, 'current', 'cli');
  writeFileSync(bin, `#!${process.execPath}
if (process.argv[2] === 'ui') { console.log(JSON.stringify({ v: 2, owners: 2, tab: { label: '${label}' }, asks: [] })); process.exit(0); }
process.stdin.resume(); process.stdin.on('end', () => console.log(${JSON.stringify(JSON.stringify({ items }))}));
`);
  chmodSync(bin, 0o755);
  mkdirSync(join(home, 'pieces', 'bin'), { recursive: true });
  symlinkSync(bin, join(home, 'pieces', 'bin', `loom-${name}`));
}

describe.runIf(built && chrome && hasAge)('Work in this thread, in the app', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  let thread: { id: string };
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-work-app-'));
    mkdirSync(join(home, 'agents', 'art'), { recursive: true });
    writeFileSync(join(home, 'agents', 'art', 'IDENTITY.md'), '# Art E Fish\n\nCreed.\n');
    const db = new BetterSqlite3(join(home, 'agents', 'art', 'memories.db'));
    createConversationTables(db);
    db.close();
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
    for (const k of ['LOOM_HOME', 'XDG_CONFIG_HOME']) saved[k] = process.env[k];
    process.env.LOOM_HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    clearPieceCache();
    piece(home, 'tasks', 'Tasks', ITEMS);
    piece(home, 'changes', 'Changes', CHANGES);
    h = loadHousehold(home)!;
    token = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: 'jonathan' }).token;
    const o = openThread(h, process.env, h.members[0], { agent: 'art', id: 'aaaaaaaaaaaaaaaa', text: 'Make the comm screen frame thinner, and move YOU under the portrait. The dock bit was t-12.' });
    thread = o.thread;
    setTitle(h, o.thread, 'Comm screen polish', 'agent');
    adapterCall(h, process.env, { op: 'post', place: thread.id, agent: 'art', text: 'On it: t-1881 and t-1882, and the change is sleepunit-agents/loom#545. Notes in note:comms/polish.' });
    adapterCall(h, process.env, { op: 'status', place: thread.id, agent: 'art', status: 'done' });
    handle = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    stopCommsWatch();
    await handle?.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(h.home, { recursive: true, force: true });
  });

  async function open(width: number, phone: boolean): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
    const ctx = await browser.newContext(phone
      ? { viewport: { width, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, serviceWorkers: 'block' }
      : { viewport: { width, height: 900 }, serviceWorkers: 'block' });
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    await ctx.addInitScript(() => { localStorage.setItem('loom-look', 'neon'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1'); });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    return { ctx, page, errors };
  }
  async function fullTitle(page: Page) {
    const title = page.locator('.comms-work .loom-kit-title').first();
    expect(await title.textContent()).toBe(LONG_TITLE);
    const size = await title.evaluate((el) => ({ height: el.clientHeight, whole: el.scrollHeight, line: parseFloat(getComputedStyle(el).lineHeight) }));
    expect(size.height).toBeGreaterThan(size.line * 3);
    expect(size.whole).toBeLessThanOrEqual(size.height + 1);
  }
  const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  const widest = (page: Page) => page.evaluate(() => Math.max(...[...document.querySelectorAll('.comms-work, .comms-work *')].map((e) => e.getBoundingClientRect().right)));

  it('at 1280 px, in the Comms tile: the panel in the band under who\'s in the conversation, problems first, with words', async () => {
    const { ctx, page, errors } = await open(1280, false);
    try {
      await page.goto(`${base}/comms/${thread.id}`);
      const tile = page.locator('.loom-tile[data-tile="/comms"]');
      await page.waitForFunction(() => /Work \(5/.test(document.querySelector('.loom-tile .comms-work__toggle')?.textContent ?? ''));
      // In the band beside the comm screen (2026-11-07): who's in the conversation, then the work, its rows shown; under it
      // when the band stacks them, beside it (its own column) when the thread has room for three.
      const you = (await tile.locator('.comms-band .comms-people').boundingBox())!;
      const panel = (await tile.locator('.comms-band__side .comms-work').boundingBox())!;
      expect(panel.y > you.y || panel.x >= you.x + you.width).toBe(true);
      await tile.locator('.comms-work .loom-kit-row').first().waitFor();
      const rows = await tile.locator('.comms-work .loom-kit-row').evaluateAll((els) => els.map((e) => [e.querySelector('.loom-kit-status')!.textContent, e.querySelector('.loom-kit-meta')!.textContent]));
      expect(rows).toEqual([
        ['Blocked', 't-1881 · made here'],
        ['Waiting on you', 'sleepunit-agents/loom#545 · made here'],
        ['Note', 'note:comms/polish'],
        ['In progress', 't-1882 · made here'],
        ['Done', 't-12'],
      ]);
      expect(await tile.locator('.comms-work .loom-kit-row[href]').first().getAttribute('href')).toBe('/p/tasks/task/t-1881');
      const tones = await tile.locator('.loom-kit-status[data-tone]').evaluateAll((els) => Object.fromEntries(els.map((el) => [el.getAttribute('data-tone'), getComputedStyle(el).color])));
      expect(Object.keys(tones).sort()).toEqual(['bad', 'ok', 'warn']);
      const expectedTones = await page.evaluate(() => {
        const el = document.createElement('span'); document.body.append(el);
        const expected: Record<string, string> = {};
        for (const [tone, token] of [['bad', '--v-pink'], ['warn', '--v-yellow'], ['ok', '--v-text-3']]) { el.style.color = `var(${token})`; expected[tone] = getComputedStyle(el).color; }
        el.remove(); return expected;
      });
      expect(tones).toEqual(expectedTones);
      await fullTitle(page);
      // Its rows inside the tile: nothing past its edge.
      const t = (await tile.boundingBox())!;
      expect(await widest(page)).toBeLessThanOrEqual(t.x + t.width + 1);
      expect(await noSideways(page)).toBe(true);
      if (shots) await page.screenshot({ path: join(shots, 'after-1280.png') });
      expect(errors).toEqual([]);
    } finally { await ctx.close(); }
  }, 30_000);

  it('at 390 px: "Work (N)" folded, open on a tap, and nothing wider than the screen', async () => {
    const { ctx, page, errors } = await open(390, true);
    try {
      await page.goto(`${base}/comms/${thread.id}`);
      const toggle = page.locator('.comms-work__toggle');
      await page.waitForFunction(() => /Work \(5/.test(document.querySelector('.comms-work__toggle')?.textContent ?? ''));
      expect(await toggle.textContent()).toMatch(/^Work \(5 · 1 needs a look\)/);
      expect(await page.locator('.comms-work-content').isVisible()).toBe(false);
      if (shots) await page.screenshot({ path: join(shots, 'after-390-folded.png') });
      await toggle.tap();
      await page.locator('.comms-work .loom-kit-row').first().waitFor();
      expect(await page.locator('.comms-work .loom-kit-row').count()).toBe(5);
      await fullTitle(page);
      expect(await noSideways(page)).toBe(true);
      expect(await widest(page)).toBeLessThanOrEqual(390);
      if (shots) await page.screenshot({ path: join(shots, 'after-390-open.png') });
      expect(errors).toEqual([]);
    } finally { await ctx.close(); }
  }, 30_000);
});
