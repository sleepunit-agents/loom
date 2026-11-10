/** CI browser proof: the Projects index follows directory records without another page/feed request. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type Browser } from 'playwright-core';
import { loadHousehold, agentDir, createToken, type Household } from '../household.js';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { openProjectsStore } from '../backends/projects.js';
import { forgetProjectCounts } from './projects-pages.js';
import { pullNow } from '../collections/subs.js';
import { stopCommsWatch } from './comms-live.js';
vi.setConfig({ testTimeout: 60_000 });
const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);
describe.runIf(built && chrome)('Projects directory cards', () => {
  let h: Household, handle: HttpServeHandle, browser: Browser, token: string, base: string;
  const write = (slug: string, name: string, status: 'active' | 'paused' | 'done' = 'active') => {
    const s = openProjectsStore(agentDir(h, 'art'))!;
    try { s.write({ slug, name, status, summary: 'The project summary', links: { repos: ['github:acme/app'] } }); } finally { s.close(); }
  };
  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-project-directory-ui-'));
    mkdirSync(join(home, 'agents', 'art'), { recursive: true });
    writeFileSync(join(home, 'agents', 'art', 'IDENTITY.md'), '# Art\n');
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
    h = loadHousehold(home)!;
    token = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: 'directory-test' }).token;
    handle = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  });
  afterAll(async () => { await browser?.close(); stopCommsWatch(); await handle?.close(); if (h) rmSync(h.home, { recursive: true, force: true }); });
  it('adds the first project to an empty page, renames, pauses and archives it over shared rows', async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    try {
      await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
      const page = await ctx.newPage();
      const asked: string[] = [], sets: string[] = [];
      const emptyDelivered = page.waitForResponse(async (r) => {
        if (!r.url().includes('/collections/query')) return false;
        try {
          const queries = r.request().postDataJSON().queries as Array<{ id: string; type: string }>;
          const ids = new Set(queries.filter((q) => q.type === 'loom/project@^1').map((q) => q.id));
          const body = await r.json() as { answers: Array<{ id: string; rows?: unknown[]; error?: string; at?: number }> };
          return body.answers.some((a) => ids.has(a.id) && !a.error && a.rows?.length === 0 && typeof a.at === 'number');
        } catch { return false; }
      });
      page.on('request', (r) => {
        const u = new URL(r.url());
        if (u.pathname === '/projects' && r.resourceType() === 'fetch') asked.push(u.pathname);
        if (u.pathname === '/collections/query') sets.push(r.postData() ?? '');
      });
      await page.goto(`${base}/projects`);
      await page.getByText(/^No projects yet/).waitFor();
      await expect.poll(() => sets.some((s) => s.includes('loom/project@^1'))).toBe(true);
      // Creation must follow the empty answer, rather than racing the initial directory query.
      await emptyDelivered;
      const before = asked.length;
      write('new', 'First project'); await pullNow(h.home, 'loom/project');
      const card = page.locator('.pj-card[data-slug="new"]');
      await card.getByText('First project', { exact: true }).waitFor();
      await card.getByText(/Couldn't count what's waiting/).waitFor();
      write('new', 'Renamed project'); await pullNow(h.home, 'loom/project');
      await card.getByText('Renamed project', { exact: true }).waitFor();
      await expect(card.getByText('First project', { exact: true }).count()).resolves.toBe(0);
      write('new', 'Renamed project', 'paused'); await pullNow(h.home, 'loom/project');
      await expect.poll(() => card.locator('.pj-pill').getAttribute('data-status')).toBe('paused');
      const s = openProjectsStore(agentDir(h, 'art'))!;
      try { s.archive({ slug: 'new', reason: 'Done', actor: 'art' }); } finally { s.close(); }
      await pullNow(h.home, 'loom/project');
      await card.waitFor({ state: 'detached' });
      await page.getByText(/^No projects yet/).waitFor();
      expect(asked.length).toBe(before);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await ctx.close(); }
  });
  it('a mounted view replaces cached page cards against a warm directory and adopts fresh feed details', async () => {
    write('cached', 'Cached project');
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    try {
      await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
      const cached = await (await ctx.request.get(`${base}/projects`, { headers: { accept: 'application/json' } })).json();
      const page = await ctx.newPage();
      let reads = 0, queries = 0;
      page.on('request', (r) => { if (r.url().endsWith('/collections/query') && r.postData()?.includes('loom/project@^1')) queries++; });
      await page.goto(`${base}/projects`);
      const card = page.locator('.pj-card[data-slug="cached"]');
      await card.getByText('Nothing waiting on you', { exact: true }).waitFor();
      write('cached', 'Changed project'); await pullNow(h.home, 'loom/project');
      await card.getByText('Changed project', { exact: true }).waitFor();
      await card.getByText(/Couldn't count what's waiting/).waitFor();
      const warm = queries;
      await page.route('**/projects', async (route) => {
        if (route.request().resourceType() !== 'fetch') return route.continue();
        reads++; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(cached) });
      });
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await expect.poll(() => reads).toBeGreaterThan(0);
      await card.getByText(/Couldn't count what's waiting/).waitFor();
      await page.unroute('**/projects');
      forgetProjectCounts();
      const refreshed = page.waitForResponse((r) => new URL(r.url()).pathname === '/projects' && r.request().resourceType() === 'fetch');
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await refreshed;
      await card.getByText('Nothing waiting on you', { exact: true }).waitFor();
      expect(queries).toBe(warm);
    } finally { await ctx.close(); }
  });

});
