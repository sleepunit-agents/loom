/**
 * The Comms app in a real browser (docs/specs/comms.md, "The app"; criteria 17-19): the list leading to a thread on a
 * phone, two panes on a desktop, the comm screen's frame and its face following the thread, a reply arriving live with
 * the signal transition, no console errors and no sideways scroll.
 *
 * Runs where the app is built (npm run build), a Chrome is installed and age is (the thread's words are encrypted).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from '../household.js';
import { createConversationTables } from '../backends/conversations.js';
import { adapterCall, COMMS_DB, openThread, postActivity, recordDelivery } from '../comms.js';
import { parseLoomBlock } from '../cli/pieces-managed.js';
import { clearPieceCache } from './pieces.js';
import { stopCommsWatch } from './comms-live.js';

const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
/** The comm screen's state when it changed, timed by the page's clock; and a state to wait for. */
type ScreenNote = { at: number; signal: string | null; face: string | null };
type ScreenStep = { signal: string } | { face: string };
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
    // Its first message went through (as the route records it, in the background).
    recordDelivery(h, o.thread, o.seq, { delivered: true, body: 'started' });
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
      // 1600: Comms beside the agents' rail still has room for its list beside the thread (docs/specs/agent-desk.md).
      : { viewport: { width: 1600, height: 900 }, serviceWorkers: 'block' });
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    // A desktop with no widgets beside Comms: room for the list beside the thread (comms.tsx ONE_PANE_BELOW).
    if (!phone) await ctx.addInitScript(() => { try { if (!localStorage.getItem('loom-tiles')) localStorage.setItem('loom-tiles', JSON.stringify({ t: [], m: [], w: [] })); } catch { /* private */ } });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    return { ctx, page, errors };
  }
  const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

  it('lets the owner choose a thread model, keeps the choice, and reports a failed save', async () => {
    const { ctx, page, errors } = await open(false);
    let selected = 'auto';
    let fail = false;
    await page.route('**/comms/*/model', async (route) => {
      const req = route.request();
      if (req.method() === 'POST') {
        if (fail) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'The runtime is unavailable.' }) });
        const body = req.postDataJSON() as { harness: string; _csrf: string };
        expect(body._csrf).toBeTruthy();
        selected = body.harness;
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ threadChoice: selected }) });
    });
    try {
      await page.goto(`${base}/comms/${thread.id}`);
      await page.getByRole('button', { name: 'Thread menu', exact: true }).click();
      await page.getByRole('menuitemradio', { name: 'Model: Auto', exact: false }).waitFor();
      await page.getByRole('menuitemradio', { name: 'Model: Codex', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent?.includes('Codex'));
      await page.getByRole('button', { name: 'Thread menu', exact: true }).click();
      await page.getByRole('button', { name: 'Thread menu', exact: true }).click();
      expect(await page.getByRole('menuitemradio', { name: 'Model: Codex', exact: false }).getAttribute('aria-checked')).toBe('true');
      fail = true;
      await page.getByRole('menuitemradio', { name: 'Model: Claude', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'The runtime is unavailable.' }).waitFor();
      expect(selected).toBe('codex');
      expect(await page.getByRole('menuitemradio', { name: 'Model: Codex', exact: false }).getAttribute('aria-checked')).toBe('true');
      expect(await noSideways(page)).toBe(true);
      expect(errors).toEqual(['Failed to load resource: the server responded with a status of 503 (Service Unavailable)']);
    } finally { await ctx.close(); }
  }, 30_000);

  it('on a phone: the list, then the thread with its comm screen, its steps and the composer above the dock', async () => {
    const { ctx, page, errors } = await open(true);
    try {
      await page.goto(`${base}/comms`);
      await page.locator('.comms-row').first().waitFor();
      expect(await page.locator('.comms-row__title').first().textContent()).toBe('New thread with Art E Fish');
      expect(await noSideways(page)).toBe(true);
      await page.locator('.comms-row__btn').first().click();
      await page.locator('.comms-screen').waitFor();
      // The channel line says what the agent is doing (t-1918): its last turn done, here.
      expect(await page.locator('.comms-screen__label').textContent()).toMatch(/^ART E FISH · DONE/);
      expect(await page.locator('.comms-steps__line').textContent()).toMatch(/2 steps · Ran the tests/);
      // t-12 is a chip only where this reader could open it (t-1979): no tasks piece here, so it ends as its words.
      await page.locator('.comms-reply [data-ref="t-12"]').waitFor({ state: 'attached' });
      await page.waitForTimeout(1500);
      expect(await page.locator('.comms-reply [data-ref="t-12"][data-chip]').count()).toBe(0);
      expect(await page.locator('.comms-reply a').count()).toBe(0);
      expect(await page.locator('.comms-reply').textContent()).toContain('See t-12.');
      // Each agent message carries the agent's face.
      expect(await page.locator('.comms-msg--agent .comms-msg__face').count()).toBeGreaterThan(0);
      // The band (who's in it, the work) is a desktop's; a phone's thread has its strip.
      expect(await page.locator('.comms-band').count()).toBe(0);
      const comp = await page.locator('.comms-composer').boundingBox();
      const vh = page.viewportSize()!.height;
      expect(comp!.y + comp!.height).toBeLessThanOrEqual(vh - 96 + 1);
      expect(await noSideways(page)).toBe(true);
      expect(errors).toEqual([]);
    } finally { await ctx.close(); }
  }, 30_000);

  it('on a desktop: two panes, the band with who\'s in it, and a reply arriving live with the signal, then talking', async () => {
    const { ctx, page, errors } = await open(false);
    try {
      await page.goto(`${base}/comms/${thread.id}`);
      await page.locator('.comms-list').waitFor();
      await page.locator('.comms-thread').waitFor();
      // Who's in the conversation: the agent and you, beside the comm screen in the band (2026-11-07).
      expect(await page.locator('.comms-band .comms-people li').allInnerTexts()).toEqual([expect.stringMatching(/Art E Fish/), expect.stringMatching(/you$/)]);
      expect(await page.locator('.comms-screen').getAttribute('data-face')).toBe('idle');
      // The dock carries Comms.
      expect(await page.locator('[aria-label="Comms"]').count()).toBeGreaterThan(0);
      // The screen's changes, logged in the page as they happen and timed by its own clock: the signal is on for only
      // 250 ms, so a poll from here can miss it whole or see it late on a loaded runner (both failed CI, t-1886).
      await page.evaluate(() => {
        const w = window as unknown as { screenLog: ScreenNote[] };
        w.screenLog = [];
        new MutationObserver((ms) => {
          for (const m of ms) {
            const el = m.target as Element;
            if (el.matches('.comms-screen')) w.screenLog.push({ at: performance.now(), signal: el.getAttribute('data-signal'), face: el.getAttribute('data-face') });
          }
        }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-signal', 'data-face'] });
      });
      // When the screen has been each of these in turn: the times, in the page's clock.
      const whenEach = (steps: ScreenStep[], timeout: number) => page.waitForFunction((steps) => {
        const log = (window as unknown as { screenLog: ScreenNote[] }).screenLog;
        const at: number[] = [];
        let i = -1;
        for (const step of steps) {
          i = log.findIndex((e, k) => k > i && ('signal' in step ? e.signal === step.signal : e.face === step.face));
          if (i < 0) return null;
          at.push(log[i].at);
        }
        return at;
      }, steps, { timeout }).then((h) => h.jsonValue() as Promise<number[]>);
      adapterCall(h, process.env, { op: 'post', place: thread.id, agent: 'art', text: 'And a scanline roll when a reply lands.' });
      const [signalAt, talkingAt] = await whenEach([{ signal: 'on' }, { face: 'talking' }], 8000);
      // The signal plays first, for its whole 250 ms counted from when it showed: talking never starts with it, and a
      // busy render doesn't shorten it (it did when the 250 ms counted from the ask: 33-115 ms on CI, t-1925).
      expect(talkingAt - signalAt).toBeGreaterThanOrEqual(240);
      expect(await page.locator('.comms-msg--agent').last().textContent()).toContain('scanline roll');
      // Then done, then back to the thread's own state.
      await whenEach([{ signal: 'on' }, { face: 'talking' }, { face: 'complete' }, { face: 'idle' }], 9000);
      // A switched body's reply names its harness on the channel line; one from the agent's own clears it.
      adapterCall(h, process.env, { op: 'post', place: thread.id, agent: 'art', text: 'On Codex for now.', on: 'Codex' });
      await page.waitForFunction(() => /· ON CODEX$/.test(document.querySelector('.comms-screen__label')?.textContent ?? ''), undefined, { timeout: 5000 });
      expect(await page.locator('.comms-screen__label').textContent()).toMatch(/^ART E FISH · (TALKING|DONE) · ON CODEX/);
      adapterCall(h, process.env, { op: 'post', place: thread.id, agent: 'art', text: 'Back on Claude.' });
      await page.waitForFunction(() => !/ON CODEX/.test(document.querySelector('.comms-screen__label')?.textContent ?? ''), undefined, { timeout: 5000 });
      await page.waitForFunction(() => document.querySelector('.comms-screen')?.getAttribute('data-face') === 'idle', undefined, { timeout: 12000 });
      // No runtime installed here: a message from the composer can't be delivered, and the link says so.
      // Shift+Enter is a new line; Enter sends (a desktop's keyboard; the Send button is the phone's).
      const box = page.locator('.comms-composer textarea');
      await box.fill('Can you hear me?');
      await box.press('Shift+Enter');
      await box.pressSequentially('Over.');
      expect(await box.inputValue()).toBe('Can you hear me?\nOver.');
      await box.press('Enter');
      await page.waitForFunction(() => /NO CARRIER/.test(document.querySelector('.comms-screen__label')?.textContent ?? ''), undefined, { timeout: 5000 });
      expect(await page.locator('.comms-screen').getAttribute('data-face')).toBe('error');
      expect(await noSideways(page)).toBe(true);
      expect(errors).toEqual([]);
    } finally { await ctx.close(); }
  }, 30_000);

  it('a turn that ends with nothing sent shows in the thread, live: "finished without replying", and what happened', async () => {
    const { ctx, page, errors } = await open(false);
    try {
      const opened = openThread(h, process.env, h.members[0], { agent: 'art', id: 'eeeeeeeeeeeeeeee', text: 'Anything?' });
      recordDelivery(h, opened.thread, opened.seq, { delivered: true, body: 'started' });
      await page.goto(`${base}/comms/${opened.thread.id}`);
      await page.locator('.comms-thread').waitFor();
      expect(await page.locator('.comms-msg--error').count()).toBe(0);
      // Delivered, nothing back: the face is thinking.
      expect(await page.locator('.comms-screen').getAttribute('data-face')).toBe('thinking');
      adapterCall(h, process.env, { op: 'status', place: opened.thread.id, agent: 'art', status: 'done', replied: false, run: 'run-00c0ffee0000' });
      const card = page.locator('.comms-msg--error', { hasText: 'Art finished without replying.' });
      await card.waitFor({ timeout: 10_000 });
      expect(await card.locator('a.comms-trace').getAttribute('href')).toBe(`/p/runtime/trace/${opened.thread.conversation}`);
      expect(await card.locator('a.comms-trace').textContent()).toBe('What happened');
      // The wait is over, as after a reply: not thinking for ever under its own "finished without replying".
      await page.waitForFunction(() => document.querySelector('.comms-screen')?.getAttribute('data-face') === 'idle', undefined, { timeout: 5000 });
      expect(errors).toEqual([]);
    } finally { await ctx.close(); }
  }, 30_000);

  it('on a desktop, in a box narrower than two panes fit (a narrow window, a tile): one pane, the list, then the thread or a new one with a way back', async () => {
    const { ctx, page, errors } = await open(false);
    try {
      // The box, not the screen: a desktop's Comms held to a width, as a tile or a narrow window holds it.
      const hold = (w: number | null) => page.evaluate((w) => {
        document.getElementById('hold')?.remove();
        if (w === null) return;
        const s = document.createElement('style'); s.id = 'hold'; s.textContent = `.comms { width: ${w}px !important; max-width: none !important; box-sizing: border-box; }`; document.head.append(s);
      }, w);
      const back = page.locator('.comms-thread .comms-back');
      await page.goto(`${base}/comms`);
      await page.locator('.comms-list').waitFor();
      await hold(560);
      await page.locator('.comms[data-one] .comms-list').waitFor({ timeout: 8000 });
      expect(await page.locator('.comms-thread, .comms-blank').count()).toBe(0);
      // The list's agents are their letters (t-1925 D): the pixel face is the comm screen's.
      const rows = await page.locator('.comms-row').count();
      expect(rows).toBeGreaterThan(0);
      expect(await page.locator('.comms-row .loom-letter').count()).toBe(rows);
      // A thread: the list makes way, and the threads fold out from the menu button in its header (t-1925 C).
      const menu = page.locator('.comms-thread .comms-drawer-btn');
      await page.locator('.comms-row__btn').first().click();
      await page.locator('.comms[data-one] .comms-thread').waitFor({ timeout: 8000 });
      expect(await page.locator('.comms-list').count()).toBe(0);
      expect(await back.count()).toBe(0);
      expect(await menu.getAttribute('aria-expanded')).toBe('false');
      await menu.click();
      const drawer = page.locator('.comms-drawer[role="dialog"]');
      await drawer.waitFor();
      expect(await menu.getAttribute('aria-expanded')).toBe('true');
      // Focus goes in (the open thread's row), Tab stays in, Esc closes and gives focus back to the menu button.
      expect(await page.evaluate(() => !!document.activeElement?.closest('.comms-drawer'))).toBe(true);
      for (let n = 0; n < 12; n++) await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('.comms-drawer'))).toBe(true);
      await page.keyboard.press('Escape');
      await expect.poll(() => drawer.count()).toBe(0);
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Threads');
      // The scrim closes it too; New thread from it opens in the pane, with the menu button.
      await menu.click(); await drawer.waitFor();
      await page.locator('.comms-drawer__scrim').click();
      await expect.poll(() => drawer.count()).toBe(0);
      await menu.click(); await drawer.waitFor();
      await drawer.locator('.comms-new').click();
      await page.locator('.comms[data-one] .comms-new-thread').waitFor({ timeout: 8000 });
      expect(await page.locator('.comms-new-thread .comms-drawer-btn').isVisible()).toBe(true);
      // Picking a thread in it opens that thread and closes it.
      await page.locator('.comms-new-thread .comms-drawer-btn').click(); await drawer.waitFor();
      await drawer.locator('.comms-row__btn').first().click();
      await page.locator('.comms[data-one] .comms-thread:not(.comms-new-thread)').waitFor({ timeout: 8000 });
      await expect.poll(() => drawer.count()).toBe(0);
      // /comms itself, one pane: the list, as before.
      await page.goto(`${base}/comms`);
      await page.locator('.comms-list').waitFor();
      await hold(560);
      await page.locator('.comms[data-one] .comms-list').waitFor({ timeout: 8000 });
      // The edge: 930 px is one pane, 931 two, side by side with no way back (beside the agents' rail the comm screen is
      // the rail's, so the band needs less: comms.tsx ONE_PANE_BELOW_RAIL). A thread open across it stays mounted.
      await page.locator('.comms-row__btn').first().click();
      await page.locator('.comms-thread:not(.comms-thread--opening) .comms-composer').waitFor();
      await page.locator('.loom-rscreen .comms-screen').waitFor();
      await page.locator('.comms-composer textarea').fill('a draft kept across the width');
      await hold(930);
      await page.waitForFunction(() => document.querySelector('.comms')?.hasAttribute('data-one'));
      await hold(931);
      await page.locator('.comms:not([data-one]) .comms-list').waitFor({ timeout: 8000 });
      expect(await page.locator('.comms-thread').count()).toBe(1);
      expect(await back.count()).toBe(0);
      expect(await page.locator('.comms-composer textarea').inputValue()).toBe('a draft kept across the width');
      await hold(930);
      await page.locator('.comms[data-one] .comms-thread').waitFor({ timeout: 8000 });
      expect(await page.locator('.comms-composer textarea').inputValue()).toBe('a draft kept across the width');
      await hold(null);
      await page.locator('.comms:not([data-one]) .comms-list').waitFor({ timeout: 8000 });
      expect(errors).toEqual([]);
    } finally { await ctx.close(); }
  }, 45_000);

  it('an ask asked from the thread: drawn with its words, the face waiting on you, Allow once posted to its piece', async () => {
    const { ctx, page, errors } = await open(false);
    try {
      // A thread of its own, nothing failed in it (an error would rightly outrank the ask).
      const opened = openThread(h, process.env, h.members[0], { agent: 'art', id: 'dddddddddddddddd', text: 'Ship it when it\'s green?' });
      const thread = opened.thread;
      recordDelivery(h, thread, opened.seq, { delivered: true, body: 'started' });
      const ask = { key: '00000000c0ffee00', ref: 'approval:a-00c0ffee', at: new Date().toISOString(), state: 'open', kind: 'permission', text: 'OK to merge the comm screen PR?', why: 'CI is green.', if_yes: 'I merge it.', if_no: 'It waits.',
        fine: 'merge · github:acme/app#3@abc', decide: { allow: { action: 'allow', label: 'Allow once', tone: 'primary', fields: { id: 'a-00c0ffee' } }, deny: { action: 'deny', label: 'Deny', tone: 'danger', fields: { id: 'a-00c0ffee' } }, source: { id: 'approvals', base: '/p/approvals/' } } };
      // The thread's answers carry the ask (as loom adds it from the approvals piece's manifest).
      await page.route(`**/comms/${thread.id}**`, async (route) => {
        const r = route.request();
        if (r.method() !== 'GET' || !(r.headers().accept ?? '').includes('json')) return route.continue();
        // A read still on its way as the page closes (the thread reads again on loom's live stream) ends with it.
        try {
          const res = await route.fetch();
          const body = await res.json();
          return await route.fulfill({ response: res, json: { ...body, asks: [ask] } });
        } catch { return undefined; }
      });
      // loom says it's open (ask-open.ts): asked when it's shown, and again right before Allow is sent.
      const asked: string[] = [];
      await page.route('**/inbox/open?*', (route) => { asked.push(new URL(route.request().url()).searchParams.get('k')!); return route.fulfill({ json: { open: true } }); });
      const posted: string[] = [];
      await page.route('**/act/approvals', async (route) => {
        posted.push(route.request().postData() ?? '');
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, message: 'Allowed once.' }) });
      });
      await page.goto(`${base}/comms/${thread.id}`);
      await page.locator('.comms-ask').waitFor();
      expect(await page.locator('.comms-ask h3').textContent()).toBe('OK to merge the comm screen PR?');
      expect(await page.locator('.comms-ask__either').textContent()).toContain('If you allowI merge it.');
      expect(await page.locator('.comms-ask__fine').textContent()).toBe('Exactly what this allows: merge · github:acme/app#3@abc');
      expect(await page.locator('.comms-screen').getAttribute('data-face')).toBe('needs-input');
      await page.getByRole('button', { name: 'Allow once' }).click();
      await page.locator('.comms-ask__said').waitFor();
      expect(posted).toHaveLength(1);
      expect(asked.filter((a) => a === '00000000c0ffee00').length).toBeGreaterThanOrEqual(2);
      const sent = new URLSearchParams(posted[0]);
      expect([sent.get('_action'), sent.get('id')]).toEqual(['allow', 'a-00c0ffee']);
      expect(sent.get('_csrf')).toMatch(/^[0-9a-f]{64}$/);
      expect(errors).toEqual([]);
    } finally { await ctx.close(); }
  }, 30_000);

  for (const how of ['closed', 'offline', 'cached'] as const) {
    it(`an ask shown from a copy, loom ${how === 'closed' ? 'saying it\'s answered' : how === 'offline' ? 'unreachable' : 'answering from this device\'s copy'}: no live Allow, and nothing sent`, async () => {
      const { ctx, page } = await open(false);
      try {
        const opened = openThread(h, process.env, h.members[0], { agent: 'art', id: { closed: 'eeeeeeeeeeeeeeef', offline: 'eeeeeeeeeeeeeeeg', cached: 'eeeeeeeeeeeeeeeh' }[how], text: 'Ship it?' });
        recordDelivery(h, opened.thread, opened.seq, { delivered: true, body: 'started' });
        const ask = { key: '000000000000dead', ref: 'approval:a-0000dead', at: new Date().toISOString(), state: 'open', kind: 'permission', text: 'OK to merge it?',
          decide: { allow: { action: 'allow', label: 'Allow once', tone: 'primary', fields: { id: 'a-0000dead' } }, deny: { action: 'deny', label: 'Deny', tone: 'danger', fields: { id: 'a-0000dead' } }, source: { id: 'approvals', base: '/p/approvals/' } } };
        await page.route(`**/comms/${opened.thread.id}**`, async (route) => {
          const r = route.request();
          if (r.method() !== 'GET' || !(r.headers().accept ?? '').includes('json')) return route.continue();
          try {
            const res = await route.fetch();
            return await route.fulfill({ response: res, json: { ...(await res.json()), asks: [ask] } });
          } catch { return undefined; }
        });
        // A copy (the service worker's, stamped x-loom-saved-at) can't tell, even one that says open.
        await page.route('**/inbox/open?*', (route) => (how === 'closed' ? route.fulfill({ json: { open: false } }) : how === 'cached'
          ? route.fulfill({ json: { open: true }, headers: { 'x-loom-saved-at': String(Date.now() - 3_600_000) } }) : route.abort('internetdisconnected')));
        let posted = 0;
        await page.route('**/act/approvals', (route) => { posted++; return route.fulfill({ json: { ok: true } }); });
        await page.goto(`${base}/comms/${opened.thread.id}`);
        await page.locator('.comms-ask').waitFor();
        const said = page.locator('.comms-ask [data-live]');
        await expect.poll(() => said.getAttribute('data-live'), { timeout: 8000 }).toBe(how === 'closed' ? 'gone' : 'unknown');
        expect(await page.getByRole('button', { name: 'Allow once' }).isDisabled()).toBe(true);
        await page.getByRole('button', { name: 'Allow once' }).click({ force: true }).catch(() => undefined);
        await page.waitForTimeout(300);
        expect(posted).toBe(0);
      } finally { await ctx.close(); }
    }, 30_000);
  }

  it('a run\'s steps open to a now: line with the plan\'s item, and like steps in a row fold into one line that opens (t-1944)', async () => {
    const o = openThread(h, process.env, h.members[0], { agent: 'mark', id: 'stepsstepsstepsz', text: 'What are you on?' });
    recordDelivery(h, o.thread, o.seq, { delivered: true, body: 'started' });
    const at = new Date().toISOString();
    postActivity(h, process.env, { conversation: o.thread.conversation, run: 'run-s', cards: [
      { id: 's0', at, tool: 'todo_list', summary: 'Plan (1/3): Run the approvals tests', state: 'done' },
      { id: 's1', at, tool: 'command_execution', summary: 'Read delivery.mjs (lines 120–180)', state: 'done' },
      { id: 's2', at, tool: 'command_execution', summary: 'Ran git status', state: 'done' },
      { id: 's3', at, tool: 'command_execution', summary: 'Ran npm ci', state: 'done' },
      { id: 's4', at, tool: 'command_execution', summary: 'Ran npm test', state: 'done' },
      { id: 's5', at, tool: 'command_execution', summary: 'Ran npm test — exit 1: 3 tests failed', state: 'failed' },
      { id: 's6', at, tool: 'mcp_tool_call', summary: 'Messaged art: "Can you review loom#612?"', state: 'running' },
    ] });
    const { ctx, page, errors } = await open(true);
    try {
      await page.goto(`${base}/comms/${o.thread.id}`);
      const line = page.locator('.comms-steps > .comms-steps__line');
      await line.waitFor();
      // The plan isn't a step.
      expect(await line.textContent()).toMatch(/6 steps · Messaged art: "Can you review loom#612\?"/);
      await line.click();
      expect(await page.locator('.comms-steps__now').textContent()).toBe('now: Messaged art: "Can you review loom#612?"Plan (1/3): Run the approvals tests');
      const group = page.locator('.comms-steps__group');
      expect(await group.count()).toBe(1);
      expect(await group.locator('summary').textContent()).toBe('Ran 3 commands · Ran npm test');
      expect(await group.locator('li').first().isVisible()).toBe(false);
      await group.locator('summary').click();
      expect(await group.locator('li').count()).toBe(3);
      expect(await group.locator('li').first().isVisible()).toBe(true);
      // The failure stays its own line, with why.
      expect(await page.locator('.comms-steps li[data-state="error"]').textContent()).toContain('exit 1: 3 tests failed');
      expect(await noSideways(page)).toBe(true);
      expect(errors).toEqual([]);
    } finally { await ctx.close(); }
  }, 30_000);
});

