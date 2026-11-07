/**
 * Needs you is the Inbox shrunk (Jonathan, 2026-11-07; docs/specs/desk-tiling.md, "Needs you and the Inbox"): one app
 * at two sizes, as an agent's card and its window are (t-1925 D, tiling/morph.ts). Its Expand grows it into the Inbox's
 * tile on the Needs you folder; it stands aside while an Inbox tile is open and the rest of the widgets fill its room;
 * the Inbox's Shrink to widget folds it back; an ask in it opens in the Inbox with that ask picked. Reduced motion: no
 * outline, the change is instant. Real Chrome.
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
const KEY = (label: string) => `.loom-dock-bar [data-part="item"][aria-label="${label}"]`;
const ASKS = ['OK to turn off the recycle bin on Sonarr for a quick rename?', 'OK to restart the Plex box tonight?'];

describe.runIf(built && chrome)('Needs you and the Inbox: one app at two sizes', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-desk-needs-inbox-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db')); createConversationTables(db); db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', owner: 'jonathan', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
    for (const k of ['LOOM_HOME', 'XDG_CONFIG_HOME']) saved[k] = process.env[k];
    process.env.LOOM_HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    h = loadHousehold(home)!;
    token = createToken(h, { role: { kind: 'owner', member: 'jonathan' }, label: 'jonathan' }).token;
    const art = agentDir(h, 'art');
    ASKS.forEach((ask, n) => {
      const conv = recordTurn(art, 'art', { venue: 'wake', place: `lane:making-${n}`, label: `ask ${n}`, at: new Date().toISOString(), from: { kind: 'schedule' }, kind: 'wake' }, 'runtime:clock').conversation;
      writeDigest(art, { conversation: conv, run: `r${n}` }, { summary: 'Checked.', needs_owner: { ask, why: 'Because it matters.', if_yes: 'I do it.', if_no: 'I leave it.' } } as never);
    });
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

  async function screen(width: number, height: number, path: string, motion: 'reduce' | 'no-preference' = 'reduce'): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: motion, serviceWorkers: 'block', ...(width < 600 ? { hasTouch: true, isMobile: true } : {}) });
    await ctx.addInitScript(`localStorage.setItem('loom-look', 'neon'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    (p as Page & { errors: string[] }).errors = errors;
    await p.goto(`${base}${path}`);
    await p.waitForTimeout(300);
    return p;
  }
  const labels = (p: Page) => p.$$eval('.loom-tile', (ts) => ts.map((t) => (t.getAttribute('aria-label') ?? '').replace(/^tile \d+ of \d+, /, '')));
  const widgets = (p: Page) => p.$$eval('[data-widget]', (ws) => ws.map((w) => w.getAttribute('data-widget')));
  const inbox = (p: Page) => p.locator('.loom-tile[data-tile="/inbox"]');
  const tripWatch = (p: Page) => p.evaluate(() => { const w = window as unknown as { trip: boolean }; w.trip = false;
    new MutationObserver((ms) => { if (ms.some((m) => [...m.addedNodes].some((n) => (n as Element).classList?.contains('loom-morph')))) w.trip = true; }).observe(document.body, { childList: true }); });
  const tripped = (p: Page) => p.evaluate(() => (window as unknown as { trip: boolean }).trip);

  for (const motion of ['no-preference', 'reduce'] as const) {
    it(`Expand grows Needs you into the Inbox on its Needs you folder; it stands aside; Shrink to widget folds it back (motion: ${motion})`, async () => {
      const p = await screen(1920, 1080, '/?w=needs,art,mark', motion);
      await p.locator('[data-widget="needs"] .loom-need').first().waitFor();
      await tripWatch(p);
      await p.locator('[data-widget="needs"] button[aria-label="Expand Needs you into the Inbox"]').click();
      await inbox(p).locator('.loom-inbox').waitFor();
      if (motion === 'no-preference') await expect.poll(() => tripped(p), { timeout: 4000 }).toBe(true);
      else { await p.waitForTimeout(800); expect(await tripped(p)).toBe(false); }
      expect(await labels(p)).toEqual(['Inbox']);
      // On its Needs you folder, in the address too.
      expect(new URL(p.url()).searchParams.get('f')).toBe('needs');
      await expect.poll(() => inbox(p).locator('.loom-split__list').textContent()).toContain(ASKS[0]);
      // Needs you stands aside while the Inbox is open; the agents' cards stay; `w` is kept as it was.
      await expect.poll(() => widgets(p)).toEqual(['art', 'mark']);
      expect(new URL(p.url()).searchParams.get('w')).toBe('needs,art,mark');
      // The Inbox's strip: Shrink to widget folds it back, where it was.
      await inbox(p).locator('button[aria-label="Shrink Inbox to Needs you"]').click();
      await expect.poll(() => p.locator('.loom-tile').count()).toBe(0);
      await expect.poll(() => widgets(p)).toEqual(['needs', 'art', 'mark']);
      expect(new URL(p.url()).searchParams.get('w')).toBe('needs,art,mark');
      await p.waitForTimeout(400);
      expect(await p.locator('.loom-morph').count()).toBe(0);
      expect((p as Page & { errors: string[] }).errors).toEqual([]);
      await p.context().close();
    });
  }

  it('an Inbox opened any way hides Needs you, and the rail fills its room; closed or sent to the dock, it comes back', async () => {
    const p = await screen(1920, 1080, '/comms?t=*comms&w=needs,art,mark');
    await expect.poll(() => widgets(p)).toEqual(['needs', 'art', 'mark']);
    const room = () => p.$$eval('.loom-wrail [data-widget]', (ws) => ws.map((w) => [w.getAttribute('data-widget'), Math.round(w.getBoundingClientRect().y)] as const));
    const before = await room();
    await p.click(KEY('Inbox'));
    await expect.poll(() => labels(p)).toContain('Inbox');
    await expect.poll(() => widgets(p)).toEqual(['art', 'mark']);
    // The rail has no gap where Needs you was: the first card now starts where Needs you did.
    await expect.poll(async () => (await room())[0][1]).toBe(before[0][1]);
    // Minimized to the dock: Needs you is back.
    await inbox(p).locator('button[aria-label="Minimize Inbox to the dock"]').click();
    await expect.poll(() => widgets(p)).toEqual(['needs', 'art', 'mark']);
    await p.click(KEY('Inbox'));
    await expect.poll(() => widgets(p)).toEqual(['art', 'mark']);
    // Closed: back.
    await inbox(p).locator('button[aria-label="Close Inbox"]').click();
    await expect.poll(() => widgets(p)).toEqual(['needs', 'art', 'mark']);
    await p.context().close();
  });

  it('an ask in Needs you opens in the Inbox with that ask picked', async () => {
    const p = await screen(1920, 1080, '/?w=needs,art');
    const need = p.locator('[data-widget="needs"] .loom-need', { hasText: ASKS[1] });
    await need.waitFor();
    await need.locator('.loom-need__title').click();
    await inbox(p).locator('.loom-split__reader').waitFor();
    await expect.poll(() => inbox(p).locator('.loom-split__reader h2').textContent()).toContain(ASKS[1]);
    const u = new URL(p.url());
    expect([u.pathname, u.searchParams.get('f'), !!u.searchParams.get('i')]).toEqual(['/inbox', 'needs', true]);
    await expect.poll(() => widgets(p)).toEqual(['art']);
    await p.context().close();
  });

  it('the widget\'s menu says Expand; the Inbox\'s strip menu says Shrink to widget', async () => {
    const p = await screen(1920, 1080, '/?w=needs,art');
    await p.locator('[data-widget="needs"] .loom-w__head h2').click({ button: 'right' });
    await p.locator('.loom-cmenu').locator('[role="menuitem"]', { hasText: 'Expand' }).click();
    await inbox(p).waitFor();
    await expect.poll(() => widgets(p)).toEqual(['art']);
    await inbox(p).locator('.loom-tile__bar h2').click({ button: 'right' });
    await p.locator('.loom-cmenu').locator('[role="menuitem"]', { hasText: 'Shrink to widget' }).click();
    await expect.poll(() => widgets(p)).toEqual(['needs', 'art']);
    await p.context().close();
  });

  it('Shrink to widget with no Needs you on the desktop puts it there', async () => {
    const p = await screen(1280, 800, '/inbox?t=*inbox&w=art');
    await inbox(p).locator('button[aria-label="Shrink Inbox to Needs you"]').click();
    await expect.poll(async () => (await widgets(p)).sort()).toEqual(['art', 'needs']);
    expect(new URL(p.url()).searchParams.get('w')).toBe('art,needs');
    await p.context().close();
  });

  it('a phone has no desktop: its Inbox is a page, with no Shrink to widget', async () => {
    const p = await screen(390, 844, '/inbox');
    await p.locator('.loom-inbox').waitFor();
    expect(await p.locator('.loom-tiles, [data-widget], button[aria-label^="Shrink"]').count()).toBe(0);
    await p.context().close();
  });
});
