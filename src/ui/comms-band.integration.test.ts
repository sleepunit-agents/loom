/**
 * Comms' band (Jonathan, 2026-11-07), in a real browser: on a desktop the thread has a band of fixed height over the chat, the
 * comm screen at its own size on the left, who's in the conversation and the thread's work on the right, scrolling inside
 * it. Also from the polish (t-1918; t-1925 C): a thread's address has no colon and reloads, an old one is sent
 * to it; the comm screen's channel line says what the agent is doing; the working line and its steps show as they
 * happen; the thread follows the bottom only while you're there, and a pill counts what came in below; the Enter hint
 * shows faintly only while you type; a body that couldn't start says so, not "busy". At 1280 and 1920 (a desktop's
 * Comms tile), and 390 (a phone).
 *
 * Runs where the app is built (npm run build), a Chrome is installed and age is (the thread's words are encrypted).
 */
import { describe, it, expect as vexpect, beforeAll, afterAll, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { createToken, loadHousehold, type Household } from '../household.js';
import { createConversationTables } from '../backends/conversations.js';
import { closeAllBackends } from '../backends/index.js';
import { adapterCall, openThread, recordDelivery, type Thread } from '../comms.js';
import { stopCommsWatch } from './comms-live.js';

const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);
const hasAge = spawnSync('sh', ['-c', 'command -v age && command -v age-keygen'], { encoding: 'utf-8' }).status === 0;
const expect = Object.assign(((v: unknown, m?: string) => vexpect(v, m)) as typeof vexpect, vexpect,
  { poll: (f: () => unknown, o?: { timeout?: number }) => vexpect.poll(f, { timeout: 10_000, ...o }) }) as typeof vexpect;
const SHOTS = process.env.LOOM_SHOTS;
const ids = { n: 0 };
const msgId = () => `zz${String(++ids.n).padStart(14, 'a').replace(/\d/g, (d) => 'abcdefghij'[Number(d)])}`;

