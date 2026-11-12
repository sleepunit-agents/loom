/**
 * An ask's buttons only once loom says, now, that it's still open (web/src/ask-open.ts; the Inbox's rule, t-1925), on
 * the desktop's Needs you: a copy of the desktop kept on this device (page.ts, the service worker) may show an ask
 * answered since. Answered (loom says it isn't open), or loom unreachable: no Yes, no No, and nothing sent; open: its
 * Yes and No, and it's asked again right before one is sent. Real Chrome. (Comms' thread asks: comms-app's own tests.)
 *
 * Runs where the app is built (npm run build) and a Chrome is installed (GitHub's runners have one).
 */
import { describe, it, expect as vexpect, beforeAll, afterAll, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from '../household.js';
import { createConversationTables, recordTurn, writeDigest } from '../backends/conversations.js';
import { closeAllBackends } from '../backends/index.js';

const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);
const expect = Object.assign(((v: unknown, m?: string) => vexpect(v, m)) as typeof vexpect, vexpect,
  { poll: (f: () => unknown, o?: { timeout?: number }) => vexpect.poll(f, { timeout: 10_000, ...o }) }) as typeof vexpect;

describe.runIf(built && chrome)('Needs you answers only an ask loom says is open', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-ask-open-'));
    for (const a of ['art']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), '# Art E Fish\n');
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db')); createConversationTables(db); db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], default: 'art', owner: 'jonathan', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
    for (const k of ['LOOM_HOME', 'XDG_CONFIG_HOME']) saved[k] = process.env[k];
    process.env.LOOM_HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    h = loadHousehold(home)!;
    token = createToken(h, { role: { kind: 'owner' }, label: 'jonathan' }).token;
    // A yes/no ask of Art's, waiting on its owner.
    const art = agentDir(h, 'art');
    const conv = recordTurn(art, 'art', { venue: 'wake', place: 'lane:making', label: 'sonarr', at: new Date().toISOString(), from: { kind: 'schedule' }, kind: 'wake' }, 'runtime:clock').conversation;
    writeDigest(art, { conversation: conv, run: 'r1' }, { summary: 'Checked.', needs_owner: { ask: 'OK to turn off the recycle bin on Sonarr?',
      why: 'It filled the disk.', if_yes: 'I turn it off.', if_no: 'I leave it.', answers: 'yes-no' } } as never);
    handle = await startHttpServer({ contextDir: art, host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await handle?.close();
    await closeAllBackends();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (h) rmSync(h.home, { recursive: true, force: true });
  });

  async function desk(open: 'yes' | 'no' | 'offline' | 'cached'): Promise<{ p: Page; asked: string[]; posted: () => number }> {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await ctx.addInitScript(`localStorage.setItem('loom-look', 'neon'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    const asked: string[] = [];
    await p.route('**/inbox/open?*', (r) => { asked.push(new URL(r.request().url()).searchParams.get('k')!); return open === 'offline' ? r.abort('internetdisconnected')
      : open === 'cached' ? r.fulfill({ json: { open: true }, headers: { 'x-loom-saved-at': String(Date.now() - 3_600_000) } }) : r.fulfill({ json: { open: open === 'yes' } }); });
    // The live attention set (web/src/attention.ts) would say it's open without asking: these cases are about loom's
    // own answer, so the set never goes live here (its ask fails, and the cards ask loom as before).
    if (open !== 'yes') await p.route('**/collections/query', (r) => r.abort('internetdisconnected'));
    let n = 0;
    await p.route('**/act/**', (r) => { n++; return r.fulfill({ json: { ok: true, message: 'Answered.' } }); });
    await p.goto(`${base}/`);
    await p.locator('.loom-needs-band .loom-nchip').waitFor();
    return { p, asked, posted: () => n };
  }
  const need = (p: Page) => p.locator('.loom-needs-band .loom-nchip').first();

  for (const how of ['no', 'offline', 'cached'] as const) {
    it(`${how === 'no' ? 'answered since (loom says it isn\'t open)' : how === 'offline' ? 'loom can\'t be reached' : 'the answer is this device\'s copy (x-loom-saved-at)'}: no Yes, no No, nothing sent`, async () => {
      const { p, asked, posted } = await desk(how);
      await expect.poll(() => need(p).locator('[data-live]').getAttribute('data-live')).toBe(how === 'no' ? 'gone' : 'unknown');
      expect(asked.length).toBeGreaterThan(0);
      expect(await need(p).getByRole('button', { name: /^(Yes|No|Allow|Deny)/ }).count()).toBe(0);
      expect(posted()).toBe(0);
      await p.context().close();
    });
  }

  it('open now (the live set, or loom, says so): its Yes and No, and loom is asked again right before Yes is sent', async () => {
    const { p, asked, posted } = await desk('yes');
    const yes = need(p).getByRole('button', { name: 'Yes', exact: true });
    await yes.waitFor();
    const before = asked.length;
    await yes.click();
    await expect.poll(() => posted()).toBe(1);
    expect(asked.length).toBeGreaterThan(before);
    await p.context().close();
  });
});
