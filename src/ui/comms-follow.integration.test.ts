/**
 * Comms polish (t-1918; t-1925 C), in a real browser: a thread's address has no colon and reloads, an old one is sent
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
import { adapterCall, errorWords, openThread, postActivity, recordDelivery, sweepComms, BUSY_MS, type Thread } from '../comms.js';
import { stopCommsWatch } from './comms-live.js';
import { deliveredOutcome } from './comms-routes.js';

const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);
const hasAge = spawnSync('sh', ['-c', 'command -v age && command -v age-keygen'], { encoding: 'utf-8' }).status === 0;
const expect = Object.assign(((v: unknown, m?: string) => vexpect(v, m)) as typeof vexpect, vexpect,
  { poll: (f: () => unknown, o?: { timeout?: number }) => vexpect.poll(f, { timeout: 10_000, ...o }) }) as typeof vexpect;
const SHOTS = process.env.LOOM_SHOTS;
const ids = { n: 0 };
const msgId = () => `zz${String(++ids.n).padStart(14, 'a').replace(/\d/g, (d) => 'abcdefghij'[Number(d)])}`;

describe('a body that couldn\'t start isn\'t busy (t-1918)', () => {
  it('says so in words, with its own code', () => {
    expect(errorWords('start-retry', 'Mark', undefined)).toBe('Mark couldn\'t start; retrying.');
    expect(errorWords('busy', 'Mark', undefined)).toMatch(/busy/);
  });
  it('reads the runtime\'s answer: queued while it retries a start is start-retry; failed is start-failed; queued alone is queued', () => {
    // The runtime's own words for a retry (loom-box delivery.mjs, a start that failed).
    const retry = { body: 'queued', reason: 'no body could start (mark\'s body host didn\'t start the body in 60 s): trying again in 30 s' };
    expect(deliveredOutcome(retry)).toEqual({ delivered: true, body: 'queued', error: { code: 'start-retry', reason: retry.reason } });
    expect(deliveredOutcome({ body: 'failed', reason: 'no harness' })).toEqual({ delivered: true, body: 'failed', error: { code: 'start-failed', reason: 'no harness' } });
    expect(deliveredOutcome({ body: 'queued' })).toEqual({ delivered: true, body: 'queued' });
    expect(deliveredOutcome({ body: 'started' })).toEqual({ delivered: true, body: 'started' });
  });
});

describe.runIf(built && chrome && hasAge)('Comms: the address, the channel line, live activity and scrolling', () => {
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
    // A desktop with no widgets beside Comms: room for the list beside the thread (comms.tsx ONE_PANE_BELOW).
    await ctx.addInitScript(`localStorage.setItem('loom-look', 'neon'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');${phone ? '' : " if (!localStorage.getItem('loom-tiles')) localStorage.setItem('loom-tiles', JSON.stringify({ t: [], m: [], w: [] }));"}`);
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

  it('a thread\'s address has no colon, and a reload of it works; an old th: link is sent there', async () => {
    const t = thread('art', 1);
    const p = await screen(1280, 800, `/comms/${bare(t)}`);
    await p.locator('.comms-thread .comms-msg--agent').first().waitFor();
    expect(new URL(p.url()).pathname).toBe(`/comms/${bare(t)}`);
    await p.reload();
    await p.locator('.comms-thread .comms-msg--agent').first().waitFor();
    expect(new URL(p.url()).pathname).toBe(`/comms/${bare(t)}`);
    // The old address: redirected, then the same thread.
    await p.goto(`${base}/comms/${t.id}`);
    await p.locator('.comms-thread .comms-msg--agent').first().waitFor();
    expect(new URL(p.url()).pathname).toBe(`/comms/${bare(t)}`);
    // Opening a thread from the list lands on its colon-free address too.
    await p.goto(`${base}/comms`);
    await p.locator('.comms-row__btn').first().click();
    await expect.poll(() => new URL(p.url()).pathname).toMatch(/^\/comms\/[a-z2-7]{10}$/);
    // Its JSON answers at both.
    for (const at of [bare(t), t.id]) expect((await p.context().request.get(`${base}/comms/${at}`, { headers: { accept: 'application/json' } })).status()).toBe(200);
    // The list's agents are their letters, drawn in their colour (a lit square, not bare text).
    const letter = await p.locator('.comms-row .loom-letter').first().evaluate((e) => { const c = getComputedStyle(e); return { w: e.getBoundingClientRect().width, bg: c.backgroundColor, shadow: c.boxShadow }; });
    expect(letter.w).toBe(30);
    expect(letter.bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(letter.shadow).not.toBe('none');
    expect((p as Page & { errors: string[] }).errors).toEqual([]);
    await p.context().close();
  });

  it('the channel line says what the agent is doing: THINKING, WORKING, TALKING, DONE, WAITING ON YOU, NO CARRIER; no separate thinking blob', async () => {
    const t = thread('art');
    const p = await screen(1920, 1080, `/comms/${bare(t)}`, 'no-preference');
    await p.locator('.comms-screen').waitFor();
    await expect.poll(() => label(p)).toBe('ART E FISH · THINKING');
    expect(await p.locator('.comms-thread__head [data-slot="agent-state"], .comms-state').count()).toBe(0);
    await shot(p, 'thinking');
    adapterCall(h, process.env, { op: 'status', place: t.id, agent: 'art', status: 'working' });
    postActivity(h, process.env, { conversation: t.conversation, run: 'run-a', cards: [{ id: 'c1', at: new Date().toISOString(), tool: 'Bash', summary: 'Ran the tests', state: 'running' }] });
    await expect.poll(() => label(p)).toBe('ART E FISH · WORKING');
    // The working line shows the step it's on, as it happens.
    await expect.poll(() => p.locator('.comms-live').textContent()).toMatch(/Art E Fish is working · Ran the tests · \d+:\d\d/);
    await shot(p, 'working');
    postActivity(h, process.env, { conversation: t.conversation, run: 'run-a', cards: [{ id: 'c2', at: new Date().toISOString(), tool: 'Read', summary: 'Read comms.tsx', state: 'running' }] });
    await expect.poll(() => p.locator('.comms-live').textContent()).toMatch(/Read comms\.tsx/);
    await expect.poll(() => p.locator('.comms-steps__line').textContent()).toMatch(/2 steps/);
    await p.evaluate(() => {
      const w = window as unknown as { words: string[] }; w.words = [];
      const note = () => { const t = document.querySelector('.comms-screen__label > span')?.textContent ?? ''; if (t && w.words.at(-1) !== t) w.words.push(t); };
      note();
      new MutationObserver(note).observe(document.querySelector('.comms-screen')!, { subtree: true, childList: true, characterData: true });
    });
    adapterCall(h, process.env, { op: 'post', place: t.id, agent: 'art', text: 'All green.' });
    adapterCall(h, process.env, { op: 'status', place: t.id, agent: 'art', status: 'done' });
    // TALKING lasts only while the reply plays (a beat or so after the signal's 250 ms): a poll from here can miss it on a
    // loaded runner, so the page logs every word the line shows, and the order is checked from that log.
    await expect.poll(() => p.evaluate(() => (window as unknown as { words?: string[] }).words ?? []), { timeout: 12000 }).toEqual(expect.arrayContaining(['ART E FISH · TALKING']));
    await expect.poll(() => label(p), { timeout: 12000 }).toBe('ART E FISH · DONE');
    const said = await p.evaluate(() => (window as unknown as { words: string[] }).words);
    expect(said.indexOf('ART E FISH · TALKING')).toBeGreaterThan(said.indexOf('ART E FISH · WORKING'));
    expect(await p.locator('.comms-live').count()).toBe(0);
    // An ask waiting on you (as loom adds it from the approvals piece's manifest).
    await p.route(`**/comms/${t.id}/since/**`, async (route) => {
      const r = await route.fetch();
      const j = await r.json() as Record<string, unknown>;
      await route.fulfill({ json: { ...j, asks: [{ id: 'a-0001', piece: 'approvals', text: 'OK to merge?', actions: [{ action: 'allow', label: 'Allow once', fields: { id: 'a-0001' } }] }] } });
    });
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => label(p)).toBe('ART E FISH · WAITING ON YOU');
    await p.unroute(`**/comms/${t.id}/since/**`);
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => label(p)).toBe('ART E FISH · DONE');
    // No runtime here: a message from the composer can't be delivered, and there's no carrier.
    await p.locator('.comms-composer textarea').fill('Can you hear me?');
    await p.locator('.comms-composer textarea').press('Enter');
    await expect.poll(() => label(p)).toBe('ART E FISH · NO CARRIER');
    await p.context().close();
  });

  for (const [w, hgt] of [[1280, 800], [1920, 1080], [390, 844]] as const) {
    it(`follows the bottom only when you're there; scrolled up, a pill counts what's new, nothing yanks; content above keeps its place, at ${w}×${hgt}`, async () => {
      const t = thread('mark', 30);
      const p = await screen(w, hgt, `/comms/${bare(t)}`);
      await p.locator('.comms-msg--agent').nth(29).waitFor();
      // The scroller: the thread's own on a desktop, the page on a phone.
      const at = () => p.evaluate(() => {
        const end = document.querySelector('.comms-end')!;
        let s: Element | null = end.parentElement;
        while (s && !(/(auto|scroll)/.test(getComputedStyle(s).overflowY) && s.scrollHeight > s.clientHeight + 1)) s = s.parentElement;
        const el = (s ?? document.scrollingElement)!;
        return { top: el.scrollTop, gap: el.scrollHeight - el.scrollTop - el.clientHeight };
      });
      const scrollBy = (dy: number) => p.evaluate((dy) => {
        const end = document.querySelector('.comms-end')!;
        let s: Element | null = end.parentElement;
        while (s && !(/(auto|scroll)/.test(getComputedStyle(s).overflowY) && s.scrollHeight > s.clientHeight + 1)) s = s.parentElement;
        (s ?? document.scrollingElement)!.scrollBy(0, dy);
      }, dy);
      // Opened at the bottom.
      await expect.poll(async () => (await at()).gap).toBeLessThanOrEqual(80);
      // At the bottom: a new reply is followed.
      adapterCall(h, process.env, { op: 'post', place: t.id, agent: 'mark', text: 'Followed.' });
      await p.locator('.comms-msg--agent', { hasText: 'Followed.' }).waitFor();
      await expect.poll(async () => (await at()).gap).toBeLessThanOrEqual(80);
      expect(await p.locator('.comms-newpill').count()).toBe(0);
      // Within 80 px of it still counts as there.
      await scrollBy(-50);
      adapterCall(h, process.env, { op: 'post', place: t.id, agent: 'mark', text: 'Still followed.' });
      await p.locator('.comms-msg--agent', { hasText: 'Still followed.' }).waitFor();
      await expect.poll(async () => (await at()).gap).toBeLessThanOrEqual(80);
      // Scrolled well up: two replies land, the reader stays exactly where they were, the pill counts them.
      await scrollBy(-1200);
      await p.waitForTimeout(200);
      const before = await at();
      expect(before.gap).toBeGreaterThan(80);
      adapterCall(h, process.env, { op: 'post', place: t.id, agent: 'mark', text: 'Unseen one.' });
      adapterCall(h, process.env, { op: 'post', place: t.id, agent: 'mark', text: 'Unseen two.' });
      await p.locator('.comms-msg--agent', { hasText: 'Unseen two.' }).waitFor({ state: 'attached' });
      await expect.poll(() => p.locator('.comms-newpill').textContent()).toBe('2 new messages ↓');
      expect((await at()).top).toBe(before.top);
      // A run's step cards aren't messages: they don't count.
      postActivity(h, process.env, { conversation: t.conversation, run: `run-${w}`, cards: [1, 2, 3].map((n) => ({ id: `k${n}`, at: new Date().toISOString(), tool: 'Bash', summary: `Step ${n}`, state: 'done' })) });
      await p.locator('.comms-steps__line', { hasText: '3 steps' }).waitFor({ state: 'attached' });
      await p.waitForTimeout(300);
      expect(await p.locator('.comms-newpill').textContent()).toBe('2 new messages ↓');
      expect((await at()).top).toBe(before.top);
      if (w === 1280) await shot(p, 'pill');
      // Something above the reader grows (a run's steps opened, an older message's words): they stay where they are.
      const anchor = await p.evaluate(() => {
        const ms = [...document.querySelectorAll('.comms-msg--agent')];
        const inView = ms.find((m) => { const r = m.getBoundingClientRect(); return r.top > 120 && r.bottom < innerHeight - 120; })!;
        (inView as HTMLElement).dataset.anchor = '1';
        const above = ms[ms.indexOf(inView) - 3] as HTMLElement;
        const grow = document.createElement('div'); grow.style.height = '300px'; grow.className = 'grow';
        above.append(grow);
        return null;
      });
      void anchor;
      await p.waitForTimeout(150);
      const y1 = await p.locator('[data-anchor="1"]').evaluate((e) => e.getBoundingClientRect().top);
      await p.evaluate(() => { (document.querySelector('.grow') as HTMLElement).style.height = '600px'; });
      await p.waitForTimeout(150);
      const y2 = await p.locator('[data-anchor="1"]').evaluate((e) => e.getBoundingClientRect().top);
      expect(Math.abs(y2 - y1)).toBeLessThanOrEqual(2);
      // The pill takes you down and goes.
      await p.locator('.comms-newpill').click();
      await expect.poll(async () => (await at()).gap).toBeLessThanOrEqual(80);
      await expect.poll(() => p.locator('.comms-newpill').count()).toBe(0);
      await p.context().close();
    });
  }

  it('the Enter hint: faint, and only while the composer has focus; it takes no line of its own', async () => {
    const t = thread('art', 1);
    const p = await screen(1280, 800, `/comms/${bare(t)}`);
    const hint = p.locator('.comms-composer .v-agent-chat__hint');
    await hint.waitFor({ state: 'attached' });
    const o = () => hint.evaluate((e) => Number(getComputedStyle(e).opacity));
    expect(await o()).toBe(0);
    const h0 = await p.locator('.comms-composer').evaluate((e) => e.getBoundingClientRect().height);
    await p.locator('.comms-composer textarea').focus();
    await expect.poll(o).toBeGreaterThan(0.5);
    expect(await hint.evaluate((e) => getComputedStyle(e).position)).toBe('absolute');
    expect(await p.locator('.comms-composer').evaluate((e) => e.getBoundingClientRect().height)).toBe(h0);
    expect(await hint.textContent()).toMatch(/Enter to send/);
    await p.context().close();
  });

  it('a body that couldn\'t start is not "busy": the thread says it\'s retrying, with what happened, and the sweep adds no busy line', async () => {
    const o = openThread(h, process.env, h.members[0], { agent: 'mark', id: msgId(), text: 'Are you there?' });
    recordDelivery(h, o.thread, o.seq, deliveredOutcome({ body: 'queued', reason: 'no body could start (mark\'s body host didn\'t start the body in 60 s): trying again in 30 s' }));
    sweepComms(h, new Date(Date.now() + BUSY_MS + 60_000));
    // A plain queued one, for contrast: it does get its busy line.
    const q = openThread(h, process.env, h.members[0], { agent: 'mark', id: msgId(), text: 'And you?' });
    recordDelivery(h, q.thread, q.seq, deliveredOutcome({ body: 'queued' }));
    sweepComms(h, new Date(Date.now() + BUSY_MS + 60_000));
    const busy = await screen(1280, 800, `/comms/${bare(q.thread)}`);
    await busy.locator('.comms-msg--error', { hasText: 'busy with other work' }).waitFor();
    await busy.context().close();
    const p = await screen(1280, 800, `/comms/${bare(o.thread)}`);
    const card = p.locator('.comms-msg--error', { hasText: /couldn't start; retrying\./ });
    await card.waitFor();
    expect(await card.locator('a.comms-trace').textContent()).toBe('What happened');
    expect(await p.getByText('busy with other work').count()).toBe(0);
    await p.context().close();
  });
});
