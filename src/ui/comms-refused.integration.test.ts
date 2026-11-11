/**
 * A thread whose read loom refuses (comms.md §7, t-1937), in a real browser: with comms.key gone, a read is a `503`,
 * and the open thread says so in words, keeps the messages it already shows, marked as possibly out of date, and offers
 * Try again, which clears it once the key is back. Before t-1937 the refusal was invisible: the old view stayed as if
 * nothing had happened.
 *
 * Runs where the app is built (npm run build), a Chrome is installed and age is (the thread's words are encrypted).
 */
import { describe, it, expect as vexpect, beforeAll, afterAll, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { chromium, type Browser } from 'playwright-core';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { createToken, loadHousehold, type Household } from '../household.js';
import { createConversationTables } from '../backends/conversations.js';
import { closeAllBackends } from '../backends/index.js';
import { adapterCall, COMMS_KEY, openThread, recordDelivery } from '../comms.js';
import { stopCommsWatch } from './comms-live.js';

const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);
const hasAge = spawnSync('sh', ['-c', 'command -v age && command -v age-keygen'], { encoding: 'utf-8' }).status === 0;
const expect = Object.assign(((v: unknown, m?: string) => vexpect(v, m)) as typeof vexpect, vexpect,
  { poll: (f: () => unknown, o?: { timeout?: number }) => vexpect.poll(f, { timeout: 10_000, ...o }) }) as typeof vexpect;

describe.runIf(built && chrome && hasAge)('Comms: a thread read loom refuses', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-comms-refused-'));
    mkdirSync(join(home, 'agents', 'art'), { recursive: true });
    writeFileSync(join(home, 'agents', 'art', 'IDENTITY.md'), '# Art E Fish\n\nCreed.\n');
    const db = new BetterSqlite3(join(home, 'agents', 'art', 'memories.db')); createConversationTables(db); db.close();
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], default: 'art', owner: 'jonathan', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
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

  it('says it can\'t open the thread, keeps what it shows as possibly out of date, and Try again clears it once a read works', async () => {
    const o = openThread(h, process.env, h.members[0], { agent: 'art', id: 'zzaaaaaaaaaaaaab', text: 'Hello there.' });
    recordDelivery(h, o.thread, o.seq, { delivered: true, body: 'started' });
    adapterCall(h, process.env, { op: 'post', place: o.thread.id, agent: 'art', text: 'A reply you can read.' });
    adapterCall(h, process.env, { op: 'status', place: o.thread.id, agent: 'art', status: 'done' });

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await ctx.addInitScript(`localStorage.setItem('loom-look', 'neon'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    await p.goto(`${base}/comms/${o.thread.id.replace(/^th:/, '')}?t=*comms`);
    await p.locator('.loom-tile').getByText('A reply you can read.').waitFor();
    expect(await p.locator('[role="alert"]').count()).toBe(0);

    // The key goes: every read of the thread is now a 503 (comms.key is missing).
    const key = join(h.home, COMMS_KEY);
    renameSync(key, `${key}.away`);
    try {
      const refused = await p.request.get(`${base}/comms/${o.thread.id}/since/0`, { headers: { accept: 'application/json' } });
      expect(refused.status()).toBe(503);
      // The pane reads again (as it does every 30 s and when the page comes back into view).
      await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      const banner = p.locator('[role="alert"]');
      await banner.waitFor();
      expect(await banner.innerText()).toContain('Can\'t open this conversation right now: loom couldn\'t decrypt it.');
      expect(await banner.innerText()).toContain('What\'s shown here may be out of date.');
      // What it already showed is still there.
      expect(await p.locator('.loom-tile').getByText('A reply you can read.').isVisible()).toBe(true);
      expect(await p.locator('.loom-tile').getByText('Hello there.').isVisible()).toBe(true);
      // Try again while it's still refused: still says so.
      await banner.getByRole('button', { name: 'Try again' }).click();
      await p.waitForTimeout(500);
      expect(await banner.isVisible()).toBe(true);
    } finally { renameSync(`${key}.away`, key); }

    // The key is back: Try again reads, and the error goes. (The thread may read again by itself first, when loom's live
    // stream says something moved: then there's no Try again left to press.)
    await p.locator('[role="alert"]').getByRole('button', { name: 'Try again' }).click({ timeout: 5000 }).catch(() => undefined);
    await expect.poll(() => p.locator('[role="alert"]').count()).toBe(0);
    expect(await p.locator('.loom-tile').getByText('A reply you can read.').isVisible()).toBe(true);
    await ctx.close();
  });
});
