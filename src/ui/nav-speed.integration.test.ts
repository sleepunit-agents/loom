/**
 * Only what changes is replaced (t-1925 F; Jonathan, 2026-11-06: "if I'm on comms and I click a conversation the whole
 * app page reloads"), in a real browser on the tiled desktop:
 * - a Comms thread pressed opens in the thread's pane at once; the list beside it stays mounted, scrolled where it was,
 *   with the pressed one lit, the address follows, and a draft typed in one thread is there on coming back to it;
 * - Back and Forward in a tile show the page kept from before at once;
 * - a kept page that's out of date is shown, asked again behind it, and patched in place (not drawn again);
 * - an ask answered in one tile leaves the others too, by the live stream.
 *
 * Runs where the app is built (npm run build), a Chrome is installed and age is (Comms' words are encrypted).
 */
import { describe, it, expect as vexpect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from '../household.js';
import { createConversationTables } from '../backends/conversations.js';
import { closeAllBackends } from '../backends/index.js';
import { adapterCall, openThread, recordDelivery, setTitle } from '../comms.js';
import { clearPieceCache } from './pieces.js';
import { stopCommsWatch } from './comms-live.js';

vi.setConfig({ testTimeout: 90_000 });
const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);
const hasAge = spawnSync('sh', ['-c', 'command -v age && command -v age-keygen'], { encoding: 'utf-8' }).status === 0;
const expect = Object.assign(((v: unknown, m?: string) => vexpect(v, m)) as typeof vexpect, vexpect,
  { poll: (f: () => unknown, o?: { timeout?: number }) => vexpect.poll(f, { timeout: 10_000, ...o }) }) as typeof vexpect;
const KEY = (label: string) => `.loom-dock-bar [data-part="item"][aria-label="${label}"]`;
const tile = (label: string) => `.loom-tile[aria-label$=", ${label}"]`;

// A piece, Lots: a list of 30 items each with its own page, a count that the test moves, and asks it can answer.
const PIECE = `#!/usr/bin/env node
const fs = require('fs');
const file = process.env.LOTS_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf-8'));
const [cmd, sub] = process.argv.slice(2);
const input = () => { try { return JSON.parse(fs.readFileSync(0, 'utf-8') || '{}'); } catch { return {}; } };
const out = (v) => process.stdout.write(JSON.stringify(v));
if (cmd === 'ui' && sub === '--json') out({ v: 2, tab: { label: 'Lots' }, tile: { label: 'Lots', value: 'Count ' + state.count, page: '' },
  asks: state.asks.map((a) => ({ text: a.text, why: 'It waits on you.', if_yes: 'It goes ahead.', if_no: 'It waits.', kind: 'permission', at: a.at, page: '',
    actions: [{ action: 'allow', label: 'Allow once', tone: 'primary', fields: { id: a.id } }, { action: 'deny', label: 'Deny', tone: 'danger', fields: { id: a.id } }] })) });
else if (cmd === 'ui' && sub === 'page') {
  const { path } = input();
  const n = /^x\\/(\\d+)$/.exec(path || '');
  if (n) out({ title: 'Item ' + n[1], sections: [{ id: 'it', blocks: [{ type: 'text', text: 'This is item ' + n[1] + '.' }] }] });
  else out({ title: 'Lots', sections: [{ id: 'count', blocks: [{ type: 'text', text: 'Count ' + state.count },
      ...(state.asks.length ? [{ type: 'buttons', items: state.asks.map((a) => ({ action: 'allow', label: 'Allow ' + a.id, fields: { id: a.id } })) }] : [])] },
    { id: 'list', blocks: [{ type: 'list', items: Array.from({ length: 30 }, (_, i) => ({ text: 'Item ' + (i + 1), page: 'x/' + (i + 1) })) }] }] });
} else if (cmd === 'ui' && sub === 'act') {
  const { action, fields } = input();
  state.asks = state.asks.filter((a) => a.id !== fields.id);
  fs.writeFileSync(file, JSON.stringify(state));
  out({ ok: true, message: action === 'allow' ? 'Allowed.' : 'Denied.' });
} else process.exit(1);
`;

