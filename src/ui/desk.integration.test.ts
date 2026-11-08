/**
 * Neon on a big screen (Jonathan, 2026-11-05, the desktop OS prototype's Level 1, "Shell"): in a real browser at
 * 1280x800 and 1920x1080, over a household with two agents and things waiting. Home is a desktop: Needs you and the
 * agents' big cards (docs/specs/agent-desk.md), no scrolling page and no page header past the bars; what needs you is
 * answered where that's safe in a line, and opens in the Inbox where it isn't; the dock sits
 * at the bottom centre with no rail beside it; nothing scrolls sideways. Low Light and Daylight are the same desktop
 * in their own colours, and a screen under 1024 px keeps a phone's layout.
 *
 * Runs where the app is built (npm run build) and a Chrome is installed (GitHub's runners have one).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { Look } from '../../web/src/look';
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
  const savedPath = process.env.PATH;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-desk-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), a === 'art' ? '# Art E Fish\n' : '# Visual Mark\n');
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db')); createConversationTables(db); db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', owner: 'jonathan', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] }));
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
    // A permission from a piece, laid out (an approval's plain ask): its whole question, why, and what each answer does.
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'permit.json'), JSON.stringify({ v: 2, tab: { label: 'Permit', kind: 'setting' }, asks: [{
      text: 'A change to the script that copies lane prompts to loom landed today, through a reviewed pull request. OK to start updating lane prompts on loom again?',
      meta: 'The script that copies them changed, so it stopped until you look.', why: 'The script that copies them changed, so it stopped until you look.',
      if_yes: 'Lane prompt changes go live again.', if_no: 'Lane prompts stay as they are until you look.', fine: 'A GitHub write: sleepunit-agents/art, from loom\'s machine.',
      kind: 'permission', tone: 'warn', at: new Date().toISOString(), page: '',
      actions: [{ action: 'allow', label: 'Allow once', tone: 'primary', fields: { id: 'a-00000001' } }, { action: 'deny', label: 'Deny', tone: 'danger', fields: { id: 'a-00000001' } }] }] }));
    writeFileSync(join(bin, 'loom-permit'), `#!/bin/sh\ncase "$1 $2" in "ui --json") cat "${join(bin, 'permit.json')}" ;; *) echo '{"title":"Permit","sections":[]}' ;; esac\n`);
    chmodSync(join(bin, 'loom-permit'), 0o755);
    // A Boxes place, quiet: the right column's Vitals widget, so all three columns have a first widget to line up.
    writeFileSync(join(bin, 'boxes.json'), JSON.stringify({ v: 2, tab: { label: 'Boxes' }, tile: { label: 'Boxes', value: '3 boxes', page: '' } }));
    writeFileSync(join(bin, 'loom-runtime'), `#!/bin/sh\ncase "$1 $2" in "ui --json") cat "${join(bin, 'boxes.json')}" ;; *) echo '{"title":"Boxes","sections":[]}' ;; esac\n`);
    chmodSync(join(bin, 'loom-runtime'), 0o755);
    process.env.PATH = `${bin}:${savedPath}`;
    handle = await startHttpServer({ contextDir: art, host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await handle?.close();
    await closeAllBackends();
    if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved;
    process.env.PATH = savedPath;
    if (h) rmSync(h.home, { recursive: true, force: true });
  });

  /** A screen in a look, signed in, its arrival already had unless `boot`. */
  async function screen(look: Look, width: number, height: number, o: { motion?: 'reduce' | 'no-preference'; boot?: boolean } = {}): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: o.motion ?? 'reduce', serviceWorkers: 'block' });
    await ctx.addInitScript(([l, boot]) => { localStorage.setItem('loom-look', l as string); if (!boot) sessionStorage.setItem('loom-arrived', '1'); }, [look, !!o.boot] as const);
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    // Home, not a page: a page on a desktop is a tile this device keeps, and the tests' Home would open beside it.
    await p.goto(`${base}/`);
    await p.locator('.loom-top h1').waitFor();
    const csrf = await p.evaluate(async () => ((await (await fetch('/appearance', { headers: { accept: 'application/json' } })).json()) as { chrome: { csrf: string } }).chrome.csrf);
    await p.evaluate(async ([c, l]) => { await fetch('/appearance/prefs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ _csrf: c, look: l }) }); }, [csrf, look]);
    return p;
  }
  const home = async (p: Page) => { await p.goto(`${base}/`); await p.locator('.loom-adesk').waitFor(); await p.waitForTimeout(300); };

  for (const [w, ht] of SIZES) {
    it(`${w}x${ht}: Home is the desktop: Needs you and the agents, no page header, no page scroll, the dock centred and no rail`, async () => {
      const p = await screen('neon', w, ht);
      const errors: string[] = [];
      p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      await home(p);
      // What needs you, a big card per agent with its face, alphabetical; nothing else pretending.
      expect(await p.locator('.loom-needs-band').count()).toBe(1);
      expect(await p.locator('.loom-bigcard').evaluateAll((cs) => cs.map((c) => c.getAttribute('aria-label')))).toEqual(['Art E Fish', 'Visual Mark']);
      for (const card of await p.locator('.loom-bigcard').all()) {
        expect(await card.locator('.loom-bigcard__face [aria-label]').count()).toBeGreaterThan(0);   // its face (blocks.tsx AgentAvatar: the pixel face where it has one)
        expect((await card.locator('.loom-bigcard__eb').innerText()).trim().length).toBeGreaterThan(0);   // and how it is
        expect((await card.locator('[data-row="now"] dd').innerText()).trim().length).toBeGreaterThan(0);
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
      // Needs you and every card are on the screen, above the dock.
      const keys = await p.locator('.loom-dock-bar [data-part="item"]').evaluateAll((bs) => bs.map((b) => b.getBoundingClientRect()).map((r) => ({ l: r.left, r: r.right, t: r.top })));
      for (const box of await p.locator('.loom-needs-band, .loom-bigcard').evaluateAll((ws) => ws.map((x) => x.getBoundingClientRect()).map((r) => ({ l: r.left, r: r.right, b: r.bottom })))) {
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

  for (const [w, ht] of SIZES) {
    it(`${w}x${ht}: the cards share a top edge and the desktop's width, no headline, and no Moving strip`, async () => {
      const p = await screen('neon', w, ht);
      await home(p);
      const boxes = await p.locator('.loom-bigcard').evaluateAll((cs) => cs.map((c) => c.getBoundingClientRect()).map((r) => ({ t: r.top, l: r.left, r: r.right })));
      expect(boxes.length).toBe(2);
      expect(Math.abs(boxes[0].t - boxes[1].t)).toBeLessThanOrEqual(1);
      const band = await p.locator('.loom-needs-band').evaluate((e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right }; });
      expect(Math.abs(boxes[0].l - band.l)).toBeLessThanOrEqual(1);
      expect(Math.abs(boxes[1].r - band.r)).toBeLessThanOrEqual(1);
      // No headline or status line (Jonathan, 2026-11-06: "just cards, widgets and windows").
      expect(await p.locator('.loom-desk-headline').count()).toBe(0);
      expect(await p.getByText('Everyone\u2019s fine').count()).toBe(0);
      // What each agent is on is its card's: nothing repeats it in a strip.
      expect(await p.locator('.loom-w--tape, [data-widget]').count()).toBe(0);
      expect(await p.getByText('Moving', { exact: true }).count()).toBe(0);
      await p.context().close();
    }, 90_000);
  }

  it('what needs you is answered where it stands when a line can: Yes posts the ask\'s answer; one answered in words opens in the Inbox', async () => {
    const p = await screen('neon', 1280, 800);
    await home(p);
    const chip = (t: string) => p.locator('.loom-needs-band .loom-nchip', { hasText: t });
    const sonarr = chip('recycle bin on Sonarr');
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
    // An ask answered in words has no Yes or No in a line: its Reply opens it in the Inbox, picked, beside the rail.
    const all = await p.locator('.loom-needs-band .loom-nchip').count();
    const words = chip('Gabe or Mark');
    if (await words.count()) {
      expect(await words.getByRole('button', { name: 'Yes' }).count()).toBe(0);
      await words.getByRole('button', { name: /Reply/ }).click();
      await p.locator('.loom-tile[data-tile="/inbox"] .loom-split__reader').waitFor();
      await expect.poll(() => p.locator('.loom-split__reader h2').textContent()).toContain('Gabe or Mark');
      expect(new URL(p.url()).searchParams.get('f')).toBe('needs');
      expect(await p.locator('.loom-arail .loom-rneeds').count()).toBe(1);
    } else expect(all).toBe(3);
    await p.context().close();
  }, 90_000);

  it('a permission\'s Allow and Deny never show in the band: it opens in the Inbox\'s reader, read whole there', async () => {
    const p = await screen('neon', 1920, 1080);
    await home(p);
    // The first three are in the band; the Inbox has them all. Each is answered in a line only as Yes and No.
    const n = await p.locator('.loom-needs-band .loom-nchip').count();
    expect(n).toBeGreaterThan(0);
    expect(await p.locator('.loom-needs-band').getByRole('button', { name: /^(Allow|Deny)/ }).count()).toBe(0);
    const card = p.locator('.loom-needs-band .loom-nchip', { hasText: 'lane prompts on loom again' });
    if (!(await card.count())) await p.locator('.loom-needs-band__all').click();
    else await card.getByRole('button', { name: /Read and answer|Open/ }).click();
    const inbox = p.locator('.loom-tile[data-tile="/inbox"]');
    await inbox.waitFor();
    if (!(await card.count())) await inbox.getByText('OK to start updating lane prompts on loom again?').first().click();
    const sheet = p.locator('.loom-split__reader');
    await expect.poll(() => sheet.locator('h2').textContent()).toContain('OK to start updating lane prompts on loom again?');
    for (const t of ['If you allow', 'If you deny', 'Exactly what this allows']) expect(await sheet.textContent()).toContain(t);
    await sheet.getByRole('button', { name: 'Allow once' }).waitFor();
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

  it('under 1024 px, apps open as pages: no tiles', async () => {
    {
      const [look, w] = ['neon', 1000] as const;
      const p = await screen(look, w, 800);
      for (const path of ['/inbox', '/setup']) {
        await p.goto(`${base}${path}`); await p.locator('.loom-top h1').waitFor(); await p.waitForTimeout(300);
        expect(await p.locator('.loom-tiles, .loom-tile').count(), `${look} ${w} ${path}`).toBe(0);
        await p.keyboard.press('Escape'); await p.waitForTimeout(200);
        expect(new URL(p.url()).pathname, `${look} ${w} ${path}`).toBe(path);
      }
      await p.context().close();
    }
  }, 90_000);

  for (const [w, ht] of SIZES) {
    it(`${w}x${ht}: Ctrl+K opens Find as a command bar in the middle of the screen, over the desktop or a tile; its Esc closes only Find`, async () => {
      const p = await screen('neon', w, ht);
      for (const path of ['/', '/inbox']) {
        await p.goto(`${base}${path}`); await p.locator(path === '/' ? '.loom-adesk' : '.loom-tile').waitFor(); await p.waitForTimeout(300);
        await p.keyboard.press('Control+k');
        await p.locator('[role="dialog"] .loom-find-field').waitFor();
        const b = (await p.locator('[role="dialog"]').boundingBox())!;
        expect(Math.abs(b.x + b.width / 2 - w / 2), path).toBeLessThanOrEqual(2);
        expect(await p.evaluate(() => document.activeElement?.tagName)).toBe('INPUT');
        await p.keyboard.press('Escape');
        await expect.poll(() => p.locator('[role="dialog"]').count()).toBe(0);
        expect(new URL(p.url()).pathname).toBe(path);
        if (path !== '/') expect(await p.locator('.loom-tile').count()).toBe(1);
      }
      await p.context().close();
    }, 90_000);
  }

  /** A fresh session's first page: neither the boot nor the arrival had yet. Its marks are cleared from a page that isn't
   * the app (/pieces.json, the same origin): from the app's own page, an arrival still running (arrive.tsx) could mark the
   * session again between the clear and the next page, and on a loaded runner it did, so the boot never came (t-1949). */
  const fresh = async (p: Page, path = '/') => {
    await p.goto(`${base}/pieces.json`);
    await p.evaluate(() => { sessionStorage.removeItem('loom-arrived'); sessionStorage.removeItem('loom-booted'); });
    await p.goto(`${base}${path}`);
  };
  /** Whether an element of the boot is shown now (its lines come up one by one: hidden ones are in the DOM already). */
  const shown = (p: Page, sel: string) => p.locator(sel).evaluate((e) => getComputedStyle(e).visibility === 'visible' && Number(getComputedStyle(e.closest('.loom-boot')!).opacity) > 0.5);

  /** What the boot did, logged in the page as it happens and timed by its own clock (performance.now()): when it came up,
   * when its last line (the licence) was shown, when a key went down, when it began to leave, and when it was gone. A
   * clock read from here is the runner's, and on a loaded one each read is late by however long the page took to
   * answer: the licence line "not up in 1.6 s" failed 1 run in 10 that way (t-1923). */
  type BootNote = { what: 'in' | 'last' | 'key' | 'leaving' | 'out'; at: number; text?: string; aria?: string | null; lic?: string; focused?: boolean };
  const logBoot = (p: Page) => p.addInitScript(() => {
    const log: BootNote[] = [];
    (window as unknown as { bootLog: BootNote[] }).bootLog = log;
    const isBoot = (n: Node) => n instanceof Element && (n.matches('.loom-boot') || !!n.querySelector('.loom-boot'));
    new MutationObserver((ms) => {
      for (const m of ms) {
        const at = performance.now();
        if (m.type === 'attributes') {
          const b = m.target as Element;
          if (b.matches('.loom-boot') && b.hasAttribute('data-leaving')) {
            log.push({ what: 'leaving', at, lic: b.querySelector('.loom-boot__lic')?.textContent ?? '', focused: !!document.activeElement?.closest('.loom-boot') });
          }
          continue;
        }
        for (const n of m.addedNodes) if (isBoot(n)) {
          const b = (n as Element).matches('.loom-boot') ? n as Element : (n as Element).querySelector('.loom-boot')!;
          log.push({ what: 'in', at, text: b.textContent ?? '', aria: b.getAttribute('aria-hidden') });
        }
        for (const n of m.removedNodes) if (isBoot(n)) log.push({ what: 'out', at });
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-leaving'] });
    // A line is shown when its animation ends (desk.css: hidden, then visible at the end of its 10 ms step).
    addEventListener('animationend', (e) => {
      const li = e.target as Element;
      if (li.matches?.('.loom-boot__log li') && !li.nextElementSibling) log.push({ what: 'last', at: performance.now(), text: li.textContent ?? '' });
    }, true);
    // A key or a tap: what skips it.
    for (const t of ['keydown', 'pointerdown']) addEventListener(t, () => log.push({ what: 'key', at: performance.now() }), true);
  });
  /** The boot's log once it has had each of `whats`, in the page's own clock. How long it waits is a budget for a loaded
   * runner, not a limit on the boot (holdClock is what times it); if it runs out, it says what the page had. */
  const bootHad = (p: Page, whats: BootNote['what'][], timeout = 30_000) => p.waitForFunction((ws) => {
    const log = (window as unknown as { bootLog?: BootNote[] }).bootLog ?? [];
    // The last line shown, even if its animationend went by unseen.
    const li = document.querySelector('.loom-boot__log li:last-child');
    if (li && !log.some((e) => e.what === 'last') && getComputedStyle(li).visibility === 'visible') log.push({ what: 'last', at: performance.now(), text: li.textContent ?? '' });
    return ws.every((w) => log.some((e) => e.what === w)) ? log : null;
  }, whats, { timeout }).then((h) => h.jsonValue() as Promise<BootNote[]>).catch(async (e: Error) => {
    const had = await p.evaluate(() => ({ path: location.pathname, log: (window as unknown as { bootLog?: BootNote[] }).bootLog, boots: document.querySelectorAll('.loom-boot').length, session: { ...sessionStorage } })).catch(() => 'unreadable');
    throw new Error(`the boot never had ${whats.join(', ')}: ${JSON.stringify(had)}\n${e.message}`);
  });
  const note = (log: BootNote[], what: BootNote['what']) => log.find((e) => e.what === what)!;
  /** The order the boot's notes came in (a note's place in the log, which is the page's own order of events). Its last
   * line comes up by CSS (desk.css), on the browser's real time, which a held clock doesn't hold: so it's left out unless
   * asked for. */
  const order = (log: BootNote[], withLast = false) => log.map((e) => e.what).filter((w) => withLast || w !== 'last');
  /** desk.tsx's BOOT_MS and BOOT_FADE_MS: how long the boot stands, and its fade. */
  const BOOT_MS = 2200;
  const BOOT_FADE_MS = 250;
  /** Stop the page's clock (Playwright's: setTimeout, performance.now and the rest) from the next page on, so the boot's
   * own timer only runs when a test moves it on (p.clock.runFor). No wall-clock limit is left: each timing test failed
   * on a busy runner, the page's own clock included, since a loaded browser is late for everything (732 ms against a
   * 600 ms limit on CI; 3491 against 3200 locally; each failure ejected a PR from the merge queue, t-1949). What the boot
   * does now is checked in order, and to the millisecond on a clock that doesn't move until it's told to. */
  const holdClock = async (p: Page) => { await p.clock.install(); await p.clock.pauseAt(Date.now() + 1000); };

  it('the boot: what loom has, licensed to the owner by name, the licence line up before it leaves; a key skips it at once', async () => {
    const p = await screen('neon', 1280, 800, { motion: 'no-preference', boot: true });
    // The owner's name as People has it (Find's answer): "Jonathan Barket" is licensed as "Jonathan B.".
    await p.route('**/find', (r) => r.fulfill({ json: { suggest: { people: [{ label: 'Jonathan Barket', href: '/people/jonathan' }] } } }));
    await logBoot(p);
    await holdClock(p);
    await fresh(p);
    const boot = p.locator('.loom-boot');
    // Left alone, the whole boot, as the page saw it. Its clock is held, so it stands until the test moves it on; its lines
    // come up meanwhile (desk.css, on the browser's own time), the licence line last.
    const lines = await bootHad(p, ['in', 'last']);
    const [up, last] = (['in', 'last'] as const).map((w) => note(lines, w));
    expect(up.text).toMatch(/LOOM\/\/OS/);
    expect(up.text).toMatch(/2 agents/);
    expect(up.aria).toBe('true');
    expect(last.text).toMatch(/validating LOOM\/\/OS™ license.*compliant/);
    // The licence line is up, and still up, until the boot leaves by itself at 2.2 s on its clock; by then it names the owner.
    await p.clock.runFor(BOOT_MS - 1);
    expect(order(await p.evaluate(() => (window as unknown as { bootLog: BootNote[] }).bootLog), true)).toEqual(['in', 'last']);
    expect(await shown(p, '.loom-boot__log li:last-child')).toBe(true);
    await p.clock.runFor(1);
    const leaving = note(await bootHad(p, ['leaving']), 'leaving');
    expect(leaving.lic).toBe('licensed to Jonathan B.');
    // It never has focus.
    expect(leaving.focused).toBe(false);
    await p.clock.runFor(BOOT_FADE_MS);
    expect(order(await bootHad(p, ['out']), true)).toEqual(['in', 'last', 'leaving', 'out']);
    // A key skips it at once. The clock is still held, so the boot can't leave by itself however late the key is: it
    // leaves on the key, with no time passing at all, and is gone once its fade (0.25 s) has run.
    await fresh(p);
    await bootHad(p, ['in']);
    await p.keyboard.press('Space');
    const skip = await bootHad(p, ['in', 'key', 'leaving']);
    expect(order(skip)).toEqual(['in', 'key', 'leaving']);
    expect(note(skip, 'leaving').at).toBe(note(skip, 'key').at);
    expect(await boot.count()).toBe(1);
    await p.clock.runFor(BOOT_FADE_MS);
    expect(order(await bootHad(p, ['out']))).toEqual(['in', 'key', 'leaving', 'out']);
    // Then the app's own arrival (its power-on) runs, and the desktop is there.
    await p.clock.resume();
    await p.locator('.loom-adesk').waitFor();
    // Once a session: not again on the next page, nor coming back.
    await p.goto(`${base}/`); await p.locator('.loom-adesk').waitFor(); await p.waitForTimeout(600);
    expect(await boot.count()).toBe(0);
    expect(await p.evaluate(() => (window as unknown as { bootLog: BootNote[] }).bootLog.length)).toBe(0);
    await p.context().close();
  }, 90_000);

  it('a tap skips the boot and presses nothing under it', async () => {
    const p = await screen('neon', 1280, 800, { motion: 'no-preference', boot: true });
    await logBoot(p);
    // Held, so it's the tap that ends the boot, never its own timer (holdClock).
    await holdClock(p);
    await fresh(p);
    await bootHad(p, ['in']);
    // Where the Inbox's dock key is, under the boot.
    const key = (await p.locator('.loom-dock-bar [data-part="item"][aria-label="Inbox"]').boundingBox())!;
    await p.mouse.click(key.x + key.width / 2, key.y + key.height / 2);
    await bootHad(p, ['key', 'leaving']);
    await p.clock.runFor(BOOT_FADE_MS);
    expect(order(await bootHad(p, ['out']))).toEqual(['in', 'key', 'leaving', 'out']);
    await p.clock.resume();
    await p.waitForTimeout(400);
    expect(new URL(p.url()).pathname).toBe('/');
    await p.context().close();
  }, 60_000);

  it('the boot leaves by itself after about two seconds', async () => {
    const p = await screen('neon', 1920, 1080, { motion: 'no-preference', boot: true });
    await logBoot(p);
    await holdClock(p);
    await fresh(p);
    await bootHad(p, ['in']);
    // Up 2.2 s, then a 0.25 s fade, on the page's own clock, moved on by hand: still up just before, leaving at 2.2 s,
    // gone once the fade has run.
    await p.clock.runFor(BOOT_MS - 100);
    expect(order(await p.evaluate(() => (window as unknown as { bootLog: BootNote[] }).bootLog))).toEqual(['in']);
    await p.clock.runFor(100);
    expect(order(await bootHad(p, ['leaving']))).toEqual(['in', 'leaving']);
    expect(await p.locator('.loom-boot').count()).toBe(1);
    await p.clock.runFor(BOOT_FADE_MS);
    expect(order(await bootHad(p, ['out']))).toEqual(['in', 'leaving', 'out']);
    await p.context().close();
  }, 60_000);

  it('no boot under reduced motion, or under 1024 px', async () => {
    for (const [w, motion] of [[1280, 'reduce'], [1000, 'no-preference']] as const) {
      const look = 'neon';
      const p = await screen(look, w, 800, { motion, boot: true });
      await fresh(p);
      await p.locator('.loom-top h1').waitFor();
      await p.waitForTimeout(800);
      expect(await p.locator('.loom-boot').count(), `${look} ${w} ${motion}`).toBe(0);
      await p.context().close();
    }
  }, 90_000);

  it('Low Light and Daylight at the same width are the same desktop: the agents, a tile, no side rail, nothing sideways; under 1024 px Neon keeps a phone\'s dock and no desktop', async () => {
    for (const look of ['lowlight', 'daylight'] as const) {
      const o = await screen(look, 1280, 800);
      await home(o);
      expect(await o.evaluate(() => document.documentElement.dataset.look), look).toBe(look);
      expect(await o.locator('.loom-desk .loom-bigcard').count(), look).toBeGreaterThan(1);
      expect(await o.locator('.loom-side').count(), look).toBe(0);
      expect(await o.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), look).toBeLessThanOrEqual(0);
      await o.goto(`${base}/inbox`);
      await o.locator('.loom-tile').waitFor();
      await o.context().close();
    }
    const n = await screen('neon', 1000, 800);
    await n.goto(`${base}/`); await n.locator('.loom-top h1').waitFor(); await n.waitForTimeout(300);
    expect(await n.locator('.loom-desk, .loom-adesk').count()).toBe(0);
    expect(await n.locator('.loom-dock-bar').count()).toBe(1);
    await n.context().close();
  }, 90_000);
});
