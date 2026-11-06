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

  it('an ask asked from the thread: drawn with its words, the face waiting on you, Allow once posted to its piece', async () => {
    const { ctx, page, errors } = await open(false);
    try {
      // A thread of its own, nothing failed in it (an error would rightly outrank the ask).
      const opened = openThread(h, process.env, h.members[0], { agent: 'art', id: 'dddddddddddddddd', text: 'Ship it when it\'s green?' });
      const thread = opened.thread;
      recordDelivery(h, thread, opened.seq, { delivered: true, body: 'started' });
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
      expect(await page.locator('.comms-ask h3').textContent()).toBe('OK to merge the comm screen PR?');
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
