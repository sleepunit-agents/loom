/**
 * Asks and loom things inline in a Comms thread, in a real browser (t-1979; docs/specs/comms.md, "Asks inline" and
 * "Chips"): an ask the agent raised from the thread is drawn where it was raised, with the Inbox's own buttons; answered
 * there it leaves the Inbox, and answered elsewhere the thread shows it live; a member who may not give it sees no
 * buttons; the refs a reply names are chips only where the reader could open them. With COMMS_INLINE_SHOTS set to a
 * directory, it also keeps screenshots of the thread at 1440 and at a phone's width in each of the three looks.
 *
 * Runs where the app is built (npm run build), a Chrome is installed and age is (the thread's words are encrypted).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from '../household.js';
import { createConversationTables } from '../backends/conversations.js';
import { adapterCall, openThread, recordDelivery } from '../comms.js';
import { parseLoomBlock } from '../cli/pieces-managed.js';
import { clearPieceCache } from './pieces.js';
import { stopCommsWatch } from './comms-live.js';

const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);
const hasAge = spawnSync('sh', ['-c', 'command -v age && command -v age-keygen'], { encoding: 'utf-8' }).status === 0;
const SHOTS = process.env.COMMS_INLINE_SHOTS;

/** A stand-in approvals piece (owners: 2): its asks are approvals-asks.json; Allow and Deny take one out and keep its state. */
const APPROVALS = `#!${process.execPath}
const fs = require('node:fs');
const f = process.env.LOOM_HOME + '/approvals-asks.json';
const st = process.env.LOOM_HOME + '/approvals-state.json';
const read = (x, d) => fs.existsSync(x) ? JSON.parse(fs.readFileSync(x, 'utf-8')) : d;
if (process.argv[2] === 'ui' && process.argv[3] === '--json') {
  console.log(JSON.stringify({ v: 2, owners: 2, tab: { label: 'Approvals', kind: 'setting' }, asks: read(f, []) }));
} else if (process.argv[2] === 'ui' && process.argv[3] === 'act') {
  const req = JSON.parse(fs.readFileSync(0, 'utf-8'));
  const id = req.fields && req.fields.id;
  const asks = read(f, []);
  if (!asks.some((a) => a.actions.some((b) => b.fields.id === id))) { console.log(JSON.stringify({ ok: false, message: 'Not pending.', page: '' })); process.exit(0); }
  fs.writeFileSync(f, JSON.stringify(asks.filter((a) => !a.actions.some((b) => b.fields.id === id))));
  const s = read(st, {}); s[id] = { state: req.action === 'allow' ? 'allowed' : 'denied', agent: 'art', kind: 'merge' }; fs.writeFileSync(st, JSON.stringify(s));
  console.log(JSON.stringify({ ok: true, message: req.action === 'allow' ? 'Allowed once.' : 'Denied.', page: '' }));
} else if (process.argv[2] === 'ui') {
  console.log(JSON.stringify({ title: 'Approvals', sections: [] }));
} else if (process.argv[2] === 'api' && process.argv[3] === '--json') {
  const req = JSON.parse(fs.readFileSync(0, 'utf-8'));
  const s = read(st, {});
  if (req.path === 'state') console.log(JSON.stringify({ status: 200, body: { approvals: Object.fromEntries((req.body.ids || []).filter((i) => s[i]).map((i) => [i, s[i]])) } }));
  else console.log(JSON.stringify({ status: 404, body: { error: 'no' } }));
} else process.exit(2);
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
  rmSync(join(home, 'pieces', 'bin', `loom-${name}`), { force: true });
  symlinkSync(bin, join(home, 'pieces', 'bin', `loom-${name}`));
}

describe.runIf(built && chrome && hasAge)('asks and loom things inline in Comms (t-1979)', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  const tok: Record<string, string> = {};
  const saved: Record<string, string | undefined> = {};
  let n = 0;
  /** A message id of its own each time: 16 base32 letters. */
  const id16 = () => `inline${(n++).toString(26).padStart(10, '0').replace(/[0-9]/g, (d) => 'qrstuvwxyz'[Number(d)])}`;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-comms-inline-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a === 'art' ? 'Art E Fish' : 'Mark'}\n\nCreed.\n`);
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db'));
      createConversationTables(db);
      db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', members: [
      { person: 'jonathan', role: 'owner', agents: '*' }, { person: 'sam', role: 'owner', agents: ['art'] }] }));
    for (const k of ['LOOM_HOME', 'XDG_CONFIG_HOME']) saved[k] = process.env[k];
    process.env.LOOM_HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    clearPieceCache();
    piece(home, 'approvals', { role: 'approvals' }, APPROVALS);
    h = loadHousehold(home)!;
    tok.jonathan = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: 'jonathan' }).token;
    tok.sam = createToken(h, { role: { kind: 'owner', member: 'sam' }, label: 'sam' }).token;
    handle = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
    stopCommsWatch();
    await handle?.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(h.home, { recursive: true, force: true });
  });

  const asks = (list: unknown[]) => { writeFileSync(join(h.home, 'approvals-asks.json'), JSON.stringify(list)); clearPieceCache(); };
  const permission = (id: string, conversation: string, at: string, more: Record<string, unknown> = {}) => ({
    text: 'OK to merge the comm screen PR?', why: 'CI is green and the review is clean.', if_yes: 'I merge acme/app#3 now.', if_no: 'It waits for you.',
    fine: `merge · github:acme/app#3@abc`, kind: 'permission', tone: 'warn', agent: 'art', conversation, at, ...more,
    actions: [{ action: 'allow', label: 'Allow once', tone: 'primary', fields: { id } }, { action: 'deny', label: 'Deny', tone: 'danger', fields: { id } }] });
  /** A thread: your message, then (a minute later) the agent's reply; the ask goes between them. */
  const thread = (member = h.members[0], reply = 'Opened acme/app#3 for the comm screen. It needs your OK to merge: see a-00000101 above. Tracked in t-12; @mark reviewed.', between?: (t: { conversation: string }) => void) => {
    const o = openThread(h, process.env, member, { agent: 'art', id: id16(), text: 'Ship the comm screen when it\'s green?' }, new Date(Date.now() - 60_000));
    recordDelivery(h, o.thread, o.seq, { delivered: true, body: 'started' });
    between?.(o.thread);
    adapterCall(h, process.env, { op: 'post', place: o.thread.id, agent: 'art', text: reply });
    adapterCall(h, process.env, { op: 'status', place: o.thread.id, agent: 'art', status: 'done' });
    return o.thread;
  };

  async function open(who: 'jonathan' | 'sam', size: { width: number; height: number; phone?: boolean }, look = 'neon'): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
    const ctx = await browser.newContext(size.phone
      ? { viewport: { width: size.width, height: size.height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' }
      : { viewport: { width: size.width, height: size.height }, serviceWorkers: 'block' });
    await ctx.request.post(`${base}/login`, { form: { token: tok[who] }, maxRedirects: 0 });
    await ctx.addInitScript(`localStorage.setItem('loom-look', '${look}'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');${size.phone ? '' : " if (!localStorage.getItem('loom-tiles')) localStorage.setItem('loom-tiles', JSON.stringify({ t: [], m: [], w: [] }));"}`);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    return { ctx, page, errors };
  }
  const DESK = { width: 1440, height: 900 };
  const PHONE = { width: 390, height: 844, phone: true };
  const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  const inboxOpen = async (id: string) => (await (await fetch(`${base}/inbox/open?a=${id}`, { headers: { accept: 'application/json', authorization: `Bearer ${tok.jonathan}` } })).json()) as { open: boolean };

  it('an ask raised in the thread shows where it was raised, with the Inbox\'s words and live Allow and Deny; Allow there clears it from the Inbox', async () => {
    // Raised between your message (a minute ago) and the reply (now).
    const t = thread(undefined, undefined, (x) => asks([permission('a-00000101', x.conversation, new Date(Date.now() - 30_000).toISOString())]));
    const { ctx, page, errors } = await open('jonathan', DESK);
    try {
      await page.goto(`${base}/comms/${t.id}`);
      const card = page.locator('.comms-ask');
      await card.waitFor();
      expect(await card.locator('h3').textContent()).toBe('OK to merge the comm screen PR?');
      expect(await card.locator('.comms-ask__either').textContent()).toContain('If you allowI merge acme/app#3 now.');
      // Where it was raised: after your message, before the reply that came after it.
      const order = await page.locator('.comms-ask, .comms-msg--mine, .comms-msg--agent').evaluateAll((els) => els.map((e) => (e.classList.contains('comms-ask') ? 'ask' : e.classList.contains('comms-msg--mine') ? 'mine' : 'reply')));
      expect(order).toEqual(['mine', 'ask', 'reply']);
      const allow = page.getByRole('button', { name: 'Allow once' });
      await expect.poll(() => allow.isEnabled(), { timeout: 10_000 }).toBe(true);
      expect(await page.locator('.comms-screen').getAttribute('data-face')).toBe('needs-input');
      expect(await inboxOpen('a-00000101')).toEqual({ open: true });
      await allow.click();
      await expect.poll(() => card.locator('.v-agent-chat__receipt').textContent(), { timeout: 10_000 }).toMatch(/^Allowed by you · /);
      expect(await inboxOpen('a-00000101')).toEqual({ open: false });
      // Read again from loom (a reload): still there, answered, no buttons.
      await page.reload();
      await card.waitFor();
      await expect.poll(() => card.getAttribute('data-state'), { timeout: 10_000 }).toBe('answered');
      expect(await card.locator('.v-agent-chat__receipt').textContent()).toMatch(/^Allowed by you · /);
      expect(await page.getByRole('button', { name: 'Allow once' }).count()).toBe(0);
      expect(errors).toEqual([]);
    } finally { await ctx.close(); }
  }, 120_000);

  it('an Allow whose answer can\'t be read says so at once and shows what loom recorded, never a spinner that ends in nothing (t-1995)', async () => {
    const t = thread();
    asks([permission('a-00000105', t.conversation, new Date(Date.now() - 500).toISOString())]);
    const { ctx, page, errors } = await open('jonathan', DESK);
    try {
      // The Allow reaches loom and is recorded; the answer on its way back is garbled.
      await page.route('**/act/approvals', async (route) => { await route.fetch(); await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok": tru' }); });
      await page.goto(`${base}/comms/${t.id}`);
      const card = page.locator('.comms-ask');
      const allow = page.getByRole('button', { name: 'Allow once' });
      await expect.poll(() => allow.isEnabled(), { timeout: 10_000 }).toBe(true);
      await allow.click();
      await expect.poll(() => card.locator('.comms-ask__said').textContent({ timeout: 500 }).catch(() => ''), { timeout: 10_000 }).toMatch(/couldn’t be read/);
      // Read again from loom: the card shows the decision loom recorded.
      await expect.poll(() => card.locator('.v-agent-chat__receipt').textContent({ timeout: 500 }).catch(() => ''), { timeout: 20_000 }).toMatch(/^Allowed by you · /);
      expect(await inboxOpen('a-00000105')).toEqual({ open: false });
      // Nothing was recorded (the act never reached loom): it says so, and the buttons stay for a second try.
      await page.unroute('**/act/approvals');
      asks([permission('a-00000106', t.conversation, new Date(Date.now() - 400).toISOString())]);
      await page.route('**/act/approvals', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '<html>' }));
      await page.reload();
      const second = page.locator('.comms-ask[data-state="open"]');
      await second.waitFor();
      const again = second.getByRole('button', { name: 'Allow once' });
      await expect.poll(() => again.isEnabled(), { timeout: 10_000 }).toBe(true);
      await again.click();
      await expect.poll(() => second.locator('.comms-ask__said').textContent({ timeout: 500 }).catch(() => ''), { timeout: 10_000 }).toMatch(/couldn’t be read/);
      expect(await inboxOpen('a-00000106')).toEqual({ open: true });
      await expect.poll(() => again.isEnabled(), { timeout: 10_000 }).toBe(true);
      expect(errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
    } finally { await ctx.close(); }
  }, 120_000);

  it('answered in the Inbox, the thread shows the answer live, without a reload', async () => {
    const t = thread();
    asks([permission('a-00000102', t.conversation, new Date(Date.now() - 500).toISOString())]);
    const { ctx, page, errors } = await open('jonathan', DESK);
    try {
      await page.goto(`${base}/comms/${t.id}`);
      const allow = page.getByRole('button', { name: 'Allow once' });
      await expect.poll(() => allow.isEnabled(), { timeout: 10_000 }).toBe(true);
      // The Inbox's Deny: the same /act, from elsewhere.
      const r = await fetch(`${base}/act/approvals`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'x-loom-fetch': '1', authorization: `Bearer ${tok.jonathan}` },
        body: new URLSearchParams({ _action: 'deny', id: 'a-00000102' }) });
      expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
      await expect.poll(() => page.locator('.comms-ask .v-agent-chat__receipt').textContent({ timeout: 500 }).catch(() => ''), { timeout: 20_000 }).toMatch(/^Denied by you · /);
      expect(await page.getByRole('button', { name: 'Allow once' }).count()).toBe(0);
      expect(errors).toEqual([]);
    } finally { await ctx.close(); }
  }, 120_000);

  it('once what needs you is live, the thread reads again when its agent\'s asks move, not on another agent\'s (t-2027)', async () => {
    const t = thread();
    const raised = new Date(Date.now() - 500).toISOString();
    asks([permission('a-00000110', t.conversation, raised)]);
    const { ctx, page, errors } = await open('jonathan', DESK);
    const reads: number[] = [];
    page.on('request', (r) => { if (r.url().includes(`${t.id.replace(/^th:/, '')}/since/`)) reads.push(Date.now()); });
    try {
      await page.goto(`${base}/comms/${t.id}`);
      await page.waitForFunction(() => document.documentElement.dataset.attention === 'live');
      const allow = page.getByRole('button', { name: 'Allow once' });
      await expect.poll(() => allow.isEnabled(), { timeout: 10_000 }).toBe(true);
      await new Promise((r) => setTimeout(r, 2_000));
      const before = reads.length;
      // Mark's ask, from Mark's own conversation: what needs you moves, and loom says something changed; this thread of
      // Art's has nothing new, so it isn't read again (before: once for the bare change).
      asks([permission('a-00000110', t.conversation, raised), permission('a-00000111', 'cv-0000000000ff', new Date().toISOString(), { agent: 'mark' })]);
      await fetch(`${base}/act/approvals`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'x-loom-fetch': '1', authorization: `Bearer ${tok.jonathan}` },
        body: new URLSearchParams({ _action: 'noop', id: 'a-00000199' }) });
      await new Promise((r) => setTimeout(r, 4_000));
      expect(reads.length - before, 'reads after another agent\'s ask').toBe(0);
      // Art's own, answered in the Inbox: read again, and the card says so.
      const r = await fetch(`${base}/act/approvals`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'x-loom-fetch': '1', authorization: `Bearer ${tok.jonathan}` },
        body: new URLSearchParams({ _action: 'deny', id: 'a-00000110' }) });
      expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
      await expect.poll(() => page.locator('.comms-ask .v-agent-chat__receipt').textContent({ timeout: 500 }).catch(() => ''), { timeout: 20_000 }).toMatch(/^Denied by you · /);
      expect(reads.length - before).toBeGreaterThanOrEqual(1);
      expect(errors).toEqual([]);
    } finally { await ctx.close(); }
  }, 120_000);

  it('a member who may not give it (not the household\'s owner) sees the card with no buttons', async () => {
    const t = thread(h.members[1], 'It needs a piece: see above.');
    asks([{ ...permission('a-00000103', t.conversation, new Date(Date.now() - 500).toISOString()), text: 'Give Art E Fish the relay piece?', lead: true }]);
    const { ctx, page, errors } = await open('sam', DESK);
    try {
      await page.goto(`${base}/comms/${t.id}`);
      const card = page.locator('.comms-ask');
      await card.waitFor();
      expect(await card.locator('h3').textContent()).toBe('Give Art E Fish the relay piece?');
      expect(await card.getByRole('button', { name: /allow|deny/i }).count()).toBe(0);
      expect(await card.textContent()).toContain('Only the household’s owner can allow this one');
      expect(errors).toEqual([]);
    } finally { await ctx.close(); }
  }, 120_000);

  it('refs become chips that open a small card; one the reader can\'t open stays its words', async () => {
    const t = thread();
    asks([permission('a-00000101', t.conversation, new Date(Date.now() - 500).toISOString())]);
    const { ctx, page, errors } = await open('jonathan', DESK);
    try {
      await page.goto(`${base}/comms/${t.id}`);
      const reply = page.locator('.comms-reply').last();
      // @mark: an agent the reader owns, a chip; t-12: no tasks piece here, so its words (no link, no chip).
      const mark = reply.locator('[data-ref="at:mark"][data-chip]');
      await mark.waitFor({ timeout: 10_000 });
      // Known by the time @mark is a chip (one read answers them all): t-12 stays its words.
      expect(await reply.locator('[data-ref="t-12"][data-chip]').count()).toBe(0);
      expect(await reply.locator('[data-ref="t-12"]').getAttribute('role')).toBeNull();
      expect(await reply.textContent()).toContain('Tracked in t-12;');
      expect(await reply.locator('a[href*="t-12"]').count()).toBe(0);
      await reply.locator('[data-ref="a-00000101"][data-chip]').waitFor();
      await reply.locator('[data-ref="github:acme/app#3"][data-chip]').waitFor();
      await mark.click();
      const card = page.locator('.comms-refcard');
      await card.waitFor();
      expect(await card.locator('.loom-kit-meta').textContent()).toBe('Agent');
      expect(await card.locator('.loom-kit-title').textContent()).toBe('Mark');
      expect(await card.locator('.comms-refcard__open').getAttribute('href')).toBe('/a/mark');
      await page.keyboard.press('Escape');
      await expect.poll(() => card.count()).toBe(0);
      expect(errors).toEqual([]);
    } finally { await ctx.close(); }
    // Sam owns art, not mark: in his own thread, @mark is words.
    const s = thread(h.members[1], 'Asked @mark about it.');
    const o = await open('sam', DESK);
    try {
      const read = o.page.waitForResponse((r) => r.url().includes('/refs?') && r.url().includes('at%3Amark'), { timeout: 30_000 });
      await o.page.goto(`${base}/comms/${s.id}`);
      const reply = o.page.locator('.comms-reply').last();
      await reply.waitFor();
      expect(((await (await read).json()) as { refs: Record<string, unknown> }).refs['at:mark']).toBeNull();
      await o.page.waitForTimeout(300);
      expect(await reply.locator('[data-ref="at:mark"][data-chip]').count()).toBe(0);
      expect(await reply.textContent()).toContain('Asked @mark about it.');
      expect(o.errors).toEqual([]);
    } finally { await o.ctx.close(); }
  }, 120_000);

  it('reads at 1440 and a phone\'s width, in each look, with no sideways scroll', async () => {
    const t = thread();
    const done = thread();
    asks([permission('a-00000111', t.conversation, new Date(Date.now() - 500).toISOString())]);
    // One answered before, so the thread shows both: the open card and an answered one.
    asks([permission('a-00000111', t.conversation, new Date(Date.now() - 500).toISOString()), permission('a-00000112', done.conversation, new Date(Date.now() - 500).toISOString())]);
    await fetch(`${base}/act/approvals`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'x-loom-fetch': '1', authorization: `Bearer ${tok.jonathan}` },
      body: new URLSearchParams({ _action: 'allow', id: 'a-00000112' }) });
    if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    for (const look of ['neon', 'lowlight', 'daylight']) {
      for (const [name, size] of [['1440', DESK], ['phone', PHONE]] as const) {
        for (const which of [t, done]) {
          const { ctx, page, errors } = await open('jonathan', size, look);
          try {
            await page.goto(`${base}/comms/${which.id}`);
            await page.locator('.comms-ask').waitFor();
            await page.locator('.comms-reply [data-chip]').first().waitFor({ timeout: 10_000 });
            if (which === t) await expect.poll(() => page.getByRole('button', { name: 'Allow once' }).isEnabled(), { timeout: 10_000 }).toBe(true);
            await page.locator('.comms-ask').scrollIntoViewIfNeeded();
            expect(await noSideways(page), `${look} ${name}`).toBe(true);
            if (SHOTS) await page.screenshot({ path: join(SHOTS, `comms-inline-${look}-${name}-${which === t ? 'open' : 'answered'}.png`) });
            expect(errors).toEqual([]);
          } finally { await ctx.close(); }
        }
      }
    }
  }, 300_000);
});
