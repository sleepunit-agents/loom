/**
 * Home with many agents, on a phone (t-1869; Jonathan, 2026-11-05: "fine if you've got 1 of something and a nightmare
 * if you exceed that"): up to four agents keep their big cards; past four, a phone's Home is a row each (face, name,
 * how it is in words, its last line), worst first, each a link to that agent's page, and nothing wider than the phone.
 * A wide screen keeps its cards.
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
    await page.goto(base);
    await page.waitForSelector('main h2', { timeout: 20_000 });
    const close = async () => { await ctx.close(); await handle.close(); };
    return { page, close };
  }

  it('two agents on a phone: a card each, no rows', async () => {
    const { page, close } = await home(['art', 'mark'], 390);
    await page.waitForSelector('.loom-identity');
    expect(await page.locator('.loom-identity:visible').count()).toBe(2);
    expect(await page.locator('ul[aria-label="Agents"]').count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await close();
  }, 60_000);

  it('six agents on a phone: a row each, worst first, each linking to its agent, nothing wider than 390 px', async () => {
    const { page, close } = await home(SIX, 390);
    const list = page.locator('ul[aria-label="Agents"]');
    await list.waitFor({ state: 'visible' });
    // Before: six full cards. After: no card shows, and one row per agent.
    expect(await page.locator('.loom-identity:visible').count()).toBe(0);
    const rows = list.locator(':scope > li a');
    expect(await rows.count()).toBe(6);
    const hrefs = await rows.evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    // Broken zed first, then working flo, then the quiet ones as the household lists them.
    expect(hrefs).toEqual(['/a/zed', '/a/flo', '/a/art', '/a/mark', '/a/gus', '/a/ida']);
    const first = await rows.first().innerText();
    expect(first).toContain('Zed');
    expect(first).toContain('Something’s broken');
    expect(first).toContain('Its Discord bridge is down');
    expect(await rows.nth(1).innerText()).toContain('Answering in #pond');
    // Nothing wider than the phone: the page, and every row's own box.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const widest = await page.evaluate(() => Math.max(...[...document.querySelectorAll('main *')].map((e) => e.getBoundingClientRect().right)));
    expect(widest).toBeLessThanOrEqual(390);
    // A tap opens the agent.
    await rows.nth(1).click();
    await page.waitForURL(/\/a\/flo$/);
    await close();
  }, 60_000);

  it('six agents on a wide screen keep their cards', async () => {
    const { page, close } = await home(SIX, 900);
    await page.waitForSelector('.loom-identity');
    expect(await page.locator('.loom-identity:visible').count()).toBe(6);
    expect(await page.locator('ul[aria-label="Agents"]:visible').count()).toBe(0);
    await close();
  }, 60_000);
});
