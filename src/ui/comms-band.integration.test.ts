/**
 * Comms' band (Jonathan, 2026-11-07, "outlook-esque"), in a real browser: a desktop thread has a band of fixed height
 * over the chat, the comm screen at its own size on the left (the pixel face at a whole scale, never stretched), who's
 * in the conversation and the thread's work on the right, scrolling inside the band; the chat takes the rest. The list
 * sits beside the thread from 1100 px; narrower it's a drawer. A short tile folds the band to a strip. At 1024, 1280
 * (beside the widgets) and 1920.
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
import { createToken, loadHousehold, manifestFromPixelLab, setSprite, type Household } from '../household.js';
import { sheet } from './pixel-sheet.fixture.js';
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
    // Art wears a pixel sheet: the comm screen draws his pixel face, and it must stay at a whole scale.
    const { png, json } = sheet();
    setSprite(h, 'art', manifestFromPixelLab(JSON.parse(json.toString())), { 'sheet.png': png });
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

  const work = (n: number) => ({ items: Array.from({ length: n }, (_, k) => ({ title: `Task number ${k + 1} with a title long enough to wrap in a narrow side`, ref: `t-${100 + k}`, status: k === 0 ? 'Blocked' : 'Open', tone: k === 0 ? 'bad' : undefined, from: 'tasks' })), failed: [] });
  const band = async (p: Page) => p.evaluate(() => {
    const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
    const side = document.querySelector('.comms-band__side')!;
    const tile = document.querySelector('.loom-tile[data-tile="/comms"]')!.getBoundingClientRect();
    const composer = r('.comms-composer'), chat = r('.comms-chat'), b = r('.comms-band'), glass = r('.comms-screen__glass');
    // Nothing past the window: no element wider than the tile; the frames (the box, the band, the chat, the composer) inside
    // its bottom too (a message scrolled out of the chat's own view is inside its scroller, not past the window).
    const inside = [...document.querySelectorAll('.loom-tile[data-tile="/comms"] .comms *')].every((e) => { const x = e.getBoundingClientRect(); return !x.width || (x.left >= tile.left - 1 && x.right <= tile.right + 1); })
      && ['.comms', '.comms-band', '.comms-chat', '.comms-composer'].every((q) => document.querySelector(q)!.getBoundingClientRect().bottom <= tile.bottom + 1);
    // The side scrolls: overflow-y auto, and a scroll moves it (a clipped side, overflow hidden, would read 0).
    const before = side.scrollTop; side.scrollTop = 9999; const moved = side.scrollTop > before && getComputedStyle(side).overflowY === 'auto'; side.scrollTop = 0;
    // The face: a pixel canvas drawn at a whole scale, its CSS size its own pixels (never stretched by layout).
    const cv = document.querySelector<HTMLCanvasElement>('.comms-band .comms-screen__glass canvas');
    const face = cv ? { k: cv.getBoundingClientRect().width / cv.width, ky: cv.getBoundingClientRect().height / cv.height } : null;
    const list = document.querySelector('.comms > .comms-list')?.getBoundingClientRect();
    const thread = document.querySelector('.comms-thread')!.getBoundingClientRect();
    return { band: Math.round(b.height), side: { scroll: side.scrollHeight, client: side.clientHeight }, glass: [glass.width, glass.height],
      chatFills: Math.abs(chat.top - b.bottom) <= 2 && Math.abs(chat.bottom - composer.top) <= 2 && chat.height > 120, inside,
      one: document.querySelector('.comms')!.hasAttribute('data-one'), list: !!list, listW: list ? Math.round(list.width) : 0, beside: !!list && thread.left >= list.right - 1, moved, face };
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
      expect(sizes[20].moved).toBe(true);
      // The face at its own 2x: the glass is 96 x 84 x 2, never stretched to the width.
      for (const s of [sizes[0], sizes[20]]) {
        expect(s.glass).toEqual([192, 168]);
        expect(s.face).not.toBeNull();
        // Sheet pixels to screen pixels: a whole number, 2 or more, the same both ways (never stretched).
        expect(Number.isInteger(s.face!.k) && s.face!.k >= 2).toBe(true);
        expect(s.face!.ky).toBe(s.face!.k);
        expect(s.chatFills).toBe(true);
        expect(s.inside).toBe(true);
        // Mid-size: one pane, the threads a drawer; wide: the list beside the thread.
        expect(s.one).toBe(layout === 'mid');
        expect(s.list).toBe(layout === 'wide');
        // Wide: the list, 320 px, beside the thread.
        if (layout === 'wide') expect([s.listW, s.beside]).toEqual([320, true]);
      }
    });
  }

  it('a short tile (under 520 px tall) folds the band to a strip: the chat keeps its room', async () => {
    const t = thread('art', 3);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 500 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await ctx.addInitScript(`localStorage.setItem('loom-look', 'neon'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    await p.goto(`${base}/comms/${bare(t)}?t=*comms&w=`);
    await p.locator('.comms-thread[data-short] .comms-band').waitFor();
    const r = await p.evaluate(() => ({ band: document.querySelector('.comms-band')!.getBoundingClientRect().height, chat: document.querySelector('.comms-chat')!.getBoundingClientRect().height }));
    expect(r.band).toBeLessThanOrEqual(80);
    // (A 232 px band would leave the chat nothing at this height.)
    expect(r.chat).toBeGreaterThan(60);
    await ctx.close();
  });
});
