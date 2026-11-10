/**
 * The household's pixel icons (Jonathan, 2026-11-05): a set installed per household (`loom household icons install`),
 * kept at icons/<set>/, served only to someone signed in, and worn in place of the line icons by whoever turns
 * Appearance's "Pixel icons" on (off unless they do). Each icon is recoloured to its key's ramp (web/src/pixel-ramp.ts):
 * a line-only icon is inverted first on a dark key, and not on the lit one. An app without one keeps its line icon.
 *
 * The set here is made in the test (pixel-ramp's arithmetic needs known pixels): Home has black, grey and white bands;
 * Inbox is line-only (black ink, a white strip); Activity, Members and People (yellow) are plain. Knowledge has none.
 */
import { requestTrace } from './request-trace.fixture.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { agentDir, createToken, loadHousehold, type Household } from '../household.js';
import { runHousehold } from '../cli/household.js';
import { iconSetOf, lineOnly } from '../icon-set.js';
import { decodePng } from '../png.js';
import { encodePng } from '../png.fixture.js';
import { mapPixel, parseColor, rampFor, type RGB } from '../../web/src/pixel-ramp';

const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);

/** A 32×32 RGBA PNG, each row one colour. */
function png(row: (y: number) => [number, number, number, number]): Buffer {
  const raw = Buffer.alloc((32 * 4 + 1) * 32);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) raw.set(row(y), y * (32 * 4 + 1) + 1 + x * 4);
  const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(32, 0); ihdr.writeUInt32BE(32, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const BLACK: [number, number, number, number] = [0, 0, 0, 255];
const GREY: [number, number, number, number] = [128, 128, 128, 255];
const WHITE: [number, number, number, number] = [255, 255, 255, 255];
// Home: black (rows 0-9), grey (10-21), white (22-31). Mostly light: not line-only.
const HOME = png((y) => (y < 10 ? BLACK : y < 22 ? GREY : WHITE));
// Inbox: black ink with a white strip at the bottom (4 rows of 32: an eighth light). Line-only.
const INBOX = png((y) => (y < 28 ? BLACK : WHITE));
const PLAIN = png((y) => (y < 16 ? GREY : WHITE));

describe('the household\'s pixel icons', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let base: string;
  let token: string;
  let samToken: string;
  let browser: Browser | undefined;
  let set: string;
  const saved = process.env.LOOM_HOME;
  const savedXdg = process.env.XDG_CONFIG_HOME;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-pixicons-'));
    mkdirSync(join(home, 'agents', 'art'), { recursive: true });
    writeFileSync(join(home, 'agents', 'art', 'IDENTITY.md'), '# Art E Fish\n');
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art'], default: 'art', members: [{ person: 'jonathan', role: 'owner', agents: '*' }, { person: 'sam', role: 'owner', agents: ['art'] }] }));
    process.env.LOOM_HOME = home;
    // No pieces from this machine: the page is this household's alone.
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    h = loadHousehold(home)!;
    token = createToken(h, { role: { kind: 'owner' }, label: 'jonathan' }).token;
    samToken = createToken(h, { role: { kind: 'owner', member: 'sam' }, label: 'sam' }).token;
    set = mkdtempSync(join(tmpdir(), 'loom-pixicons-set-'));
    writeFileSync(join(set, 'home.png'), HOME);
    writeFileSync(join(set, 'inbox.png'), INBOX);
    writeFileSync(join(set, 'activity.png'), PLAIN);
    writeFileSync(join(set, 'members.png'), PLAIN);
    writeFileSync(join(set, 'people.png'), PLAIN);
    handle = await startHttpServer({ contextDir: agentDir(h, 'art'), host: '127.0.0.1', port: 0, household: h });
    base = `http://127.0.0.1:${handle.port}`;
    if (built && chrome) browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await handle.close();
    if (saved === undefined) delete process.env.LOOM_HOME; else process.env.LOOM_HOME = saved;
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
    rmSync(h.home, { recursive: true, force: true });
    rmSync(set, { recursive: true, force: true });
  });

  const cli = async (...argv: string[]) => {
    let out = '', err = '';
    const code = await runHousehold(argv, { stdout: (s: string) => { out += s; }, stderr: (s: string) => { err += s; }, env: { ...process.env, LOOM_HOME: h.home } } as never);
    return { code, out, err };
  };
  const signIn = async () => ((await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `token=${encodeURIComponent(token)}`, redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0];

  it('a line-only icon is one whose drawn pixels are mostly dark', () => {
    expect(lineOnly(decodePng(INBOX).rgba)).toBe(true);
    expect(lineOnly(decodePng(HOME).rgba)).toBe(false);
  });

  it('installs from a folder of <app>.png, works out the line-only ones, and wears the set', async () => {
    const r = await cli('icons', 'install', set, '--name', 'test');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Icon set test: 5 icons (activity, home, inbox, members, people), in use.');
    expect(r.out).toContain('Line-only, inverted on a dark key: inbox.');
    expect(JSON.parse(readFileSync(join(h.home, 'icons', 'test', 'manifest.json'), 'utf-8'))).toEqual({
      icons: { activity: 'activity.png', home: 'home.png', inbox: 'inbox.png', members: 'members.png', people: 'people.png' }, line: ['inbox'] });
    expect(iconSetOf(h)?.apps).toEqual({ activity: {}, home: {}, inbox: { line: true }, members: {}, people: {} });
    expect((await cli('icons', 'list')).out).toBe('test (in use: 5 icons)\n');
  });

  it('refuses an icon that isn\'t 32×32, by name and size, writing nothing', async () => {
    const bad = mkdtempSync(join(tmpdir(), 'loom-pixicons-bad-'));
    writeFileSync(join(bad, 'home.png'), encodePng(16, 16, new Uint8Array(16 * 16 * 4).fill(255), 4));
    const r = await cli('icons', 'install', bad, '--name', 'bad');
    expect(r.code).toBe(1);
    expect(r.err).toBe('home.png is 16×16; an icon is 32×32\n');
    expect(existsSync(join(h.home, 'icons', 'bad'))).toBe(false);
    rmSync(bad, { recursive: true, force: true });
  });

  it('serves the set to someone signed in, and not to anyone else', async () => {
    const trace = requestTrace();
    const anon = await trace.fetch(`${base}/pixel-icons/home.png`, { redirect: 'manual' });
    expect(anon.status).not.toBe(200);
    expect(anon.headers.get('content-type') ?? '').not.toMatch(/image/);
    const forged = await trace.fetch(`${base}/pixel-icons/home.png`, { redirect: 'manual', headers: { cookie: 'loom_ui=' + '0'.repeat(64) } });
    expect(forged.status).not.toBe(200);
    trace.mark('Jonathan sign-in start');
    const cookie = await signIn();
    trace.mark('Jonathan sign-in complete');
    const ok = await trace.fetch(`${base}/pixel-icons/home.png?v=1`, { headers: { cookie } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect(ok.headers.get('cache-control')).toMatch(/^private/);
    trace.mark('Home icon body start');
    expect(Buffer.from(await ok.arrayBuffer()).equals(HOME)).toBe(true);
    expect((await trace.fetch(`${base}/pixel-icons/knowledge.png`, { headers: { cookie } })).status).toBe(404);
    // Nothing but an app's icon: a PNG that is there, beside the set and at the household's top, is never served by a path
    // that climbs out to it, however it's spelled.
    writeFileSync(join(h.home, 'icons', 'secret.png'), HOME);
    writeFileSync(join(h.home, 'secret.png'), HOME);
    for (const climb of ['..%2Fsecret.png', '%2E%2E%2Fsecret.png', '..%2F..%2Fsecret.png', '..%5Csecret.png', 'test%2F..%2F..%2Fsecret.png']) {
      const r = await trace.fetch(`${base}/pixel-icons/${climb}`, { headers: { cookie } });
      expect(r.headers.get('content-type') ?? '', climb).not.toMatch(/image/);
    }
    // An agent owner is a member too: their shell names the icons, and they can fetch them.
    const samCookie = ((await trace.fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(samToken)}`, redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0];
    const sam = await trace.fetch(`${base}/pixel-icons/home.png?v=1`, { headers: { cookie: samCookie } });
    expect(sam.status).toBe(200);
    expect(sam.headers.get('content-type')).toBe('image/png');
    // The shell names the set for the page, with each line-only icon.
    trace.mark('shell JSON start');
    const page = await (await trace.fetch(`${base}/`, { headers: { cookie, accept: 'application/json' } })).json() as { chrome: { shell: { icons?: { v: string; apps: Record<string, unknown> } } } };
    trace.mark('shell JSON complete');
    expect(page.chrome.shell.icons?.apps).toEqual({ activity: {}, home: {}, inbox: { line: true }, members: {}, people: {} });
  });

  describe.runIf(built && chrome)('in a browser', () => {
    let ctx: BrowserContext;
    const open = async (width: number, prefs?: Record<string, unknown>): Promise<Page> => {
      ctx = await browser!.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce', serviceWorkers: 'block' });
      await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
      if (prefs) {
        const page = await ctx.newPage();
        // Home, not a page: a page on a desktop is a tile this device keeps, and the tests' Home would open beside it.
        await page.goto(`${base}/`);
        const csrf = await page.evaluate(async () => ((await (await fetch('/appearance', { headers: { accept: 'application/json' } })).json()) as { chrome: { csrf: string } }).chrome.csrf);
        const r = await ctx.request.post(`${base}/appearance/prefs`, { data: { _csrf: csrf, ...prefs }, headers: { origin: base } });
        expect(r.status()).toBe(200);
        await page.close();
      }
      return ctx.newPage();
    };
    const key = (p: Page, label: string) => p.locator(`.loom-dock-bar [data-part="item"][aria-label="${label}"]`);
    /** The colours of an icon as drawn, at its rows 5, 15 and 26 (Home's black, grey and white; Inbox's ink, ink and strip at 29). */
    const drawn = async (p: Page, sel: string, rows: number[]): Promise<RGB[]> => {
      const img = p.locator(sel).first();
      await img.evaluate((el: HTMLImageElement) => el.decode());
      const { rgba, width } = decodePng(await img.screenshot({ animations: 'disabled' }));
      return rows.map((y) => [...rgba.subarray((y * width + 16) * 4, (y * width + 16) * 4 + 3)] as RGB);
    };
    const near = (a: RGB, b: RGB, why: string) => expect(Math.max(...a.map((v, i) => Math.abs(v - b[i]))), `${why}: ${a} vs ${b}`).toBeLessThanOrEqual(4);
    /** The look's colours as the page computes them, for the ramp the test expects. */
    const tokens = (p: Page) => p.evaluate(() => {
      const probe = document.createElement('i');
      document.body.append(probe);
      const c = (v: string, tint?: string) => { if (tint) probe.dataset.tint = tint; else delete probe.dataset.tint; probe.style.color = v; return getComputedStyle(probe).color; };
      const out = { mode: document.documentElement.dataset.mode, canvas: c('var(--v-canvas)'), ink: c('var(--v-ink)'), on: c('var(--v-on-accent)'), pink: c('var(--t)', 'pink'), blue: c('var(--t)', 'blue'), yellow: c('var(--t)', 'yellow') };
      probe.remove();
      return out;
    });
    const keyColours = (t: Awaited<ReturnType<typeof tokens>>, tint: 'pink' | 'blue' | 'yellow') =>
      ({ mode: t.mode === 'light' ? 'light' as const : 'dark' as const, canvas: parseColor(t.canvas), ink: parseColor(t.ink), onAccent: parseColor(t.on), tint: parseColor(t[tint]) });

    it('off by default: the dock, the tiles and Appearance\'s choice', async () => {
      const p = await open(1280);
      await p.goto(`${base}/`);
      await key(p, 'Home').waitFor();
      expect(await p.locator('img.loom-pix').count()).toBe(0);
      await p.goto(`${base}/appearance`);
      await p.locator('[aria-label="Pixel icons"]').waitFor();
      expect(await p.locator('[aria-label="Pixel icons"] [data-state="on"]').innerText()).toBe('Off');
      await ctx.close();
    }, 60_000);

    it('on: the dock, the tiles, Find and the title strip wear them; an app without one keeps its line icon', async () => {
      const p = await open(1280, { icons: true });
      await p.goto(`${base}/`);
      await key(p, 'Home').locator('img.loom-pix').waitFor();
      expect(await key(p, 'Inbox').locator('img.loom-pix').getAttribute('data-line')).toBe('');
      expect(await key(p, 'Activity').locator('img.loom-pix').count()).toBe(1);
      // Knowledge has no icon in this set: its line icon (an SVG), and no image.
      expect(await key(p, 'Knowledge').locator('img.loom-pix').count()).toBe(0);
      expect(await key(p, 'Knowledge').locator('svg').count()).toBeGreaterThan(0);
      // Crisp: 32 px at 1×, whole pixels.
      expect(await key(p, 'Home').locator('img.loom-pix').evaluate((el) => [el.getBoundingClientRect().width, getComputedStyle(el).imageRendering])).toEqual([32, 'pixelated']);
      // The title strip of the tile an app opens in.
      await p.goto(`${base}/activity`);
      await p.locator('.loom-tile__key img.loom-pix[data-app="activity"][data-lit]').waitFor();
      // The launcher's tiles (Setup's and Places' on a desktop: an old link to either opens it), and Find's.
      await p.goto(`${base}/setup`);
      const apps = p.locator('.loom-launcher');
      await apps.locator('.loom-launch-tile img.loom-pix[data-app="members"]').waitFor();
      // People wears its (yellow) icon; Knowledge, with none in this set, its line icon.
      await apps.locator('.loom-launch-tile img.loom-pix[data-app="people"][data-tint="yellow"]').waitFor();
      expect(await apps.locator('.loom-launch-tile img.loom-pix[data-app="activity"]').count()).toBe(1);
      expect(await apps.locator('.loom-lapp[aria-label^="Knowledge"] .loom-launch-tile svg').count()).toBeGreaterThan(0);
      await p.keyboard.press('Escape');
      await p.goto(`${base}/find`);
      await p.getByRole('combobox').or(p.getByRole('searchbox')).or(p.locator('input')).first().fill('activ');
      await p.locator('.loom-app-tile img.loom-pix[data-app="activity"]').first().waitFor();
      await ctx.close();
    }, 60_000);

    for (const look of ['neon', 'lowlight', 'daylight'] as const) {
      it(`${look}: each key's ramp, normal and lit; a line-only icon inverted only when normal on a dark key`, async () => {
        const p = await open(1280, { icons: true, look, contrast: 'off' });
        // On Home, Home's key is lit and Inbox's normal; on the Inbox, the other way round.
        await p.goto(`${base}/`);
        await key(p, 'Home').locator('img.loom-pix').waitFor();
        expect(await p.evaluate(() => document.documentElement.dataset.look)).toBe(look);
        const t = await tokens(p);
        const pink = keyColours(t, 'pink');
        const blue = keyColours(t, 'blue');
        const homeLit = await drawn(p, '.loom-dock-bar [aria-label="Home"] img.loom-pix', [5, 15, 26]);
        const ramp = rampFor(pink, true);
        near(homeLit[0], mapPixel([0, 0, 0], ramp, false, false), 'Home lit, its black');
        near(homeLit[1], mapPixel([128, 128, 128], ramp, false, false), 'Home lit, its grey');
        near(homeLit[2], mapPixel([255, 255, 255], ramp, false, false), 'Home lit, its white');
        if (look === 'neon') {
          // Pinned to Neon's own colours, written out (looks.css), not computed: the lit key's ink and white.
          expect([t.canvas, t.ink, t.on, t.pink]).toEqual(['rgb(7, 7, 12)', 'rgb(243, 241, 255)', 'rgb(10, 9, 18)', 'rgb(255, 61, 168)']);
          near(homeLit[0], [10, 9, 18], 'Neon lit, black is the key\'s ink');
          near(homeLit[2], [255, 255, 255], 'Neon lit, white is white');
        }
        const inboxNormal = await drawn(p, '.loom-dock-bar [aria-label="Inbox"] img.loom-pix', [5, 29]);
        const n = rampFor(blue, false);
        if (look === 'daylight') {
          // Line-only on a light key: not inverted, or its lines would vanish; the ink is the shadow.
          near(inboxNormal[0], n[0], 'Inbox normal on Daylight, its ink is the shadow');
          near(inboxNormal[1], n[2], 'Inbox normal on Daylight, its strip the highlight');
        } else {
          // Line-only, normal, on a dark key: inverted, so the ink takes the highlight and glows, and the strip the shadow.
          near(inboxNormal[0], n[2], 'Inbox normal, its ink glows (the highlight)');
          near(inboxNormal[1], n[0], 'Inbox normal, its strip is the shadow');
        }

        await key(p, 'Inbox').click();
        await p.waitForURL((u) => u.pathname === '/inbox');
        await p.locator('.loom-dock-bar [aria-label="Inbox"] img.loom-pix[data-lit]').waitFor();
        const inboxLit = await drawn(p, '.loom-dock-bar [aria-label="Inbox"] img.loom-pix', [5, 29]);
        const l = rampFor(blue, true);
        // Lit: not inverted, the ink stays dark.
        near(inboxLit[0], l[0], 'Inbox lit, its ink is the shadow');
        near(inboxLit[1], l[2], 'Inbox lit, its strip the highlight');
        const homeNormal = await drawn(p, '.loom-dock-bar [aria-label="Home"] img.loom-pix:not([data-lit])', [5, 15, 26]);
        const hn = rampFor(pink, false);
        near(homeNormal[0], hn[0], 'Home normal, its black is the shadow');
        near(homeNormal[1], mapPixel([128, 128, 128], hn, false, false), 'Home normal, its grey is the tint');
        near(homeNormal[1], pink.tint, 'Home normal, its grey is near the tint');
        near(homeNormal[2], hn[2], 'Home normal, its white the highlight');
        if (look === 'neon') {
          near(homeNormal[0], [7, 7, 12], 'Neon normal, black is the canvas');
          near(homeNormal[1], [255, 61, 168], 'Neon normal, grey is the magenta');
          near(homeNormal[2], [243, 241, 255], 'Neon normal, white is the ink');
          near(inboxNormal[0], [243, 241, 255], 'Neon normal, a line-only icon\'s ink glows');
        }
        // People's key (yellow): a fourth tint's filter, its grey on the yellow.
        const people = await drawn(p, '.loom-dock-bar [aria-label="People"] img.loom-pix', [5]);
        near(people[0], keyColours(t, 'yellow' as never).tint, 'People normal, its grey is the yellow');

        // Higher contrast: a stronger ramp, its ends pushed to black and white.
        await p.evaluate(() => { document.documentElement.dataset.contrast = 'more'; });
        const more = rampFor(keyColours(await tokens(p), 'pink'), false, true);
        const homeMore = await drawn(p, '.loom-dock-bar [aria-label="Home"] img.loom-pix', [5, 15, 26]);
        near(homeMore[0], more[0], 'Home, more contrast, its black');
        near(homeMore[1], mapPixel([128, 128, 128], more, false, true), 'Home, more contrast, its grey');
        near(homeMore[2], more[2], 'Home, more contrast, its white');
        await ctx.close();
      }, 60_000);
    }

    it('nothing wider than a 390 px phone, in any look', async () => {
      for (const look of ['neon', 'lowlight', 'daylight']) {
        const p = await open(390, { icons: true, look });
        for (const at of ['/', '/places', '/setup', '/appearance', '/inbox']) {
          await p.goto(`${base}${at}`);
          await p.locator('.loom-dock-bar img.loom-pix').first().waitFor();
          // Every key, every icon and the page's own content inside the screen. (The dock's scroller itself reaches 18 px past
          // each edge, clipped, with or without pixel icons: room for a key magnified under a pointer. A row of chips scrolls
          // sideways in its own box, clipped: the row is inside the screen, the chips past its edge aren't drawn there.)
          const { scroll, over } = await p.evaluate(() => ({ scroll: document.documentElement.scrollWidth,
            over: [...document.querySelectorAll('.loom-dock-bar [data-part="item"], .loom-dock-bar [data-part="visual"], .loom-pix, main *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > innerWidth + 0.5 && !e.parentElement?.closest('.loom-split__chips'); })
              .map((e) => `${e.tagName.toLowerCase()}.${String((e as HTMLElement).className).split(' ')[0]}`) }));
          expect(scroll, `${look} ${at}: the page`).toBeLessThanOrEqual(390);
          expect(over, `${look} ${at}: past the right edge`).toEqual([]);
        }
        await ctx.close();
      }
    }, 60_000);

    it('with no set in use, Appearance doesn\'t offer it and every app has its line icon', async () => {
      expect((await cli('icons', 'use', 'none')).code).toBe(0);
      const p = await open(1280, { icons: true });
      await p.goto(`${base}/appearance`);
      await p.locator('[aria-label="Look"]').waitFor();
      expect(await p.locator('[aria-label="Pixel icons"]').count()).toBe(0);
      expect(await p.locator('img.loom-pix').count()).toBe(0);
      await ctx.close();
      expect((await cli('icons', 'use', 'test')).code).toBe(0);
    }, 60_000);
  });
});
