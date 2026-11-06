/**
 * A piece's own fit reaches the tiled desktop (docs/specs/desk-tiling.md, criterion 21, the desk half): a piece whose
 * manifest says `tab.fit: { big: true, ideal: 1300 }` takes the big slot when opened beside the Inbox, at its ideal's
 * share; a piece with no fit (Shed) has the default row and goes last. Real Chrome.
 */
import { describe, it, expect as vexpect, beforeAll, afterAll, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { createToken, loadHousehold, type Household } from '../household.js';
import { createConversationTables } from '../backends/conversations.js';
import { closeAllBackends } from '../backends/index.js';

const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);
const expect = Object.assign(((v: unknown, m?: string) => vexpect(v, m)) as typeof vexpect, vexpect,
  { poll: (f: () => unknown, o?: { timeout?: number }) => vexpect.poll(f, { timeout: 10_000, ...o }) }) as typeof vexpect;

describe.runIf(built && chrome)('desk tiling: a piece\'s own fit', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  let bin: string;
  const saved: Record<string, string | undefined> = {};
  const piece = (name: string, label: string, fit?: object) => {
    writeFileSync(join(bin, `${name}.json`), JSON.stringify({ v: 2, tab: { label, ...(fit ? { fit } : {}) } }));
    writeFileSync(join(bin, `loom-${name}`), `#!/bin/sh\ncase "$1 $2" in "ui --json") cat "${join(bin, `${name}.json`)}" ;; *) echo '{"title":"${label}","sections":[]}' ;; esac\n`);
    chmodSync(join(bin, `loom-${name}`), 0o755);
  };

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-desk-fit-'));
    for (const a of ['art']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db')); createConversationTables(db); db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], default: 'art', owner: 'jonathan', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
    for (const k of ['LOOM_HOME', 'XDG_CONFIG_HOME', 'PATH']) saved[k] = process.env[k];
    process.env.LOOM_HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    bin = join(home, 'bin');
    mkdirSync(bin);
    piece('garden', 'Garden', { big: true, ideal: 1300, min: [600, 400] });
    piece('shed', 'Shed');
    process.env.PATH = `${bin}:${saved.PATH}`;
    h = loadHousehold(home)!;
    token = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: 'jonathan' }).token;
    handle = await startHttpServer({ contextDir: join(home, 'agents', 'art'), host: '127.0.0.1', port: 0, household: h });
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

  async function inboxThen(label: string): Promise<{ order: string[]; widths: Record<string, number> }> {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await ctx.addInitScript(`localStorage.setItem('loom-look', 'neon'); localStorage.setItem('loom-tiling', 'on'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p: Page = await ctx.newPage();
    await p.goto(`${base}/inbox?t=*inbox&w=`);
    await p.locator('.loom-tile').first().waitFor();
    await p.click(`.loom-dock-bar [data-part="item"][aria-label="${label}"]`);
    await expect.poll(() => p.locator('.loom-tile').count()).toBe(2);
    const r = await p.$$eval('.loom-tile', (ts) => ts.map((t) => [t.getAttribute('data-tile')!, t.getBoundingClientRect().width] as const));
    await ctx.close();
    return { order: r.map((x) => x[0]), widths: Object.fromEntries(r) };
  }

  it('21. a manifest\'s tab.fit is the layout\'s: big takes the left, its ideal sets the share; without it, the default row', async () => {
    const own = await inboxThen('Garden');
    expect(own.order).toEqual(['/p/garden', '/inbox']);
    // round((1872 - 10) × 1300 / (1300 + 760)) = 1175, as the rule splits it (Inbox has no say past its 980 max here)
    expect(Math.round(own.widths['/p/garden'])).toBe(1175);
    const none = await inboxThen('Shed');
    expect(none.order).toEqual(['/inbox', '/p/shed']);
  }, 60_000);
});
