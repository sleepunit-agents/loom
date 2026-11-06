/**
 * Comms' phone composer under a finger (Jonathan, 2026-11-05, on his iPhone: "Hard to get the input to take and then
 * after I do and type something I can't get send to work"), in a real browser at an iPhone's size with touch, driven by
 * CDP touches as the gestures tests are: what's under the field and under Send is the field and Send, with the keyboard
 * down and up, in every look; a tap on the field focuses it; a tap on Send sends once and leaves the field focused (so a
 * phone's keyboard stays up, and the composer doesn't jump from under the finger); a tap or a short drag in the composer
 * starts none of the phone's gestures. An ask's reply box in the Inbox gets the same.
 *
 * Only Chromium runs here. iOS's keyboard is stood in for: it sets --comms-kb (as useKeyboardInset does from the visual
 * viewport) while a field has focus, and drops it when the field blurs, which is what moves the composer on an iPhone.
 *
 * Runs where the app is built (npm run build), a Chrome is installed and age is (the thread's words are encrypted).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { chromium, type Browser, type CDPSession, type Page } from 'playwright-core';
import type { Look } from '../../web/src/look';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from '../household.js';
import { createConversationTables, recordTurn, writeDigest } from '../backends/conversations.js';
import { closeAllBackends } from '../backends/index.js';
import { openThread, recordDelivery } from '../comms.js';
import { stopCommsWatch } from './comms-live.js';

const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);
const hasAge = spawnSync('sh', ['-c', 'command -v age && command -v age-keygen'], { encoding: 'utf-8' }).status === 0;
/** An iPhone's keyboard (with its suggestions bar), over a 844 px screen. */
const KB = 336;

type Phone = { p: Page; cdp: CDPSession; posts: string[] };

