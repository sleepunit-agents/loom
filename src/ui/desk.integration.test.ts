/**
 * Neon on a big screen (Jonathan, 2026-11-05, the desktop OS prototype's Level 1, "Shell"): in a real browser at
 * 1280x800 and 1920x1080, over a household with two agents and things waiting. Home is a desktop: widgets on the
 * ground, no scrolling page and no page header past the bars; what needs you is answered where it stands; the dock sits
 * at the bottom centre with no rail beside it; nothing scrolls sideways. 000h at the same width keeps its rail and its
 * page, and a screen under 1024 px keeps a phone's layout.
 *
 * Runs where the app is built (npm run build) and a Chrome is installed (GitHub's runners have one).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

const SIZES = [[1280, 800], [1920, 1080]] as const;

describe.runIf(built && chrome)('Neon on a big screen: the desktop', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  const saved = process.env.LOOM_HOME;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-desk-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), a === 'art' ? '# Art E Fish\n' : '# Visual Mark\n');
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db')); createConversationTables(db); db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
    process.env.LOOM_HOME = home;
    h = loadHousehold(home)!;
    token = createToken(h, { role: { kind: 'owner' }, label: 'jonathan' }).token;
    const art = agentDir(h, 'art');
    const ask = (place: string, label: string, needs: object) => {
      const conv = recordTurn(art, 'art', { venue: 'wake', place, label, at: new Date().toISOString(), from: { kind: 'schedule' }, kind: 'wake' }, 'runtime:clock').conversation;
      writeDigest(art, { conversation: conv, run: 'r1' }, { summary: 'Checked.', needs_owner: needs } as never);
    };
    ask('lane:making', 't-738: sonarr', { ask: 'OK to turn off the recycle bin on Sonarr for a quick rename?', why: 'Deleting a big show takes hours.', if_yes: 'I turn it off.', if_no: 'I plan a rework.', refs: ['t-738'] });
    ask('lane:field', 't-801: install', { ask: 'Gabe or Mark for the field box install on Friday?', why: 'Gabe knows the site.', answers: 'words', refs: ['t-801'] });
    handle = await startHttpServer({ contextDir: art, host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await handle?.close();
    await closeAllBackends();
    if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved;
    if (h) rmSync(h.home, { recursive: true, force: true });
  });

  /** A screen in a look, signed in, its arrival already had unless `boot`. */
  async function screen(look: 'neon' | '000h', width: number, height: number, o: { motion?: 'reduce' | 'no-preference'; boot?: boolean } = {}): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: o.motion ?? 'reduce', serviceWorkers: 'block' });
    await ctx.addInitScript(([l, boot]) => { localStorage.setItem('loom-look', l as string); if (!boot) sessionStorage.setItem('loom-arrived', '1'); }, [look, !!o.boot] as const);
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    await p.goto(`${base}/appearance`);
    await p.locator('.loom-top h1').waitFor();
    const csrf = await p.evaluate(async () => ((await (await fetch('/appearance', { headers: { accept: 'application/json' } })).json()) as { chrome: { csrf: string } }).chrome.csrf);
    await p.evaluate(async ([c, l]) => { await fetch('/appearance/prefs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ _csrf: c, look: l }) }); }, [csrf, look]);
    return p;
  }
  const home = async (p: Page) => { await p.goto(`${base}/`); await p.locator('.loom-desk-home').waitFor(); await p.waitForTimeout(300); };

  for (const [w, ht] of SIZES) {
    it(`${w}x${ht}: Home is the desktop: widgets, no page header, no page scroll, the dock centred and no rail`, async () => {
      const p = await screen('neon', w, ht);
      const errors: string[] = [];
      p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      await home(p);
      // The widgets: what needs you, a card per agent with its face, nothing else pretending.
      expect(await p.locator('.loom-w--needs').count()).toBe(1);
      expect(await p.locator('.loom-w--agent').count()).toBe(2);
      expect(await p.locator('.loom-agent__name').allInnerTexts()).toEqual(['Art E Fish', 'Visual Mark']);
      for (const card of await p.locator('.loom-w--agent').all()) {
        expect(await card.locator('.loom-agent__face [aria-label]').count()).toBeGreaterThan(0);   // its face (blocks.tsx AgentAvatar: the pixel face where it has one)
        expect((await card.locator('.loom-agent__line').innerText()).trim().length).toBeGreaterThan(0);   // and how it is
      }
      expect(errors).toEqual([]);
      // The bars are the only header: no big title, no app tile, no rail.
      expect(await p.locator('.loom-top h1').count()).toBe(1);
      expect(await p.locator('.loom-top .loom-app-tile').count()).toBe(0);
      expect(await p.locator('.loom-side').count()).toBe(0);
      // One screen: not a page that scrolls, either way.
      const m = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, iw: innerWidth, ih: innerHeight }));
      expect(m.sw).toBeLessThanOrEqual(m.iw);
      expect(m.sh).toBeLessThanOrEqual(m.ih);
      // Every widget column is on the screen, above the dock (a column with more than fits scrolls inside itself).
      const keys = await p.locator('.loom-dock-bar [data-part="item"]').evaluateAll((bs) => bs.map((b) => b.getBoundingClientRect()).map((r) => ({ l: r.left, r: r.right, t: r.top })));
      for (const box of await p.locator('.loom-desk-col').evaluateAll((ws) => ws.map((x) => x.getBoundingClientRect()).map((r) => ({ l: r.left, r: r.right, b: r.bottom })))) {
        expect(box.l).toBeGreaterThanOrEqual(0); expect(box.r).toBeLessThanOrEqual(w);
        expect(box.b).toBeLessThanOrEqual(Math.min(...keys.map((k) => k.t)));
      }
      // The dock: at the bottom, its keys centred on the screen (within a key's rounding).
      const left = Math.min(...keys.map((k) => k.l)), right = Math.max(...keys.map((k) => k.r));
      expect(Math.abs((left + right) / 2 - w / 2)).toBeLessThanOrEqual(2);
      expect(Math.max(...keys.map((k) => k.t))).toBeGreaterThan(ht - 90);
      await p.context().close();
    }, 90_000);
  }

  it('what needs you is answered where it stands: Yes posts the ask\'s answer; Done answers it and it leaves the desktop', async () => {
    const p = await screen('neon', 1280, 800);
    await home(p);
    const sonarr = p.locator('.loom-need', { hasText: 'recycle bin on Sonarr' });
    // Yes posts the answer, as the Inbox's sheet does (delivering it to the agent is the runtime's, which this
    // household hasn't got: the post itself is what's checked here; needs-answer.test.ts has the rest).
    const posted: string[] = [];
    await p.route('**/act/**', async (r) => { posted.push(r.request().postData() ?? ''); await r.fulfill({ json: { ok: true, message: 'Sent. Art E Fish has it.' } }); });
    await sonarr.getByRole('button', { name: 'Yes' }).click();
    await expect.poll(() => posted.length).toBe(1);
    const f = new URLSearchParams(posted[0]);
    expect(f.get('_action')).toBe('needs-answer');
    expect(f.get('answer')).toBe('yes');
    expect(f.get('conversation')).toMatch(/^cv-/);
    expect(f.get('digest')).toMatch(/^dg-/);
    await p.unroute('**/act/**');
    // An ask with its own buttons under it is read whole, never cut (what a button does is read beside it).
    expect(await p.locator('.loom-need', { hasText: 'Gabe or Mark' }).locator('.loom-need__title').evaluate((e) => getComputedStyle(e).webkitLineClamp)).toBe('none');
    // An ask answered in words has no Yes or No: its sheet has the box. Its own Done answers it, right here.
    const words = p.locator('.loom-need', { hasText: 'Gabe or Mark' });
    expect(await words.getByRole('button', { name: 'Yes' }).count()).toBe(0);
    expect(await words.getByRole('button', { name: /Reply/ }).count()).toBe(1);
    await words.getByRole('button', { name: 'Done' }).click();
    await expect.poll(() => p.locator('.loom-need', { hasText: 'Gabe or Mark' }).count(), { timeout: 10_000 }).toBe(0);
    // Still the desktop, and the Inbox agrees.
    expect(new URL(p.url()).pathname).toBe('/');
    const inbox = await p.evaluate(async () => ((await (await fetch('/inbox', { headers: { accept: 'application/json' } })).json()) as { items: { text: string; attention: boolean }[] }).items);
    expect(inbox.find((i) => /Gabe or Mark/.test(i.text))?.attention ?? false).toBe(false);
    await p.context().close();
  }, 90_000);

  it('the desktop is its own chunk: a wide Neon screen fetches it, a phone never does', async () => {
    for (const [w, want] of [[1280, true], [390, false]] as const) {
      const p = await screen('neon', w, 800);
      const got: string[] = [];
      p.on('request', (r) => { if (/\/assets\/desk-[^/]*\.(js|css)$/.test(r.url())) got.push(r.url()); });
      await p.goto(`${base}/`); await p.locator('.loom-top h1').waitFor(); await p.waitForTimeout(800);
      expect(got.length > 0, `${w}`).toBe(want);
      await p.context().close();
    }
  }, 60_000);

  it('000h at the same width keeps its rail and its page; under 1024 px Neon keeps a phone\'s dock and no desktop', async () => {
    const o = await screen('000h', 1280, 800);
    await o.goto(`${base}/`); await o.locator('.loom-top h1').waitFor(); await o.waitForTimeout(300);
    expect(await o.locator('.loom-desk, .loom-desk-home, .loom-w').count()).toBe(0);
    expect(await o.locator('.loom-dock-bar').count()).toBe(0);
    expect(await o.locator('.loom-side').count()).toBe(1);
    await o.context().close();
    const n = await screen('neon', 1000, 800);
    await n.goto(`${base}/`); await n.locator('.loom-top h1').waitFor(); await n.waitForTimeout(300);
    expect(await n.locator('.loom-desk, .loom-desk-home').count()).toBe(0);
    expect(await n.locator('.loom-dock-bar').count()).toBe(1);
    await n.context().close();
  }, 90_000);
});
