/**
 * The Comms app in a real browser (docs/specs/comms.md, "The app"; criteria 17-19): the list leading to a thread on a
 * phone, two panes on a desktop, the comm screen's frame and its face following the thread, a reply arriving live with
 * the signal transition, no console errors and no sideways scroll.
 *
 * Runs where the app is built (npm run build), a Chrome is installed and age is (the thread's words are encrypted).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from '../household.js';
import { createConversationTables } from '../backends/conversations.js';
import { adapterCall, openThread, postActivity } from '../comms.js';
import { stopCommsWatch } from './comms-live.js';

const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);
const hasAge = spawnSync('sh', ['-c', 'command -v age && command -v age-keygen'], { encoding: 'utf-8' }).status === 0;

describe.runIf(built)('the Comms chunk', () => {
  it('is its own: the first page carries none of it', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const assets = readdirSync(`${root}dist/web/assets`);
    expect(assets.some((f) => /^comms-.*\.js$/.test(f))).toBe(true);
    const index = readFileSync(`${root}dist/web/index.html`, 'utf-8');
    for (const f of assets.filter((x) => /^index-.*\.js$/.test(x) && index.includes(x))) {
      expect(readFileSync(`${root}dist/web/assets/${f}`, 'utf-8')).not.toContain('comms-screen__glass');
    }
  });
});

describe.runIf(built && chrome && hasAge)('the Comms app', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  let thread: { id: string; conversation: string };
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-comms-app-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a === 'art' ? 'Art E Fish' : 'Mark'}\n\nCreed.\n`);
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db'));
      createConversationTables(db);
      db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
    for (const k of ['LOOM_HOME', 'XDG_CONFIG_HOME']) saved[k] = process.env[k];
    process.env.LOOM_HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    h = loadHousehold(home)!;
    token = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: 'jonathan' }).token;
    const o = openThread(h, process.env, h.members[0], { agent: 'art', id: 'aaaaaaaaaaaaaaaa', text: 'Can we sketch the comm screen?' });
    thread = o.thread;
    postActivity(h, process.env, { conversation: thread.conversation, run: 'run-1', cards: [
      { id: 'c1', at: new Date().toISOString(), tool: 'Read', summary: 'Read web/src/desk.tsx', state: 'done' },
      { id: 'c2', at: new Date().toISOString(), tool: 'Bash', summary: 'Ran the tests', state: 'done' },
    ] });
    adapterCall(h, process.env, { op: 'post', place: thread.id, agent: 'art', text: 'Sure. A framed portrait, a **signal meter**, and the channel line. See t-12.', run: 'run-1' });
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

  async function open(phone: boolean): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
    const ctx = await browser.newContext(phone
      ? { viewport: { width: 430, height: 900 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, serviceWorkers: 'block' }
      : { viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    return { ctx, page, errors };
  }
  const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

  it('on a phone: the list, then the thread with its comm screen, its steps and the composer above the dock', async () => {
    const { ctx, page, errors } = await open(true);
    try {
      await page.goto(`${base}/comms`);
      await page.locator('.comms-row').first().waitFor();
      expect(await page.locator('.comms-row__title').first().textContent()).toBe('New thread with Art E Fish');
      expect(await noSideways(page)).toBe(true);
      await page.locator('.comms-row__btn').first().click();
      await page.locator('.comms-screen').waitFor();
      expect(await page.locator('.comms-screen__label').textContent()).toMatch(/^ART E FISH · CH 01 · LINK (OK|LOST)/);
      expect(await page.locator('.comms-steps__line').textContent()).toMatch(/2 steps · Ran the tests/);
      expect(await page.locator('.comms-reply').innerHTML()).toContain('href="/p/tasks/task/t-12"');
      // Each agent message carries the agent's face.
      expect(await page.locator('.comms-msg--agent .comms-msg__face').count()).toBeGreaterThan(0);
      // The YOU panel is the desktop's; a phone leaves it out.
      expect(await page.locator('.comms-screen__you').count()).toBe(0);
      const comp = await page.locator('.comms-composer').boundingBox();
      const vh = page.viewportSize()!.height;
      expect(comp!.y + comp!.height).toBeLessThanOrEqual(vh - 96 + 1);
      expect(await noSideways(page)).toBe(true);
      expect(errors).toEqual([]);
    } finally { await ctx.close(); }
  }, 30_000);

  it('on a desktop: two panes, the YOU panel, and a reply arriving live with the signal, then talking', async () => {
    const { ctx, page, errors } = await open(false);
    try {
      await page.goto(`${base}/comms/${thread.id}`);
      await page.locator('.comms-list').waitFor();
      await page.locator('.comms-thread').waitFor();
      expect(await page.locator('.comms-screen__you').count()).toBe(1);
      expect(await page.locator('.comms-screen').getAttribute('data-face')).toBe('idle');
      // The dock carries Comms.
      expect(await page.locator('[aria-label="Comms"]').count()).toBeGreaterThan(0);
      await page.waitForTimeout(400);
      const seen = page.waitForFunction(() => document.querySelector('.comms-screen')?.getAttribute('data-signal') === 'on', undefined, { timeout: 5000 });
      adapterCall(h, process.env, { op: 'post', place: thread.id, agent: 'art', text: 'And a scanline roll when a reply lands.' });
      await seen;
      const signalAt = Date.now();
      await page.waitForFunction(() => document.querySelector('.comms-screen')?.getAttribute('data-face') === 'talking', undefined, { timeout: 3000 });
      // The signal plays first, for its 250 ms: talking never starts with it.
      expect(Date.now() - signalAt).toBeGreaterThanOrEqual(150);
      expect(await page.locator('.comms-msg--agent').last().textContent()).toContain('scanline roll');
      // Then done, then back to the thread's own state.
      await page.waitForFunction(() => document.querySelector('.comms-screen')?.getAttribute('data-face') === 'complete', undefined, { timeout: 6000 });
      await page.waitForFunction(() => document.querySelector('.comms-screen')?.getAttribute('data-face') === 'idle', undefined, { timeout: 3000 });
      // No runtime installed here: a message from the composer can't be delivered, and the link says so.
      await page.locator('.comms-composer textarea').fill('Can you hear me?');
      await page.locator('.comms-composer__send').click();
      await page.waitForFunction(() => /NO CARRIER/.test(document.querySelector('.comms-screen__label')?.textContent ?? ''), undefined, { timeout: 5000 });
      expect(await page.locator('.comms-screen').getAttribute('data-face')).toBe('error');
      expect(await noSideways(page)).toBe(true);
      expect(errors).toEqual([]);
    } finally { await ctx.close(); }
  }, 30_000);

  it('an ask asked from the thread: drawn with its words, the face waiting on you, Allow once posted to its piece', async () => {
    const { ctx, page, errors } = await open(false);
    try {
      // A thread of its own, nothing failed in it (an error would rightly outrank the ask).
      const thread = openThread(h, process.env, h.members[0], { agent: 'art', id: 'dddddddddddddddd', text: 'Ship it when it\'s green?' }).thread;
      const ask = { id: 'a-00c0ffee', piece: 'approvals', text: 'OK to merge the comm screen PR?', why: 'CI is green.', if_yes: 'I merge it.', if_no: 'It waits.',
        fine: 'merge · github:acme/app#3@abc', actions: [{ action: 'allow', label: 'Allow once', tone: 'primary', fields: { id: 'a-00c0ffee' } }, { action: 'deny', label: 'Deny', tone: 'danger', fields: { id: 'a-00c0ffee' } }] };
      // The thread's answers carry the ask (as loom adds it from the approvals piece's manifest).
      await page.route(`**/comms/${thread.id}**`, async (route) => {
        const r = route.request();
        if (r.method() !== 'GET' || !(r.headers().accept ?? '').includes('json')) return route.continue();
        const res = await route.fetch();
        const body = await res.json();
        return route.fulfill({ response: res, json: { ...body, asks: [ask] } });
      });
      const posted: string[] = [];
      await page.route('**/act/approvals', async (route) => {
        posted.push(route.request().postData() ?? '');
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, message: 'Allowed once.' }) });
      });
      await page.goto(`${base}/comms/${thread.id}`);
      await page.locator('.comms-ask').waitFor();
      expect(await page.locator('.comms-ask__text').textContent()).toBe('OK to merge the comm screen PR?');
      expect(await page.locator('.comms-ask__either').textContent()).toContain('If you allowI merge it.');
      expect(await page.locator('.comms-ask__fine').textContent()).toBe('Exactly what this allows: merge · github:acme/app#3@abc');
      expect(await page.locator('.comms-screen').getAttribute('data-face')).toBe('needs-input');
      await page.getByRole('button', { name: 'Allow once' }).click();
      await page.locator('.comms-ask__said').waitFor();
      expect(posted).toHaveLength(1);
      const sent = new URLSearchParams(posted[0]);
      expect([sent.get('_action'), sent.get('id')]).toEqual(['allow', 'a-00c0ffee']);
      expect(sent.get('_csrf')).toMatch(/^[0-9a-f]{64}$/);
      expect(errors).toEqual([]);
    } finally { await ctx.close(); }
  }, 30_000);
});
