/**
 * Home with many agents, on a phone (t-1869; Jonathan, 2026-11-05: "fine if you've got 1 of something and a nightmare
 * if you exceed that"), as the agent desktop has it since t-1959: up to four agents keep their cards; past four, a line
 * each (face, name, how it is in words), alphabetical, and the one that most wants you open as a card; nothing wider
 * than the phone.
 *
 * Runs where the app is built (npm run build) and a Chrome is installed (GitHub's runners have one).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { loadHousehold } from '../household.js';
import { clearPieceCache } from './pieces.js';

const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);
const TOKEN = 'home-rows-token';
const SIX = ['art', 'mark', 'flo', 'gus', 'ida', 'zed'];

/** A household of these agents, with a piece that says zed is broken and flo is working. */
async function household(tmp: string, agents: string[]): Promise<string> {
  const home = join(tmp, `hh-${agents.length}`);
  for (const a of agents) {
    await mkdir(join(home, 'agents', a), { recursive: true });
    await writeFile(join(home, 'agents', a, 'IDENTITY.md'), `# ${a[0].toUpperCase()}${a.slice(1)}\n\nCreed.\n`);
  }
  await writeFile(join(home, 'household.json'), JSON.stringify({ v: 1, agents, default: agents[0], owner: 'jonathan' }));
  return home;
}

describe.runIf(built && chrome)('Home with many agents', () => {
  let tmp: string;
  let browser: Browser;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    clearPieceCache();
    tmp = await mkdtemp(join(tmpdir(), 'loom-home-rows-'));
    for (const k of ['LOOM_HOME', 'XDG_CONFIG_HOME', 'PATH']) saved[k] = process.env[k];
    process.env.LOOM_HOME = join(tmp, 'managed');
    process.env.XDG_CONFIG_HOME = join(tmp, 'xdg');
    const manifest = { v: 2, tab: { label: 'Health' }, agents: {
      zed: { state: 'broken', reason: 'Its Discord bridge is down', readings: [] },
      flo: { state: 'working', reason: 'Answering in #pond', readings: [], doing: [{ text: 'Answering in #pond', kind: 'talk' }] },
    } };
    await mkdir(join(tmp, 'path'));
    await writeFile(join(tmp, 'path', 'loom-health'), `#!/bin/sh\ncase "$1 $2" in\n  "ui --json") echo '${JSON.stringify(manifest)}' ;;\n  "ui page") echo '{"title":"Health","sections":[]}' ;;\n  *) exit 1 ;;\nesac\n`);
    await chmod(join(tmp, 'path', 'loom-health'), 0o755);
    // Only this piece: the machine's own pieces would report on agents of the same names.
    process.env.PATH = [join(tmp, 'path'), '/usr/bin', '/bin'].join(delimiter);
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(tmp, { recursive: true, force: true });
  });

  async function home(agents: string[], width: number) {
    const hh = await household(tmp, agents);
    const handle: HttpServeHandle = await startHttpServer({ contextDir: join(hh, 'agents', agents[0]), host: '127.0.0.1', port: 0, household: loadHousehold(hh)!, token: TOKEN });
    const base = `http://127.0.0.1:${handle.port}`;
    const ctx = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 768, hasTouch: true, serviceWorkers: 'block' });
    await ctx.request.post(`${base}/login`, { form: { token: TOKEN }, maxRedirects: 0 });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(base);
    await page.waitForSelector('main h2', { timeout: 20_000 });
    const close = async () => { expect(errors).toEqual([]); await ctx.close(); await handle.close(); };
    return { page, close };
  }

  // The agent desktop's phone Home (docs/specs/agent-desk.md, "A phone"; t-1959): Needs you, then the agents
  // alphabetical; up to four a card each, past four a line each and the one that most wants you open as a card.
  const cards = (page: import('playwright-core').Page) => page.$$eval('.loom-phome .loom-bigcard', (cs) => cs.map((c) => c.getAttribute('data-agent')));
  const rows = (page: import('playwright-core').Page) => page.$$eval('.loom-phome .loom-rrow', (cs) => cs.map((c) => c.getAttribute('data-agent')));

  it('two agents on a phone: a card each, no rows, nothing wider than the phone', async () => {
    const { page, close } = await home(['art', 'mark'], 390);
    await page.waitForSelector('.loom-phome .loom-bigcard');
    expect(await cards(page)).toEqual(['art', 'mark']);
    expect(await rows(page)).toEqual([]);
    expect(await page.locator('.loom-phome .loom-needs-band').count()).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await close();
  }, 60_000);

  it('six agents on a phone: a line each, alphabetical, the one in a conversation open as a card, nothing wider than 390 px', async () => {
    const { page, close } = await home(SIX, 390);
    await page.waitForSelector('.loom-phome .loom-rrow');
    // Flo is answering in #pond (a conversation now): its card; the rest a line each, by name.
    expect(await cards(page)).toEqual(['flo']);
    expect(await rows(page)).toEqual(['art', 'gus', 'ida', 'mark', 'zed']);
    expect(await page.$$eval('.loom-phome [data-agent]', (cs) => cs.map((c) => c.getAttribute('data-agent')))).toEqual(['art', 'flo', 'gus', 'ida', 'mark', 'zed']);
    // Each line: its face, its name, how it is in words.
    const zed = page.locator('.loom-rrow[data-agent="zed"]');
    expect(await zed.getAttribute('aria-label')).toContain('Something’s broken');
    expect(await zed.locator('.loom-rrow__face [aria-label]').count()).toBeGreaterThan(0);
    expect(await page.locator('.loom-bigcard[data-agent="flo"] [data-row="now"] dd').textContent()).toBe('Answering in #pond');
    // Nothing wider than the phone: the page, and every box in it.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const boxes = await page.evaluate(() => [...document.querySelectorAll('main *')].map((e) => e.getBoundingClientRect()).filter((r) => r.width).map((r) => ({ left: r.left, right: r.right })));
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) { expect(b.right).toBeLessThanOrEqual(390.5); expect(b.left).toBeGreaterThanOrEqual(-0.5); }
    await close();
  }, 60_000);

  it('the line is at four: four agents keep their cards, five get lines', async () => {
    const four = await home(SIX.slice(0, 4), 390);
    await four.page.waitForSelector('.loom-phome .loom-bigcard');
    expect((await cards(four.page)).length).toBe(4);
    expect(await rows(four.page)).toEqual([]);
    await four.close();
    const five = await home(SIX.slice(0, 5), 390);
    await five.page.waitForSelector('.loom-phome .loom-rrow');
    expect((await rows(five.page)).length).toBe(4);
    expect((await cards(five.page)).length).toBe(1);
    await five.close();
  }, 60_000);

  it('under 1024 a wider screen is the same Home', async () => {
    const { page, close } = await home(SIX, 900);
    await page.waitForSelector('.loom-phome .loom-rrow');
    expect((await rows(page)).length).toBe(5);
    await close();
  }, 60_000);
});
