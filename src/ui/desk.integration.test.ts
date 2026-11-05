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

  for (const [w, ht] of SIZES) {
    it(`${w}x${ht}: an app opens in the window from its dock key; Esc and Close go back to the desktop, focus following`, async () => {
      const p = await screen('neon', w, ht, { motion: 'no-preference' });
      await home(p);
      // Every desk move the page makes, as it makes it (desk.tsx deskGo marks <html> while one runs).
      await p.evaluate(() => { const w = window as unknown as { moves: string[] }; w.moves = [];
        new MutationObserver(() => { const m = document.documentElement.dataset.deskMove; if (m) w.moves.push(m); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-desk-move'] }); });
      const moves = () => p.evaluate(() => (window as unknown as { moves: string[] }).moves);
      // The window grows out of the Inbox's own key: that key carries the window's transition name as it starts.
      const named = p.locator('.loom-dock-bar [data-part="item"][aria-label="Inbox"]').evaluate((k) => new Promise<string>((res) => {
        const o = new MutationObserver(() => { if ((k as HTMLElement).style.viewTransitionName) { o.disconnect(); res((k as HTMLElement).style.viewTransitionName); } });
        o.observe(k, { attributes: true, attributeFilter: ['style'] }); setTimeout(() => res(''), 3000); }));
      await p.locator('.loom-dock-bar [data-part="item"][aria-label="Inbox"]').click();
      expect(await named).toBe('loom-win');
      await expect.poll(moves).toEqual(['open']);
      const win = p.locator('.loom-window');
      await win.waitFor();
      await p.locator('.loom-window main [data-slot="card"], .loom-window main [role="group"]').first().waitFor();
      expect(new URL(p.url()).pathname).toBe('/inbox');
      // The window: its title strip says which app, in the app's colour; the page reads at a page's width.
      expect(await p.locator('#loom-window-title').innerText()).toMatch(/inbox/i);
      await expect.poll(() => p.evaluate(() => document.activeElement?.id)).toBe('loom-window-title');
      // A chassis: cut corners, and the title strip's key in the app's own colour (the Inbox's dock key's).
      const look = await p.evaluate(() => {
        const w = document.querySelector('.loom-window')!, k = document.querySelector('.loom-window__key')!;
        const dock = document.querySelector('.loom-dock-bar [aria-label="Inbox"] [data-part="visual"]')!;
        return { clip: getComputedStyle(w).clipPath, key: getComputedStyle(k).backgroundColor, tint: getComputedStyle(dock).backgroundColor };
      });
      expect(look.clip).toMatch(/^polygon/);
      expect(look.key).toBe(look.tint);
      const box = (await win.boundingBox())!;
      expect(box.width).toBeGreaterThan(w * 0.9);
      const keyTop = Math.min(...(await p.locator('.loom-dock-bar [data-part="item"]').evaluateAll((bs) => bs.map((b) => b.getBoundingClientRect().top))));
      expect(box.y + box.height).toBeLessThanOrEqual(keyTop);
      const page = (await p.locator('.loom-window main > *').first().boundingBox())!;
      expect(page.width).toBeGreaterThan(700);
      expect(page.width).toBeLessThanOrEqual(1152 + 1);
      expect(await p.locator('.loom-desk-home').count()).toBe(0);
      // Nothing sideways, and the page scrolls inside the window, not the screen.
      const m = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight }));
      expect(m.sw).toBeLessThanOrEqual(w); expect(m.sh).toBeLessThanOrEqual(ht);
      // Esc: back to the desktop, focus on the key the window came from.
      await p.keyboard.press('Escape');
      await p.locator('.loom-desk-home').waitFor();
      expect(new URL(p.url()).pathname).toBe('/');
      expect(await win.count()).toBe(0);
      await expect.poll(moves).toEqual(['open', 'close']);
      await expect.poll(() => p.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Inbox');
      // Close does the same.
      await p.locator('.loom-dock-bar [data-part="item"][aria-label="Setup"]').click();
      await win.waitFor();
      await p.getByRole('button', { name: /^Close, back to the desktop/ }).click();
      await p.locator('.loom-desk-home').waitFor();
      expect(new URL(p.url()).pathname).toBe('/');
      await p.context().close();
    }, 90_000);
  }

  it('reduced motion: the window opens and closes with no transition', async () => {
    const p = await screen('neon', 1280, 800, { motion: 'reduce' });
    await home(p);
    await p.evaluate(() => { const w = window as unknown as { moves: number }; w.moves = 0;
      new MutationObserver(() => { if (document.documentElement.dataset.deskMove) w.moves++; }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-desk-move'] }); });
    await p.locator('.loom-dock-bar [data-part="item"][aria-label="Inbox"]').click();
    await p.locator('.loom-window main [data-slot="card"], .loom-window main [role="group"]').first().waitFor();
    await p.keyboard.press('Escape');
    await p.locator('.loom-desk-home').waitFor();
    expect(await p.evaluate(() => (window as unknown as { moves: number }).moves)).toBe(0);
    await p.context().close();
  }, 60_000);

  it('Esc in a field inside the window is the field\'s: the window stays', async () => {
    const p = await screen('neon', 1280, 800);
    await p.goto(`${base}/find`);
    const field = p.locator('.loom-window main input').first();
    await field.waitFor();
    await field.click(); await field.fill('sonarr');
    await p.keyboard.press('Escape');
    await p.waitForTimeout(400);
    expect(new URL(p.url()).pathname).toBe('/find');
    expect(await p.locator('.loom-window').count()).toBe(1);
    await p.context().close();
  }, 60_000);

  it('000h at the same width, and Neon under 1024 px, open apps as pages: no window', async () => {
    for (const [look, w] of [['000h', 1280], ['neon', 1000]] as const) {
      const p = await screen(look, w, 800);
      for (const path of ['/inbox', '/setup']) {
        await p.goto(`${base}${path}`); await p.locator('.loom-top h1').waitFor(); await p.waitForTimeout(300);
        expect(await p.locator('.loom-window').count(), `${look} ${w} ${path}`).toBe(0);
        await p.keyboard.press('Escape'); await p.waitForTimeout(200);
        expect(new URL(p.url()).pathname, `${look} ${w} ${path}`).toBe(path);
      }
      await p.context().close();
    }
  }, 90_000);

  it('a sheet opened in the window stays above it, and Esc closes the sheet first, then the window', async () => {
    const p = await screen('neon', 1280, 800);
    await p.goto(`${base}/inbox`);
    await p.locator('.loom-window').waitFor();
    await p.locator('.loom-window main li button', { hasText: 'Sonarr' }).click();
    const sheet = p.locator('[role="dialog"]');
    await sheet.waitFor();
    const z = await sheet.evaluate((e) => { const r = e.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + 40); return !!top && e.contains(top); });
    expect(z).toBe(true);
    await p.keyboard.press('Escape');
    await expect.poll(() => sheet.count()).toBe(0);
    expect(new URL(p.url()).pathname).toBe('/inbox');
    await p.locator('#loom-window-title').focus();
    await p.keyboard.press('Escape');
    await p.locator('.loom-desk-home').waitFor();
    await p.context().close();
  }, 90_000);

  for (const [w, ht] of SIZES) {
    it(`${w}x${ht}: Ctrl+K opens Find as a command bar in the middle of the screen, over the desktop or a window; its Esc closes only Find`, async () => {
      const p = await screen('neon', w, ht);
      for (const path of ['/', '/inbox']) {
        await p.goto(`${base}${path}`); await p.locator(path === '/' ? '.loom-desk-home' : '.loom-window').waitFor(); await p.waitForTimeout(300);
        await p.keyboard.press('Control+k');
        await p.locator('[role="dialog"] .loom-find-field').waitFor();
        const b = (await p.locator('[role="dialog"]').boundingBox())!;
        expect(Math.abs(b.x + b.width / 2 - w / 2), path).toBeLessThanOrEqual(2);
        expect(await p.evaluate(() => document.activeElement?.tagName)).toBe('INPUT');
        await p.keyboard.press('Escape');
        await expect.poll(() => p.locator('[role="dialog"]').count()).toBe(0);
        expect(new URL(p.url()).pathname).toBe(path);
        if (path !== '/') expect(await p.locator('.loom-window').count()).toBe(1);
      }
      await p.context().close();
    }, 90_000);
  }

  it('000h at the same width keeps its rail and its page; under 1024 px Neon keeps a phone\'s dock and no desktop', async () => {
    const o = await screen('000h', 1280, 800);
    await o.goto(`${base}/`); await o.locator('.loom-top h1').waitFor(); await o.waitForTimeout(300);
    expect(await o.locator('.loom-desk, .loom-desk-home, .loom-w').count()).toBe(0);
    expect(await o.locator('.loom-dock-bar').count()).toBe(0);
    await o.locator('.loom-side').waitFor();   // the rail is its own chunk: it comes a moment after the page
    await o.context().close();
    const n = await screen('neon', 1000, 800);
    await n.goto(`${base}/`); await n.locator('.loom-top h1').waitFor(); await n.waitForTimeout(300);
    expect(await n.locator('.loom-desk, .loom-desk-home').count()).toBe(0);
    expect(await n.locator('.loom-dock-bar').count()).toBe(1);
    await n.context().close();
  }, 90_000);
});