// In this file, not its own, so its browser never runs beside the one above (vitest runs files in parallel, and the
// signal timing above is measured).
/*
 * Comms delivery, as the owner sees it (t-1881, Jonathan's first real use, 2026-11-05): a message whose body takes a
 * while to start is on its way, never "Not delivered"; "Not delivered" shows only for a failure the server recorded;
 * Send again visibly sends again, and delivers exactly once. In a real browser, against a runtime stand-in that takes
 * as long to answer as a house's body took that day (about 20 s), or that refuses.
 *
 * Runs where the app is built (npm run build), a Chrome is installed and age is (the thread's words are encrypted).
 */
/** The runtime, standing in: each delivery logged, answered after `runtime-delay` ms, or refused (`runtime-mode` said). */
const RUNTIME_BIN = `#!${process.execPath}
const fs = require('node:fs');
const home = process.env.LOOM_HOME;
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  if (process.argv[2] === 'api') return console.log(JSON.stringify({ status: 200, body: { exit: 0, stdout: '{}', stderr: '' } }));
  fs.appendFileSync(home + '/runtime-calls.jsonl', input + '\\n');
  const read = (f, d) => (fs.existsSync(home + '/' + f) ? fs.readFileSync(home + '/' + f, 'utf-8').trim() : d);
  const mode = read('runtime-mode', 'ok');
  setTimeout(() => {
    if (mode === 'said') { console.log(JSON.stringify({ status: 503, error: 'no house free for art' })); process.exit(1); }
    console.log(JSON.stringify({ conversation: 'cv-0123456789ab', seq: 1, body: 'started' }));
  }, Number(read('runtime-delay', '0')));
});
`;

