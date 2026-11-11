/**
 * Comms' band (Jonathan, 2026-11-07, "outlook-esque"), in a real browser: a desktop thread has a band of fixed height
 * over the chat, the comm screen at its own size on the left (the pixel face at a whole scale, never stretched), who's
 * in the conversation and the thread's work on the right, scrolling inside the band; the chat takes the rest. The list
 * sits beside the thread from 1100 px; narrower it's a drawer. A short tile folds the band to a strip. At 1024, 1280
 * (beside the agents' rail) and 1920.
 *
 * Runs where the app is built (npm run build), a Chrome is installed and age is (the thread's words are encrypted).
 */
import { describe, it, expect as vexpect, beforeAll, afterAll, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { createToken, loadHousehold, manifestFromPixelLab, setSprite, type Household } from '../household.js';
import { sheet } from './pixel-sheet.fixture.js';
import { createConversationTables } from '../backends/conversations.js';
import { parseLoomBlock } from '../cli/pieces-managed.js';
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
    // These threads are seeded directly, so none has a runtime body. Archive still asks the runtime to interrupt
    // before changing storage; answer its precise missing-conversation result, just as the real runtime does.
    const loom = parseLoomBlock({ role: 'runtime', delivery: ['loom-runtime', 'deliver', '--json'] }, 'runtime', ['loom-runtime']);
    if (typeof loom === 'string') throw new Error(loom);
    const dir = join(home, 'pieces', 'runtime');
    mkdirSync(join(dir, 'current'), { recursive: true });
    writeFileSync(join(dir, 'piece.json'), JSON.stringify({ v: 1, name: 'runtime', source: { repo: 'x/y', commit: 'a'.repeat(40) }, package: 'runtime', version: '1', installed: 'x',
      bins: ['loom-runtime'], loom: { settings: [], services: [], ...loom } }));
    const cli = join(dir, 'current', 'cli');
    writeFileSync(cli, `#!${process.execPath}
let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  const q = JSON.parse(input);
  console.log(JSON.stringify(q.path === 'conversation-control'
    ? { status: 404, body: { error: 'no such conversation' } }
    : { status: 200, body: {} }));
});
`);
    chmodSync(cli, 0o755);
    mkdirSync(join(home, 'pieces', 'bin'), { recursive: true });
    symlinkSync(cli, join(home, 'pieces', 'bin', 'loom-runtime'));
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
  const thread = (agent = 'art', replies = 0, text = 'Hello there.'): Thread => {
    const o = openThread(h, process.env, h.members[0], { agent, id: msgId(), text });
    recordDelivery(h, o.thread, o.seq, { delivered: true, body: 'started' });
    for (let n = 0; n < replies; n++) adapterCall(h, process.env, { op: 'post', place: o.thread.id, agent, text: `Reply ${n + 1}. ${'More words so it takes up a line or two. '.repeat(3)}` });
    if (replies) adapterCall(h, process.env, { op: 'status', place: o.thread.id, agent, status: 'done' });
    return o.thread;
  };
  const bare = (t: Thread) => t.id.replace(/^th:/, '');

  const work = (n: number) => ({ items: Array.from({ length: n }, (_, k) => ({ title: `Task number ${k + 1} with a title long enough to wrap in a narrow side`, ref: `t-${100 + k}`, status: k === 0 ? 'Blocked' : 'Open', tone: k === 0 ? 'bad' : undefined, from: 'tasks' })), failed: [] });
  const band = async (p: Page) => p.evaluate(() => {
    const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
    // What scrolls: the side, stacked (two columns); in three columns each column scrolls itself, and the work is the long one.
    const stacked = getComputedStyle(document.querySelector('.comms-band__side')!).display !== 'grid';
    const side = document.querySelector(stacked ? '.comms-band__side' : '.comms-band .comms-work')!;
    const tile = document.querySelector('.loom-tile[data-tile="/comms"]')!.getBoundingClientRect();
    // The comm screen: the band's, or (beside the agents' rail, docs/specs/agent-desk.md) the rail card's.
    const inRail = !document.querySelector('.comms-band .comms-screen');
    const scr = inRail ? '.loom-rscreen .comms-screen' : '.comms-band .comms-screen';
    const composer = r('.comms-composer'), chat = r('.comms-chat'), b = r('.comms-band'), glass = r(`${scr} .comms-screen__glass`);
    // Nothing past the window: no element wider than the tile; the frames (the box, the band, the chat, the composer) inside
    // its bottom too (a message scrolled out of the chat's own view is inside its scroller, not past the window).
    const inside = [...document.querySelectorAll('.loom-tile[data-tile="/comms"] .comms *')].every((e) => { const x = e.getBoundingClientRect(); return !x.width || (x.left >= tile.left - 1 && x.right <= tile.right + 1); })
      && ['.comms', '.comms-band', '.comms-chat', '.comms-composer'].every((q) => document.querySelector(q)!.getBoundingClientRect().bottom <= tile.bottom + 1);
    // The side (or the work column) scrolls: overflow-y auto, and a scroll moves it (a clipped side, overflow hidden, would read 0).
    const before = side.scrollTop; side.scrollTop = 9999; const moved = side.scrollTop > before && getComputedStyle(side).overflowY === 'auto'; side.scrollTop = 0;
    // The face: a pixel canvas drawn at a whole scale, its CSS size its own pixels (never stretched by layout).
    const cv = document.querySelector<HTMLCanvasElement>(`${scr} .comms-screen__glass canvas`);
    const face = cv ? { k: cv.getBoundingClientRect().width / cv.width, ky: cv.getBoundingClientRect().height / cv.height } : null;
    const list = document.querySelector('.comms > .loom-drawer-split__list')?.getBoundingClientRect();
    const thread = document.querySelector('.comms-thread')!.getBoundingClientRect();
    return { inRail, band: Math.round(b.height), side: { scroll: side.scrollHeight, client: side.clientHeight }, glass: [glass.width, glass.height],
      chatFills: Math.abs(chat.top - b.bottom) <= 2 && Math.abs(chat.bottom - composer.top) <= 2 && chat.height > 120, inside,
      one: document.querySelector('.comms')!.hasAttribute('data-one'), list: !!list, listW: list ? Math.round(list.width) : 0, beside: !!list && thread.left >= list.right - 1, moved, face };
  });

  for (const [w, hgt, layout, ws] of [[1024, 768, 'mid', ''], [1280, 800, 'mid', 'needs'], [1920, 1080, 'wide', '']] as const) {
    it(`the band: one fixed height with 0 and 20 work items, its side scrolling inside it; the face its own size; the chat the rest; nothing past the window, at ${w}×${hgt} (${layout}${ws ? ', beside the agents\' rail' : ''})`, async () => {
      const t = thread('art', 3);
      const sizes: Record<number, Awaited<ReturnType<typeof band>>> = {};
      for (const n of [0, 20]) {
        const ctx = await browser.newContext({ viewport: { width: w, height: hgt }, reducedMotion: 'reduce', serviceWorkers: 'block' });
        await ctx.addInitScript(`localStorage.setItem('loom-look', 'neon'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
        await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
        const p = await ctx.newPage();
        await p.route(`**/comms/${t.id}/work`, (r) => r.fulfill({ json: work(n) }));
        await p.goto(`${base}/comms/${bare(t)}?t=*comms`);
        await p.locator('.comms-band .comms-screen, .loom-rscreen .comms-screen').first().waitFor();
        await p.locator(n ? '.comms-band .comms-work .loom-kit-row' : '.comms-band .comms-work .loom-kit-state').first().waitFor();
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
        // From 1280 the comm screen is the agents' rail's (the band drops it); narrower, the band's at its own 2x.
        expect(s.inRail).toBe(w >= 1280);
        if (s.inRail) expect(s.glass[1]).toBe(184); else expect(s.glass).toEqual([192, 168]);
        expect(s.face).not.toBeNull();
        // Sheet pixels to screen pixels: a whole number, 2 or more, the same both ways (never stretched).
        expect(Number.isInteger(s.face!.k) && s.face!.k >= 2).toBe(true);
        expect(s.face!.ky).toBe(s.face!.k);
        expect(s.chatFills).toBe(true);
        expect(s.inside).toBe(true);
        // Mid-size (1024; 1280 beside the rail): one pane, the threads a drawer; wide: the list beside the thread.
        const two = layout === 'wide';
        expect(s.one).toBe(!two);
        expect(s.list).toBe(two);
        // Wide: the list, 320 px, beside the thread.
        if (two) expect([s.listW, s.beside]).toEqual([320, true]);
      }
    });
  }

  it('thread right-click actions stay on screen, dismiss with Escape, and archive then unarchive without opening the row', async () => {
    const t = thread('art', 1);
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    try {
      await ctx.addInitScript(`localStorage.setItem('loom-look', 'neon'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
      await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
      const p = await ctx.newPage();
      await p.goto(`${base}/comms/${bare(t)}?t=*comms`);
      const row = p.locator('.comms-list li').filter({ has: p.locator(`[data-prefetch="/comms/${bare(t)}"]`) });
      await row.waitFor();
      if (SHOTS) {
        await p.locator('.comms-composer textarea').fill('A little more room around Send.');
        await p.screenshot({ path: `${SHOTS}/comms-send-active.png` });
      }
      await row.click({ button: 'right' });
      const menu = p.getByRole('menu', { name: 'Thread actions' });
      await menu.waitFor();
      if (SHOTS) await p.screenshot({ path: `${SHOTS}/comms-thread-context.png` });
      expect(await menu.getByRole('menuitem').allTextContents()).toEqual(['Rename', 'Pin', 'Archive', 'Project', 'Delete']);
      const box = await menu.boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(1920);
      expect(box!.y + box!.height).toBeLessThanOrEqual(1080);
      await p.keyboard.press('Escape');
      expect(await menu.count()).toBe(0);
      await row.click({ button: 'right' });
      const archived = p.waitForResponse((r) => r.url().endsWith(`/comms/${t.id}/archive`) && r.request().method() === 'POST');
      await menu.getByRole('menuitem', { name: 'Archive', exact: true }).click();
      expect((await archived).status()).toBe(200);
      await expect.poll(() => row.count()).toBe(0);
      await p.getByRole('button', { name: 'Archived', exact: true }).click();
      await row.waitFor();
      await row.click({ button: 'right' });
      await menu.getByRole('menuitem', { name: 'Unarchive', exact: true }).click();
      await expect.poll(() => row.count()).toBe(0);
    } finally { await ctx.close(); }
  });

  /** The chat's room (Jonathan, 2026-11-07): scrolled to its end, how far the words stay from the scrollbar's rail and the
   *  scroller's right edge, and how far the last message and the rail end above the composer's divider. */
  const room = async (p: Page) => p.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('.comms-chat .comms-msgs')!;
    scroller.scrollTop = scroller.scrollHeight;
    const box = scroller.getBoundingClientRect();
    const rail = scroller.closest('[data-slot="scroll-area"]')?.querySelector(':scope > [data-slot="scroll-area-scrollbar"][data-orientation="vertical"]')?.getBoundingClientRect();
    const divider = document.querySelector('.comms-composer')!.getBoundingClientRect().top;
    // The words: every text-bearing piece of every message (bubbles, authors, the working line), not the scroller's own parts.
    const words = [...scroller.querySelectorAll('.v-agent-chat__message-body, .v-agent-chat__author, .comms-live, .comms-resend')].map((e) => e.getBoundingClientRect()).filter((r) => r.width);
    const msgs = [...scroller.querySelectorAll('.v-agent-chat__message')].map((e) => e.getBoundingClientRect());
    const last = msgs.at(-1)!;
    // The owner's message and an agent's: each bubble's box against the log's (the scroller's content box).
    const pad = parseFloat(getComputedStyle(scroller).paddingLeft), padR = parseFloat(getComputedStyle(scroller).paddingRight);
    const log = { left: box.left + pad, right: box.right - padR };
    const bubble = (from: string) => scroller.querySelector(`.v-agent-chat__message[data-from="${from}"] .v-agent-chat__message-body`)!.getBoundingClientRect();
    const mine = bubble('user'), theirs = bubble('agent');
    const share = (r: DOMRect) => Math.round((r.width / (log.right - log.left)) * 100);
    return { scrolls: scroller.scrollHeight > scroller.clientHeight + 4, rail: !!rail,
      toRail: Math.round((rail?.left ?? box.right) - Math.max(...words.map((r) => r.right))),
      toEdge: Math.round(box.right - Math.max(...words.map((r) => r.right))),
      lastToBottom: Math.round(box.bottom - last.bottom), lastToDivider: Math.round(divider - last.bottom),
      mine: { share: share(mine), toRight: Math.round(log.right - mine.right), toLeft: Math.round(mine.left - log.left) },
      theirs: { share: share(theirs), toLeft: Math.round(theirs.left - log.left) },
      railToDivider: rail ? Math.round(divider - rail.bottom) : null, scrollerToDivider: Math.round(divider - box.bottom) };
  });
  /** The band's columns: the comm screen, who's in the conversation, the work; side by side (three lefts) or stacked (two). */
  const columns = async (p: Page) => p.evaluate(() => {
    const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
    const inRail = !document.querySelector('.comms-band .comms-screen');
    const scr = inRail ? '.loom-rscreen .comms-screen' : '.comms-band .comms-screen';
    const screen = r(scr), people = r('.comms-band .comms-people'), work = r('.comms-band .comms-work'), b = r('.comms-band');
    const scrolls = (s: string) => { const e = document.querySelector<HTMLElement>(s)!; const st = getComputedStyle(e).overflowY; return st === 'auto' || st === 'scroll'; };
    const inBand = inRail ? [people, work] : [screen, people, work];
    return { inRail, n: new Set(inBand.map((x) => Math.round(x.left))).size, thread: Math.round(r('.comms-thread').width),
      people: Math.round(people.width), work: Math.round(work.width), glass: [r(`${scr} .comms-screen__glass`).width, r(`${scr} .comms-screen__glass`).height],
      inBand: inBand.every((x) => x.right <= b.right + 1 && x.left >= b.left - 1),
      workScrolls: scrolls('.comms-band .comms-work') || scrolls('.comms-band__side'), peopleScrolls: scrolls('.comms-band .comms-people') || scrolls('.comms-band__side') };
  });

  for (const look of ['neon', 'lowlight', 'daylight'] as const) {
    for (const [w, hgt, ws, cols] of [[1100, 800, '', 3], [1440, 900, '', 3], [1920, 1080, '', 3], [1280, 800, 'needs', 3], [1024, 768, 'needs', 3]] as const) {
      it(`the chat's room and the band's columns: the words clear of the scrollbar, the last message clear of the divider, ${cols} columns, at ${w}×${hgt}${ws ? ' beside the agents\' rail' : ''} (${look})`, async () => {
        const t = thread('art', 12, `My own long message. ${'It goes on long enough to wrap over several lines in any window. '.repeat(6)}`);
        const ctx = await browser.newContext({ viewport: { width: w, height: hgt }, reducedMotion: 'reduce', serviceWorkers: 'block' });
        await ctx.addInitScript(`localStorage.setItem('loom-look', '${look}'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
        await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
        const p = await ctx.newPage();
        await p.route(`**/comms/${t.id}/work`, (r) => r.fulfill({ json: work(20) }));
        await p.goto(`${base}/comms/${bare(t)}?t=*comms`);
        await p.locator('.comms-band .comms-work .loom-kit-row').first().waitFor();
        await p.locator('.comms-chat .v-agent-chat__message').nth(12).waitFor();
        await p.waitForTimeout(300);
        const g = await room(p);
        const c = await columns(p);
        if (SHOTS) await p.screenshot({ path: `${SHOTS}/comms-room-${look}-${w}${ws ? '-widgets' : ''}.png` });
        await ctx.close();
        // The chat scrolls, with its rail: the words keep a gap (--s-3 and more) from the rail, and the rail's width from the edge.
        expect(g.scrolls).toBe(true);
        expect(g.rail).toBe(true);
        expect(g.toRail).toBeGreaterThanOrEqual(12);
        expect(g.toEdge).toBeGreaterThanOrEqual(24 + 12);
        // Scrolled to the end: the last message ends a gap (--s-6 and more) above the scroller's bottom and the divider; the
        // rail ends clear of the divider too.
        expect(g.lastToBottom).toBeGreaterThanOrEqual(24);
        expect(g.lastToDivider).toBeGreaterThanOrEqual(24);
        expect(g.railToDivider).toBeGreaterThanOrEqual(8);
        // Your own message on the right, narrower than the log (about three quarters, like the agent's on the left).
        expect(g.mine.share).toBeLessThanOrEqual(78);
        expect(g.theirs.share).toBeLessThanOrEqual(78);
        expect(g.mine.toLeft).toBeGreaterThan(g.mine.toRight);
        expect(g.theirs.toLeft).toBeLessThan(60);
        // The band: three columns where they fit, the stack below; each column at least its least width, the face its own size.
        // From 1280 the screen is the rail's: the band is two columns, who's in it and the work.
        expect(c.inRail).toBe(w >= 1280);
        expect(c.n).toBe(c.inRail ? 2 : cols);
        if (c.inRail) expect(c.glass[1]).toBe(184); else expect(c.glass).toEqual([192, 168]);
        expect(c.inBand).toBe(true);
        expect(c.workScrolls && c.peopleScrolls).toBe(true);
        if (cols === 3 && !c.inRail) expect([c.people >= 180, c.work >= 300]).toEqual([true, true]);
        if (c.inRail) expect([c.people >= 160, c.work >= 300]).toEqual([true, true]);
      });
    }
  }

  it('your own message on a phone: on the right, a little wider than on a desktop, still narrower than the log', async () => {
    const t = thread('art', 2, `My own long message. ${'It goes on long enough to wrap over several lines on a phone. '.repeat(4)}`);
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await ctx.addInitScript(`localStorage.setItem('loom-look', 'neon'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    await p.goto(`${base}/comms/${bare(t)}`);
    const mine = p.locator('.comms[data-phone] .v-agent-chat__message[data-from="user"] .v-agent-chat__message-body').first();
    await mine.waitFor();
    await mine.scrollIntoViewIfNeeded();
    const r = await p.evaluate(() => {
      const log = document.querySelector('.comms-msgs')!, cs = getComputedStyle(log), b = log.getBoundingClientRect();
      const left = b.left + parseFloat(cs.paddingLeft), right = b.right - parseFloat(cs.paddingRight);
      const m = document.querySelector('.v-agent-chat__message[data-from="user"] .v-agent-chat__message-body')!.getBoundingClientRect();
      return { share: Math.round((m.width / (right - left)) * 100), toRight: Math.round(right - m.right), toLeft: Math.round(m.left - left), sideways: document.documentElement.scrollWidth > window.innerWidth + 1 };
    });
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/comms-room-phone-390.png` });
    await ctx.close();
    // At most four fifths of the log; flush right (only your avatar, 32 + 8, beside it), a clear gap on its left.
    expect(r.share).toBeLessThanOrEqual(82);
    expect(r.toRight).toBeLessThanOrEqual(42);
    expect(r.toLeft).toBeGreaterThanOrEqual(24);
    expect(r.sideways).toBe(false);
  });

  it('a short tile (under 520 px tall) folds the band to a strip: the chat keeps its room', async () => {
    const t = thread('art', 3);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 500 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await ctx.addInitScript(`localStorage.setItem('loom-look', 'neon'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    await p.goto(`${base}/comms/${bare(t)}?t=*comms`);
    await p.locator('.comms-thread[data-short] .comms-band').waitFor();
    const r = await p.evaluate(() => ({ band: document.querySelector('.comms-band')!.getBoundingClientRect().height, chat: document.querySelector('.comms-chat')!.getBoundingClientRect().height }));
    expect(r.band).toBeLessThanOrEqual(80);
    // (A 232 px band would leave the chat nothing at this height.)
    expect(r.chat).toBeGreaterThan(60);
    await ctx.close();
  });
});