describe.runIf(built && chrome && hasAge)('Comms: the band over the chat', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-comms-follow-'));
    for (const [a, name] of [['art', 'Art E Fish'], ['mark', 'Visual Mark']]) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${name}\n\nCreed.\n`);
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db')); createConversationTables(db); db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', owner: 'jonathan', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
    for (const k of ['LOOM_HOME', 'XDG_CONFIG_HOME']) saved[k] = process.env[k];
    process.env.LOOM_HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    h = loadHousehold(home)!;
    token = createToken(h, { role: { kind: 'owner' }, label: 'jonathan' }).token;
    handle = await startHttpServer({ contextDir: join(home, 'agents', 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    stopCommsWatch();
    await handle?.close();
    await closeAllBackends();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (h) rmSync(h.home, { recursive: true, force: true });
  });

  /** A thread with its first message delivered (the runtime took it) and `replies` replies after it. */
  const thread = (agent = 'art', replies = 0): Thread => {
    const o = openThread(h, process.env, h.members[0], { agent, id: msgId(), text: 'Hello there.' });
    recordDelivery(h, o.thread, o.seq, { delivered: true, body: 'started' });
    for (let n = 0; n < replies; n++) adapterCall(h, process.env, { op: 'post', place: o.thread.id, agent, text: `Reply ${n + 1}. ${'More words so it takes up a line or two. '.repeat(3)}` });
    if (replies) adapterCall(h, process.env, { op: 'status', place: o.thread.id, agent, status: 'done' });
    return o.thread;
  };
  const bare = (t: Thread) => t.id.replace(/^th:/, '');
  async function screen(width: number, height: number, path: string, motion: 'reduce' | 'no-preference' = 'reduce'): Promise<Page> {
    const phone = width < 600;
    const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: motion, serviceWorkers: 'block', ...(phone ? { isMobile: true, hasTouch: true } : {}) });
    await ctx.addInitScript(`localStorage.setItem('loom-look', 'neon'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    (p as Page & { errors: string[] }).errors = errors;
    await p.goto(`${base}${path}`);
    await p.locator('.comms-thread, .comms-list').first().waitFor();
    return p;
  }
  const label = (p: Page) => p.locator('.comms-screen__label > span').first().textContent();
  const shot = async (p: Page, name: string) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/comms-${name}.png` }); };

  const work = (n: number) => ({ items: Array.from({ length: n }, (_, k) => ({ title: `Task number ${k + 1} with a title long enough to wrap in a narrow side`, ref: `t-${100 + k}`, status: k === 0 ? 'Blocked' : 'Open', tone: k === 0 ? 'bad' : undefined, from: 'tasks' })), failed: [] });
  const band = async (p: Page) => p.evaluate(() => {
    const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
    const side = document.querySelector('.comms-band__side')!;
    const tile = document.querySelector('.loom-tile[data-tile="/comms"]')!.getBoundingClientRect();
    const composer = r('.comms-composer'), chat = r('.comms-chat'), b = r('.comms-band'), glass = r('.comms-screen__glass');
    const inside = [...document.querySelectorAll('.loom-tile[data-tile="/comms"] .comms *')].every((e) => { const x = e.getBoundingClientRect(); return !x.width || (x.left >= tile.left - 1 && x.right <= tile.right + 1); });
    return { band: Math.round(b.height), side: { scroll: side.scrollHeight, client: side.clientHeight }, glass: [glass.width, glass.height],
      chatFills: Math.abs(chat.top - b.bottom) <= 2 && Math.abs(chat.bottom - composer.top) <= 2 && chat.height > 120, inside,
      one: document.querySelector('.comms')!.hasAttribute('data-one'), list: !!document.querySelector('.comms > .comms-list') };
  });

  for (const [w, hgt, layout, ws] of [[1024, 768, 'mid', ''], [1280, 800, 'mid', 'needs'], [1920, 1080, 'wide', '']] as const) {
    it(`the band: one fixed height with 0 and 20 work items, its side scrolling inside it; the face its own size; the chat the rest; nothing past the window, at ${w}×${hgt} (${layout}${ws ? ', beside the widgets' : ''})`, async () => {
      const t = thread('art', 3);
      const sizes: Record<number, Awaited<ReturnType<typeof band>>> = {};
      for (const n of [0, 20]) {
        const ctx = await browser.newContext({ viewport: { width: w, height: hgt }, reducedMotion: 'reduce', serviceWorkers: 'block' });
        await ctx.addInitScript(`localStorage.setItem('loom-look', 'neon'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
        await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
        const p = await ctx.newPage();
        await p.route(`**/comms/${t.id}/work`, (r) => r.fulfill({ json: work(n) }));
        await p.goto(`${base}/comms/${bare(t)}?t=*comms&w=${ws}`);
        await p.locator('.comms-band .comms-screen').waitFor();
        await p.locator(n ? '.comms-band .comms-work__row' : '.comms-band .comms-work__empty').first().waitFor();
        await p.waitForTimeout(300);
        sizes[n] = await band(p);
        if (SHOTS && n === 20) await p.screenshot({ path: `${SHOTS}/comms-band-${w}.png` });
        await ctx.close();
      }
      // One height, whatever the work; with 20 items the side scrolls inside the band.
      expect(sizes[0].band).toBe(sizes[20].band);
      expect(sizes[20].side.scroll).toBeGreaterThan(sizes[20].side.client);
      // The face at its own 2x: the glass is 96 x 84 x 2, never stretched to the width.
      for (const s of [sizes[0], sizes[20]]) {
        expect(s.glass).toEqual([192, 168]);
        expect(s.chatFills).toBe(true);
        expect(s.inside).toBe(true);
        // Mid-size: one pane, the threads a drawer; wide: the list beside the thread.
        expect(s.one).toBe(layout === 'mid');
        expect(s.list).toBe(layout === 'wide');
      }
    });
  }
});