function piece(home: string, name: string, raw: Record<string, unknown>, body: string): void {
  const loom = parseLoomBlock(raw, name, [`loom-${name}`]);
  if (typeof loom === 'string') throw new Error(`${name}: ${loom}`);
  const dir = join(home, 'pieces', name);
  mkdirSync(join(dir, 'current'), { recursive: true });
  writeFileSync(join(dir, 'piece.json'), JSON.stringify({ v: 1, name, source: { repo: 'x/y', commit: 'a'.repeat(40) }, package: name, version: '1', installed: 'x',
    bins: [`loom-${name}`], loom: { settings: [], services: [], ...loom } }));
  const bin = join(dir, 'current', 'cli');
  writeFileSync(bin, body);
  chmodSync(bin, 0o755);
  mkdirSync(join(home, 'pieces', 'bin'), { recursive: true });
  symlinkSync(bin, join(home, 'pieces', 'bin', `loom-${name}`));
}

describe.runIf(built && chrome && hasAge)('Comms delivery, as the owner sees it', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  let n = 0;
  const saved: Record<string, string | undefined> = {};
  const calls = () => { const f = join(h.home, 'runtime-calls.jsonl'); return existsSync(f) ? readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: string; text: string }) : []; };
  const rows = (thread: string) => {
    const db = new BetterSqlite3(join(h.home, COMMS_DB), { readonly: true });
    try { return db.prepare('SELECT seq, kind, delivered, card_json FROM comms_messages WHERE thread = ? ORDER BY seq').all(thread) as Array<{ seq: number; kind: string; delivered: number | null; card_json: string | null }>; } finally { db.close(); }
  };
  const runtime = (mode: 'ok' | 'said', delayMs: number) => { writeFileSync(join(h.home, 'runtime-mode'), mode); writeFileSync(join(h.home, 'runtime-delay'), String(delayMs)); };

  beforeAll(async () => {
    clearPieceCache();
    const home = mkdtempSync(join(tmpdir(), 'loom-comms-delivery-'));
    mkdirSync(join(home, 'agents', 'art'), { recursive: true });
    writeFileSync(join(home, 'agents', 'art', 'IDENTITY.md'), '# Art E Fish\n\nCreed.\n');
    const db = new BetterSqlite3(join(home, 'agents', 'art', 'memories.db'));
    createConversationTables(db);
    db.close();
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
    for (const k of ['LOOM_HOME', 'XDG_CONFIG_HOME']) saved[k] = process.env[k];
    process.env.LOOM_HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    piece(home, 'runtime', { role: 'runtime', delivery: ['loom-runtime', 'deliver', '--json'] }, RUNTIME_BIN);
    h = loadHousehold(home)!;
    token = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: 'jonathan' }).token;
    handle = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    stopCommsWatch();
    await handle?.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    clearPieceCache();
    rmSync(h.home, { recursive: true, force: true });
  });

  async function open(thread: string): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/comms/${thread}`);
    await page.locator('.comms-composer textarea').waitFor();
    return { ctx, page, errors };
  }
  const thread = () => openThread(h, process.env, h.members[0], { agent: 'art', id: `aaaaaaaaaaaaaab${'abcdefghijklmnop'[n++]}`, text: 'Testing Comms from loom' }).thread;
  const notDelivered = (page: Page) => page.locator('.comms-resend').count();
  const status = (page: Page) => page.locator('.comms-msg--mine').last().getAttribute('data-delivery');
  const lastIs = (page: Page, want: string, timeout: number) => page.waitForFunction((w) => [...document.querySelectorAll('.comms-msg--mine')].at(-1)?.getAttribute('data-delivery') === w, want, { timeout });

  it('a message whose body takes 20 s to start shows as on its way the whole time, never Not delivered, and no error is recorded', async () => {
    runtime('ok', 20_000);
    const t = thread();
    const { ctx, page, errors } = await open(t.id);
    try {
      const before = calls().length;
      const sentAt = Date.now();
      await page.locator('.comms-composer textarea').fill('A second message, while its body starts');
      await page.locator('.comms-composer .v-agent-chat__send').click();
      await page.locator('.comms-msg--mine', { hasText: 'A second message' }).waitFor({ timeout: 5000 });
      // For as long as the runtime is still answering: on its way, never Not delivered; and the composer free at once
      // (the send was accepted, not held for the 20 s the body takes).
      let shown = 0;
      let freeAt = Infinity;
      const seen = new Set<string | null>();
      while (calls().length === before || Date.now() - sentAt < 19_000) {
        shown = Math.max(shown, await notDelivered(page));
        seen.add(await status(page));
        if (freeAt === Infinity && await page.locator('.comms-composer textarea').inputValue() === '') freeAt = Date.now();
        await page.waitForTimeout(500);
      }
      expect(shown, 'Not delivered showed while the message was on its way').toBe(0);
      expect([...seen]).toEqual(['sending']);
      expect(freeAt - sentAt).toBeLessThan(5000);
      // Then delivered, from the thread's live state.
      await lastIs(page, 'delivered', 15_000);
      expect(await notDelivered(page)).toBe(0);
      expect(calls().length - before).toBe(1);
      const r = rows(t.id);
      expect(r.filter((x) => x.kind === 'error')).toEqual([]);
      expect(r.at(-1)).toMatchObject({ kind: 'message', delivered: 1 });
      expect(errors).toEqual([]);
    } finally { await ctx.close(); }
  }, 60_000);

  it('a 15,000-character paste is sent whole: the composer takes what Comms takes (40,000), not its own 12,000', async () => {
    runtime('ok', 0);
    const t = thread();
    const { ctx, page, errors } = await open(t.id);
    try {
      const long = Array.from({ length: 15_000 }, (_, i) => 'abcdefghij'[i % 10]).join('').slice(0, 14_990) + 'THE-TAIL!!';
      const box = page.locator('.comms-composer textarea');
      await box.focus();
      // A paste, as the browser takes it: inserted text is cut at the box's maxlength, where fill() would not be.
      await page.keyboard.insertText(long);
      expect(await box.inputValue()).toHaveLength(15_000);
      const before = calls().length;
      await page.locator('.comms-composer .v-agent-chat__send').click();
      await lastIs(page, 'delivered', 15_000);
      expect(calls().length - before).toBe(1);
      expect(calls().at(-1)?.text).toBe(long);
      expect(errors).toEqual([]);
    } finally { await ctx.close(); }
  }, 60_000);
  it('Not delivered only after a failure the server recorded; Send again shows it sending and delivers exactly once', async () => {
    runtime('said', 0);
    const t = thread();
    const { ctx, page, errors } = await open(t.id);
    try {
      await page.locator('.comms-composer textarea').fill('Can you hear me?');
      await page.locator('.comms-composer .v-agent-chat__send').click();
      await page.locator('.comms-resend').waitFor({ timeout: 10_000 });
      expect(rows(t.id).some((x) => x.kind === 'error'), 'the failure is on record').toBe(true);
      // Now the runtime takes it, slowly: Send again shows it sending at once, and never Not delivered meanwhile.
      runtime('ok', 3000);
      const before = calls().length;
      await page.locator('.comms-resend button').click();
      await page.waitForFunction(() => document.querySelectorAll('.comms-resend').length === 0, undefined, { timeout: 1000 });
      expect(await status(page)).toBe('sending');
      await lastIs(page, 'delivered', 15_000);
      expect(await notDelivered(page)).toBe(0);
      expect(calls().length - before).toBe(1);
      const ids = calls().map((c) => c.id);
      expect(ids.at(-1)).toBe(ids.at(-2));
      expect(errors).toEqual([]);
    } finally { await ctx.close(); }
  }, 60_000);
});