describe.runIf(built && chrome && hasAge)('navigation replaces only what changes', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  let stateFile: string;
  const threads: { id: string; title: string }[] = [];
  const saved: Record<string, string | undefined> = {};
  const setState = (s: { count: number; asks: { id: string; text: string; at: string }[] }) => { writeFileSync(stateFile, JSON.stringify(s)); clearPieceCache(); };

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-nav-speed-'));
    for (const a of ['art']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), '# Art E Fish\n\nCreed.\n');
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db')); createConversationTables(db); db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], default: 'art', owner: 'jonathan', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
    for (const k of ['LOOM_HOME', 'XDG_CONFIG_HOME', 'PATH', 'LOTS_STATE']) saved[k] = process.env[k];
    process.env.LOOM_HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'loom-lots'), PIECE);
    chmodSync(join(bin, 'loom-lots'), 0o755);
    stateFile = process.env.LOTS_STATE = join(home, 'lots.json');
    writeFileSync(stateFile, JSON.stringify({ count: 1, asks: [] }));
    process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
    clearPieceCache();
    h = loadHousehold(home)!;
    token = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: 'jonathan' }).token;
    // 24 threads, enough that the list scrolls; each with a reply.
    const b32 = (n: number) => 'abcdefghijklmnopqrstuvwxyz234567'[n % 32];
    for (let i = 0; i < 24; i++) {
      const o = openThread(h, process.env, h.members[0], { agent: 'art', id: `${b32(i)}${b32(i >> 5)}${'q'.repeat(14)}`, text: `Thread number ${i + 1}` });
      recordDelivery(h, o.thread, o.seq, { delivered: true, body: 'ok' });
      adapterCall(h, process.env, { op: 'post', place: o.thread.id, agent: 'art', text: `The reply in thread ${i + 1}.`, run: `r${i}` });
      adapterCall(h, process.env, { op: 'status', place: o.thread.id, agent: 'art', status: 'done' });
      setTitle(h, o.thread, `Talk ${i + 1}`, 'member');
      threads.push({ id: o.thread.id, title: `Talk ${i + 1}` });
    }
    handle = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  }, 90_000);
  afterAll(async () => {
    await browser?.close();
    stopCommsWatch();
    await handle?.close();
    await closeAllBackends();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (h) rmSync(h.home, { recursive: true, force: true });
  });

  async function desk(path: string, o: { sw?: boolean; width?: number } = {}): Promise<{ p: Page; errors: string[]; close: () => Promise<void> }> {
    const ctx = await browser.newContext({ viewport: { width: o.width ?? 1280, height: 800 }, reducedMotion: 'reduce', serviceWorkers: o.sw ? 'allow' : 'block' });
    await ctx.addInitScript(`try { localStorage.setItem('loom-look', 'neon'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1'); } catch {}`);
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${base}${path}`);
    await p.locator('.loom-tiles').waitFor({ timeout: 20_000 });
    return { p, errors, close: () => ctx.close() };
  }
  /** Marks the element `sel` finds, to see later whether it's the same one (kept) or a new one (drawn again). */
  const mark = (p: Page, sel: string) => p.locator(sel).first().evaluate((e) => { (e as unknown as { __kept: boolean }).__kept = true; });
  const kept = (p: Page, sel: string) => p.locator(sel).first().evaluate((e) => !!(e as unknown as { __kept?: boolean }).__kept);

  it('a Comms thread pressed: the pane opens at once, the list stays mounted and scrolled, the address follows, a draft holds', async () => {
    // Comms alone (the agents' rail beside it): wide enough for the list beside the thread (comms.tsx ONE_PANE_BELOW).
    const { p, errors, close } = await desk('/comms?t=*comms', { width: 1600 });
    try {
      const list = `${tile('Comms')} .comms-list`;
      await p.locator(`${list} [data-split-row]`).nth(10).waitFor();
      await p.locator(list).evaluate((e) => { e.scrollTop = 240; });
      await mark(p, list);
      // The first thread, and a draft in its composer.
      const firstTitle = (await p.locator(`${list} .loom-kit-title`).nth(0).textContent())!;
      await p.locator(`${list} [data-split-row]`).nth(0).click();
      await p.locator(`${tile('Comms')} .comms-msg--agent`).first().waitFor();
      const first = new URL(p.url()).pathname;
      expect(first).toMatch(/^\/comms\/[a-z2-7]{10}$/);
      await p.locator(`${tile('Comms')} .comms-composer textarea`).fill('half a thought');
      // A thread read goes below the unread ones, live (comms.md, "Phone"; t-2027): its read reaches the list before
      // the next press, so the rows don't move under it. Rows are found by title from here (t-2099).
      const row = (title: string) => p.locator(`${list} li:has(.comms-list .loom-kit-title:text-is("${title}"))`);
      await expect.poll(() => row(firstTitle).getAttribute('data-unread')).toBeNull();
      // Another thread, with its page held back: the pane says which at once, before its page lands.
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      await p.route(/\/comms\/(th:)?[a-z2-7]{10}$/, async (route) => { await held; await route.continue().catch(() => {}); });
      // Pressed where it is (a test's click would scroll the list to it first).
      await p.locator(`${list} [data-split-row]`).nth(12).evaluate((e) => { e.scrollIntoView({ block: 'nearest' }); });
      const before = await p.locator(list).evaluate((e) => e.scrollTop);
      expect(before).toBeGreaterThan(0);
      const pressed = (await p.locator(`${list} .loom-kit-title`).nth(12).textContent())!;
      await p.locator(`${list} [data-split-row]`).nth(12).evaluate((e) => (e as HTMLElement).click());
      await p.locator(`${tile('Comms')} .comms-thread--opening`).waitFor({ timeout: 1000 });
      expect(await row(pressed).getAttribute('data-current')).not.toBeNull();
      expect(await kept(p, list)).toBe(true);
      release();
      await p.unroute(/\/comms\/(th:)?[a-z2-7]{10}$/);
      await expect.poll(() => p.locator(`${tile('Comms')} .comms-thread--opening`).count()).toBe(0);
      await p.locator(`${tile('Comms')} .comms-msg--agent`).first().waitFor();
      const second = new URL(p.url()).pathname;
      expect(second).toMatch(/^\/comms\/[a-z2-7]{10}$/);
      expect(second).not.toBe(first);
      // The list: the same element, scrolled where it was, the pressed thread lit, once its read has landed too.
      await expect.poll(() => row(pressed).getAttribute('data-unread')).toBeNull();
      expect(await kept(p, list)).toBe(true);
      expect(await p.locator(list).evaluate((e) => e.scrollTop)).toBe(before);
      expect(await p.locator(`${list} [data-split-row][aria-current="true"]`).count()).toBe(1);
      expect(await row(pressed).getAttribute('data-current')).not.toBeNull();
      // Back to the first, loom slow from here: it opens from the tab's copy at once (no wait in the pane), its
      // draft as it was left.
      await p.route(/\/comms\/th:[a-z2-7]+$/, async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue().catch(() => {}); });
      await row(firstTitle).locator('.comms-list [data-split-row]').evaluate((e) => (e as HTMLElement).click());
      await expect.poll(() => new URL(p.url()).pathname, { timeout: 800 }).toBe(first);
      expect(await p.locator(`${tile('Comms')} .comms-thread--opening`).count()).toBe(0);
      await expect.poll(() => p.locator(`${tile('Comms')} .comms-composer textarea`).inputValue()).toBe('half a thought');
      expect(await kept(p, list)).toBe(true);
      expect(errors).toEqual([]);
    } finally { await close(); }
  });

  it('Back and Forward in a tile show the kept page at once', async () => {
    const { p, close } = await desk('/p/lots');
    try {
      const t = tile('Lots');
      await p.locator(`${t} a:has-text("Item 3")`).first().click();
      await p.locator(`${t}`).getByText('This is item 3.').waitFor();
      // From here on loom answers slowly (1.5 s): what's shown within 0.8 s is what the tab kept.
      await p.route(/\/p\/lots/, async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue().catch(() => {}); });
      await p.locator(`${t} .loom-tile__btn[aria-label^="Back"]`).click();
      await p.locator(`${t} a:has-text("Item 3")`).first().waitFor({ timeout: 800 });
      expect(await p.locator(`${t} .loom-skel`).count()).toBe(0);
      await p.locator(`${t} .loom-tile__btn[aria-label^="Forward"]`).click();
      await p.locator(t).getByText('This is item 3.').waitFor({ timeout: 800 });
      // The browser's own Back, too.
      await p.goBack();
      await p.locator(`${t} a:has-text("Item 3")`).first().waitFor({ timeout: 800 });
    } finally { await close(); }
  });

  it('a kept page that has moved is shown at once, asked again behind it, and patched in place', async () => {
    setState({ count: 1, asks: [] });
    const { p, close } = await desk('/p/lots');
    try {
      const t = tile('Lots');
      await p.locator(t).getByText('Count 1').waitFor();
      await p.locator(`${t} a:has-text("Item 5")`).first().click();
      await p.locator(t).getByText('This is item 5.').waitFor();
      setState({ count: 2, asks: [] });
      await p.route(/\/p\/lots$/, async (route) => { await new Promise((r) => setTimeout(r, 800)); await route.continue().catch(() => {}); });
      await p.locator(`${t} .loom-tile__btn[aria-label^="Back"]`).click();
      // The kept copy, at once; then the new count, in the same list (its rows weren't drawn again).
      await p.locator(t).getByText('Count 1').waitFor({ timeout: 800 });
      await mark(p, `${t} a:has-text("Item 7")`);
      await p.locator(t).getByText('Count 2').waitFor({ timeout: 5000 });
      expect(await kept(p, `${t} a:has-text("Item 7")`)).toBe(true);
    } finally { await close(); }
  });

  it('a link the pointer rests on is fetched ahead: the press opens it at once', async () => {
    setState({ count: 1, asks: [] });
    const { p, close } = await desk('/p/lots');
    try {
      const t = tile('Lots');
      const link = p.locator(`${t} a:has-text("Item 9")`).first();
      await link.waitFor();
      const asked = p.waitForRequest((r) => r.url().endsWith('/p/lots/x/9'), { timeout: 3000 });
      await link.hover();
      await asked;
      await p.waitForTimeout(300);
      // From here loom is slow: the press is answered from what was fetched ahead.
      await p.route(/\/p\/lots\/x\/9$/, async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue().catch(() => {}); });
      await link.click();
      await p.locator(t).getByText('This is item 9.').waitFor({ timeout: 800 });
    } finally { await close(); }
  });

  it('an Allow in a kept copy waits until loom has been asked again, then goes with the answered ask', async () => {
    setState({ count: 1, asks: [{ id: 'a-2', text: 'OK to clear the old builds?', at: new Date().toISOString() }] });
    const { p, close } = await desk('/p/lots');
    try {
      const t = tile('Lots');
      const allow = p.locator(`${t} button:has-text("Allow a-2")`);
      await allow.waitFor();
      expect(await allow.isDisabled()).toBe(false);
      await p.locator(`${t} a:has-text("Item 4")`).first().click();
      await p.locator(t).getByText('This is item 4.').waitFor();
      // Answered elsewhere, and this tab never heard; loom answers slowly from here.
      setState({ count: 1, asks: [] });
      await p.route(/\/p\/lots$/, async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue().catch(() => {}); });
      await p.locator(`${t} .loom-tile__btn[aria-label^="Back"]`).click();
      // The kept copy at once, its Allow there but not pressable; then gone.
      await allow.waitFor({ timeout: 800 });
      expect(await allow.isDisabled()).toBe(true);
      await expect.poll(() => allow.count(), { timeout: 5000 }).toBe(0);
    } finally { await close(); }
  });

  it('the worker keeps the built app ahead, keeps pages by session, and drops them at sign-out or another session', async () => {
    const { p, close } = await desk('/inbox', { sw: true });
    try {
      await p.evaluate(() => navigator.serviceWorker.ready);
      // The worker controls the page from its next load; then pages it answers are kept.
      await p.reload();
      await p.locator('.loom-tiles').waitFor();
      await expect.poll(() => p.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
      const names = () => p.evaluate(() => caches.keys());
      const count = (suffix: string) => p.evaluate(async (s) => {
        const k = (await caches.keys()).find((n) => n.endsWith(s));
        return k ? (await (await caches.open(k)).keys()).length : 0;
      }, suffix);
      // Every built script and stylesheet, kept before anything asked for them (Comms' chunk among them).
      await expect.poll(async () => (await names()).some((n) => /-built-/.test(n))).toBe(true);
      const builtUrls = () => p.evaluate(async () => (await (await caches.open((await caches.keys()).find((n) => /-built-/.test(n))!)).keys()).map((r) => new URL(r.url).pathname));
      await expect.poll(async () => (await builtUrls()).some((u) => /^\/app\/assets\/comms-.*\.js$/.test(u))).toBe(true);
      await expect.poll(() => count('-views')).toBeGreaterThan(0);
      // Another session on this browser (signed in again, without signing out): the last one's copies go first.
      const savedTimes = () => p.evaluate(async () => {
        const c = await caches.open((await caches.keys()).find((n) => n.endsWith('-views'))!);
        return Promise.all((await c.keys()).map(async (r) => Date.parse((await c.match(r))!.headers.get('x-loom-saved-at') ?? '0')));
      });
      const switched = Date.now();
      await p.context().request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
      await p.evaluate(() => fetch('/p/lots', { headers: { accept: 'application/json' } }).then((r) => r.text()));
      await expect.poll(async () => { const t = await savedTimes(); return t.length > 0 && t.every((x) => x >= switched - 1000); }).toBe(true);
      // Signing out: nothing of the session is left.
      await p.goto(`${base}/login`);
      await expect.poll(async () => (await names()).filter((n) => /-(pages|views|media)$/.test(n))).toEqual([]);
    } finally { await close(); }
  });

  it('an ask answered in one tile leaves the others by the live stream', async () => {
    setState({ count: 1, asks: [{ id: 'a-1', text: 'OK to ship the speed work tonight?', at: new Date().toISOString() }] });
    const { p, close } = await desk('/inbox?t=*inbox');
    try {
      // Home's Needs you band (drawn from Home's page, docs/specs/agent-desk.md) and the Inbox both show it: the band
      // while no app is open, the Inbox's tile once it is.
      const needs = p.locator('.loom-needs-band');
      const inbox = p.locator(tile('Inbox'));
      await inbox.locator('button[aria-label="Minimize Inbox to the dock"]').click();
      await expect.poll(() => needs.getByText('OK to ship the speed work tonight?').count()).toBeGreaterThan(0);
      await p.locator('.loom-dock-bar [data-part="item"][aria-label="Inbox"]').click();
      await expect.poll(() => needs.count()).toBe(0);
      await inbox.getByText('OK to ship the speed work tonight?').first().click();
      // Allow, in the Inbox tile's reader (enabled once loom has said the ask is still open).
      const allow = inbox.getByRole('button', { name: 'Allow once' }).first();
      await expect.poll(() => allow.isEnabled()).toBe(true);
      await allow.click();
      // The Inbox keeps it under Done now: Allow once is gone from it.
      await expect.poll(() => inbox.getByRole('button', { name: 'Allow once' }).count(), { timeout: 15_000 }).toBe(0);
      // Back on the desktop, Needs you has it no more.
      await inbox.locator('button[aria-label="Minimize Inbox to the dock"]').click();
      await needs.waitFor();
      await expect.poll(() => needs.getByText('OK to ship the speed work tonight?').count(), { timeout: 15_000 }).toBe(0);
    } finally { await close(); }
  });
});