describe.runIf(built && chrome && hasAge)('Comms\' phone composer under a finger', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  let thread: { id: string };
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-comms-touch-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), a === 'art' ? '# Art E Fish\n' : '# Visual Mark\n');
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db')); createConversationTables(db); db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
    for (const k of ['LOOM_HOME', 'XDG_CONFIG_HOME']) saved[k] = process.env[k];
    process.env.LOOM_HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    h = loadHousehold(home)!;
    token = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: 'jonathan' }).token;
    const o = openThread(h, process.env, h.members[0], { agent: 'art', id: 'aaaaaaaaaaaaaaaa', text: 'Can you hear me?' });
    thread = o.thread;
    recordDelivery(h, o.thread, o.seq, { delivered: true, body: 'started' });
    const art = agentDir(h, 'art');
    const conv = recordTurn(art, 'art', { venue: 'wake', place: 'lane:making', label: 't-738: sonarr', at: new Date().toISOString(), from: { kind: 'schedule' }, kind: 'wake' }, 'runtime:clock').conversation;
    writeDigest(art, { conversation: conv, run: 'r1' }, { summary: 'Checked.', needs_owner: { ask: 'OK to turn off the recycle bin on Sonarr for a quick rename?',
      why: 'Deleting a big show takes hours.', if_yes: 'I turn it off.', if_no: 'I plan a rework.', refs: ['t-738'] } } as never);
    handle = await startHttpServer({ contextDir: art, host: '127.0.0.1', port: 0, household: h });
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

  /** An iPhone (390 x 844, touch, its insets) in a look, its POSTs counted. */
  async function phone(look: Look): Promise<Phone> {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    await ctx.addInitScript((l) => { localStorage.setItem('loom-look', l); sessionStorage.setItem('loom-arrived', '1'); }, look);
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    const posts: string[] = [];
    p.on('request', (r) => { if (r.method() === 'POST') posts.push(new URL(r.url()).pathname); });
    const cdp = await ctx.newCDPSession(p);
    await cdp.send('Emulation.setSafeAreaInsetsOverride' as never, { insets: { top: 47, topMax: 47, bottom: 34, bottomMax: 34 } } as never);
    await p.goto(`${base}/appearance`);
    await p.locator('.loom-top h1').waitFor();
    const csrf = await p.evaluate(async () => ((await (await fetch('/appearance', { headers: { accept: 'application/json' } })).json()) as { chrome: { csrf: string } }).chrome.csrf);
    await p.evaluate(async ([c, l]) => { await fetch('/appearance/prefs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ _csrf: c, look: l }) }); }, [csrf, look] as const);
    posts.length = 0;
    return { p, cdp, posts };
  }
  const openThreadPage = async ({ p }: Phone) => {
    await p.goto(`${base}/comms/${thread.id}`);
    await p.locator('.comms-composer textarea').waitFor();
    await p.waitForTimeout(1200);
  };
  /** iOS's keyboard, stood in for: up while a field has focus (--comms-kb), down when it blurs. */
  const keyboard = ({ p }: Phone) => p.evaluate((kb) => {
    const set = () => { const a = document.activeElement; document.documentElement.style.setProperty('--comms-kb', a && a.matches('textarea, input') ? `${kb}px` : '0px'); };
    document.addEventListener('focusin', set); document.addEventListener('focusout', () => setTimeout(set));
    set();
  }, KB);
  const kb = ({ p }: Phone) => p.evaluate(() => document.documentElement.style.getPropertyValue('--comms-kb'));
  const centre = async ({ p }: Phone, sel: string) => { const b = (await p.locator(sel).first().boundingBox())!; return [b.x + b.width / 2, b.y + b.height / 2] as [number, number]; };
  /** What a finger at an element's centre lands on: the element itself, or what's over it. */
  const under = ({ p }: Phone, sel: string) => p.evaluate((s) => {
    const el = document.querySelector(s)!; const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return hit === el || el.contains(hit) ? 'itself' : `${hit?.tagName.toLowerCase()}.${String(hit?.className ?? '').trim().split(/\s+/).join('.')}`;
  }, sel);
  const tap = async ({ p, cdp }: Phone, [x, y]: [number, number]) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await p.waitForTimeout(500);
  };
  async function drag({ p, cdp }: Phone, from: [number, number], to: [number, number]) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from[0], y: from[1] }] });
    for (let n = 1; n <= 10; n++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from[0] + (to[0] - from[0]) * n / 10, y: from[1] + (to[1] - from[1]) * n / 10 }] });
      await p.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await p.waitForTimeout(500);
  }
  const focused = ({ p }: Phone) => p.evaluate(() => document.activeElement?.tagName.toLowerCase() ?? '');
  const sends = (f: Phone) => f.posts.filter((u) => u === `/comms/${thread.id}/send`).length;

  for (const look of ['neon', 'lowlight', 'daylight'] as const) {
    it(`${look}: the field and Send are what's under a finger, keyboard down and up; a tap on each works first time`, async () => {
      const f = await phone(look);
      try {
        await openThreadPage(f);
        // Keyboard down: the composer sits on the dock, and nothing of the dock's lies over it.
        expect(await under(f, '.comms-composer textarea')).toBe('itself');
        expect(await under(f, '.comms-composer__send')).toBe('itself');
        await keyboard(f);
        // A tap on the field focuses it, and the (stood-in) keyboard comes up.
        await tap(f, await centre(f, '.comms-composer textarea'));
        expect(await focused(f)).toBe('textarea');
        expect(await kb(f)).toBe(`${KB}px`);
        expect(await under(f, '.comms-composer textarea')).toBe('itself');
        await f.p.keyboard.type('Testing, one two');
        expect(await under(f, '.comms-composer__send')).toBe('itself');
        // A tap on Send, keyboard up: it sends once, the field keeps its focus, the keyboard stays.
        await f.p.evaluate(() => addEventListener('click', () => { (window as unknown as { __at: string }).__at = document.activeElement?.tagName.toLowerCase() ?? ''; }, { capture: true, once: true }));
        await tap(f, await centre(f, '.comms-composer__send'));
        expect(await f.p.evaluate(() => (window as unknown as { __at: string }).__at)).toBe('textarea');
        await f.p.waitForTimeout(300);
        expect(sends(f)).toBe(1);
        expect(await f.p.locator('.comms-composer textarea').inputValue()).toBe('');
        expect(await focused(f)).toBe('textarea');
        expect(await kb(f)).toBe(`${KB}px`);
        // Keyboard down (the field let go), Send's still Send.
        await f.p.locator('.comms-composer textarea').fill('Again');
        await f.p.evaluate(() => (document.activeElement as HTMLElement).blur());
        await f.p.waitForTimeout(100);
        expect(await kb(f)).toBe('0px');
        expect(await under(f, '.comms-composer__send')).toBe('itself');
        await tap(f, await centre(f, '.comms-composer__send'));
        await f.p.waitForTimeout(300);
        expect(sends(f)).toBe(2);
      } finally { await f.p.context().close(); }
    }, 60_000);
  }

  it('a tap or a short drag in the composer starts none of the phone\'s gestures (no Find, no page change)', async () => {
    const f = await phone('neon');
    try {
      await openThreadPage(f);
      const path = await f.p.evaluate(() => location.pathname);
      const [x, y] = await centre(f, '.comms-composer textarea');
      const [sx, sy] = await centre(f, '.comms-composer__send');
      const drags: [[number, number], [number, number]][] = [[[x, y], [x, y - 80]], [[x, y], [x - 120, y + 4]], [[sx, sy], [sx, sy - 80]], [[sx, sy], [sx - 150, sy]]];
      for (const [from, to] of drags) {
        await drag(f, from, to);
        expect(await f.p.locator('.loom-find').count()).toBe(0);
        expect(await f.p.evaluate(() => location.pathname)).toBe(path);
      }
      await tap(f, [x, y]);
      expect(await f.p.locator('.loom-find').count()).toBe(0);
      expect(sends(f)).toBe(0);
      // The dock's own strip, just over its keys, still opens Find on a swipe up.
      const key = (await f.p.locator('.loom-dock-bar [data-part="item"]').first().boundingBox())!;
      await drag(f, [key.x + key.width / 2, key.y - 12], [key.x + key.width / 2, key.y - 160]);
      expect(await f.p.locator('.loom-find').count()).toBe(1);
    } finally { await f.p.context().close(); }
  }, 60_000);

  it('an ask\'s reply box: its field and Send are under a finger, and a press on Send keeps the field focused', async () => {
    const f = await phone('neon');
    try {
      await f.p.goto(`${base}/inbox`);
      await f.p.locator('.loom-top h1').waitFor();
      await f.p.getByRole('button', { name: /recycle bin/ }).first().tap();
      await f.p.locator('#loom-reply').waitFor();
      await f.p.waitForTimeout(600);
      expect(await under(f, '#loom-reply')).toBe('itself');
      await tap(f, await centre(f, '#loom-reply'));
      expect(await focused(f)).toBe('textarea');
      await f.p.keyboard.type('Rename it first.');
      const send = f.p.locator('section:has(#loom-reply) button', { hasText: 'Send' });
      const b = (await send.boundingBox())!;
      const at: [number, number] = [b.x + b.width / 2, b.y + b.height / 2];
      expect(await f.p.evaluate(([cx, cy]) => document.elementFromPoint(cx, cy)?.closest('button')?.textContent, at)).toBe('Send');
      f.posts.length = 0;
      // The press leaves the field focused (and a phone's keyboard up) until its click lands, so nothing moves under
      // the finger first.
      await f.p.evaluate(() => addEventListener('click', () => { (window as unknown as { __at: string }).__at = document.activeElement?.id ?? ''; }, { capture: true, once: true }));
      await tap(f, at);
      expect(await f.p.evaluate(() => (window as unknown as { __at: string }).__at)).toBe('loom-reply');
      expect(f.posts).toHaveLength(1);
    } finally { await f.p.context().close(); }
  }, 60_000);
});
