/**
 * The Projects index as a card per project (docs/specs/projects.md, "The index"; t-1925): in real Chrome, each card
 * answers the same questions in the same places (status, what it is, what's waiting on you from a feed's `waiting`
 * group, what happened lately, an activity line, open changes with their CI, repos, people); two columns in a big
 * window (1280 and 1920), one in a narrow tile beside others and on a 390 px phone; a card opens the project's hub
 * inside the app, with no page load.
 *
 * Runs where the app is built (npm run build) and a Chrome is installed (GitHub's runners have one).
 */
import { describe, it, expect as vexpect, beforeAll, afterAll, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startHttpServer, type HttpServeHandle } from '../transport/http-server.js';
import { createToken, loadHousehold, type Household } from '../household.js';
import { closeAllBackends } from '../backends/index.js';
import { openProjectsStore, type ProjectWriteInput } from '../backends/projects.js';
import { clearPieceCache } from './pieces.js';
import { forgetProjectCounts } from './projects-pages.js';

const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);
const expect = Object.assign(((v: unknown, m?: string) => vexpect(v, m)) as typeof vexpect, vexpect,
  { poll: (f: () => unknown, o?: { timeout?: number }) => vexpect.poll(f, { timeout: 10_000, ...o }) }) as typeof vexpect;
const SHOTS = process.env.LOOM_PROJECTS_SHOTS;

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z');

/** The Changes piece's feed, as loom-changes answers it: a waiting group, an open change with red CI, one merged. */
const FEED = { groups: [
  { title: 'Waiting on you', waiting: true, items: [{ title: 'app#12 Launcher replaces More', status: 'Waiting on you', when: hoursAgo(1), who: ['Art'], page: 'c/github/acme/app/12' }] },
  { title: 'Waiting on its author', items: [{ title: 'app#11 Wake drift under load', status: 'CI red', when: hoursAgo(5), who: ['Mark'], page: 'c/github/acme/app/11' }] },
  { title: 'Lately', items: [{ title: 'app#9 Tiling is the only desktop', status: 'Merged', when: hoursAgo(30), who: ['Art'], page: 'c/github/acme/app/9' }] },
] };

describe.runIf(built && chrome)('the Projects index: a card per project', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    clearPieceCache();
    forgetProjectCounts();
    const home = mkdtempSync(join(tmpdir(), 'loom-projects-cards-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', owner: 'jonathan' }));
    // A managed Changes piece whose feed answers only for the repo acme/app.
    const pieces = join(home, 'managed', 'pieces');
    mkdirSync(join(pieces, 'changes'), { recursive: true });
    mkdirSync(join(pieces, 'bin'), { recursive: true });
    writeFileSync(join(home, 'feed.json'), JSON.stringify(FEED));
    writeFileSync(join(pieces, 'bin', 'loom-changes'), `#!/bin/sh\n[ "$1" = project-feed ] || exit 2\ncase " $* " in *" --repo github:acme/app "*) cat ${join(home, 'feed.json')};; *) echo '{"groups":[]}';; esac\n`);
    chmodSync(join(pieces, 'bin', 'loom-changes'), 0o755);
    writeFileSync(join(pieces, 'changes', 'piece.json'), JSON.stringify({
      v: 1, name: 'changes', source: { repo: 'o/r', commit: '1'.repeat(40) }, package: 'changes', version: '1.0.0', installed: '', bins: ['loom-changes'],
      loom: { settings: [], services: [], sections: { project: { label: 'Changes', argv: ['loom-changes', 'project-feed', '--json'] } } },
    }));
    for (const k of ['LOOM_HOME', 'XDG_CONFIG_HOME', 'PATH']) saved[k] = process.env[k];
    process.env.LOOM_HOME = join(home, 'managed');
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    process.env.PATH = ['/usr/bin', '/bin'].join(':');
    const write = (agent: string, input: ProjectWriteInput) => {
      const s = openProjectsStore(join(home, 'agents', agent))!;
      try { s.write(input); } finally { s.close(); }
    };
    write('art', { slug: 'app', name: 'The App', summary: 'The household\'s app: agents, memory and the desktop. It has a long tail of detail.',
      links: { repos: ['acme/app', 'acme/app-clock', 'acme/app-box', 'acme/app-secrets', 'acme/app-approvals', 'acme/app-changes', 'acme/app-docs', 'acme/app-site'] } });
    write('art', { slug: 'pond', name: 'pond', summary: 'Field sensors and daily site reports.', links: { repos: ['acme/pond'] } });
    write('mark', { slug: 'hocket', name: 'Hocket', summary: 'A generative hocketing MIDI plugin.' });
    write('art', { slug: 'old', name: 'Old thing', status: 'done', summary: 'Finished.' });
    h = loadHousehold(home)!;
    token = createToken(h, { role: { kind: 'owner' }, label: 'jonathan' }).token;
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

  async function screen(width: number, height: number, path: string, o: { phone?: boolean } = {}): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', serviceWorkers: 'block',
      ...(o.phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
    await ctx.addInitScript(`if (!sessionStorage.getItem('t')) { sessionStorage.setItem('t', '1'); localStorage.setItem('loom-look', 'neon'); } sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    await p.goto(`${base}${path}`);
    await p.locator('.pj-card').first().waitFor({ timeout: 15_000 });
    await p.waitForTimeout(300);
    return p;
  }
  /** Each active card's box, in order. */
  const boxes = (p: Page) => p.$$eval('.pj-grid[aria-label="Active projects"] .pj-card', (cs) => cs.map((c) => {
    const r = c.getBoundingClientRect(); return { slug: c.getAttribute('data-slug'), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) };
  }));
  const columns = async (p: Page) => new Set((await boxes(p)).map((b) => b.x)).size;
  const noSideScroll = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

  for (const [w, hgt] of [[1280, 800], [1920, 1080]] as const) {
    it(`two columns of cards in a big window, each answering the same questions, at ${w}×${hgt}`, async () => {
      const p = await screen(w, hgt, '/projects?t=*projects');
      expect(await p.locator('.loom-tile').count()).toBe(1);
      await expect.poll(() => columns(p)).toBe(2);
      const b = await boxes(p);
      // Waiting on you first: The App has a waiting change.
      expect(b[0].slug).toBe('app');
      expect(b[0].y).toBe(b[1].y);
      const app = p.locator('.pj-card[data-slug="app"]');
      expect(await app.locator('.pj-pill').innerText()).toMatch(/active/i);
      expect(await app.locator('.pj-what').innerText()).toBe("The household's app: agents, memory and the desktop.");
      // What's waiting on you, from the feed's waiting group: the loudest thing on the card.
      expect(await app.locator('.pj-wait').innerText()).toMatch(/^1 for you\s+app#12 Launcher replaces More$/);
      // What's waiting is said once, in its row; Lately is the rest.
      expect(await app.locator('.pj-acts li').allInnerTexts()).toEqual([
        expect.stringMatching(/^app#11 Wake drift under load · CI red\s+5h$/),
        expect.stringMatching(/^app#9 Tiling is the only desktop · Merged\s+30h$/)]);
      expect(await app.locator('.pj-spark').getAttribute('aria-label')).toMatch(/^3 things happened in the last 7 days/);
      expect(await app.locator('.pj-chg').innerText()).toMatch(/2 open · 1 failing/);
      expect(await app.locator('.pj-repos li').allInnerTexts()).toEqual(['acme/app', 'acme/app-clock', 'acme/app-box', 'acme/app-secrets', 'acme/app-approvals', 'acme/app-changes', '+2']);
      expect(await app.locator('.pj-faces').getAttribute('aria-label')).toMatch(/^People: art, mark$/i);
      expect(await app.locator('.pj-face [data-slot="avatar-fallback"]').count()).toBe(0);   // both agents wear their faces
      // Nothing waiting is said quietly; a project with no dated activity has no line.
      const pond = p.locator('.pj-card[data-slug="pond"]');
      expect(await pond.locator('.pj-wait').innerText()).toBe('Nothing waiting on you');
      expect(await pond.locator('.pj-spark').count()).toBe(0);
      expect(await pond.locator('.pj-chg').innerText()).toMatch(/0 open/);
      // Paused and done, folded.
      expect(await p.locator('.pj-quiet').getAttribute('open')).toBeNull();
      expect(await noSideScroll(p)).toBe(true);
      if (SHOTS) await p.screenshot({ path: join(SHOTS, `projects-${w}.png`) });
      await p.context().close();
    });
  }

  it('one column in a narrow tile beside others, at 1280×800', async () => {
    const p = await screen(1280, 800, '/projects?t=inbox,setup,*projects');
    const tile = p.locator('.loom-tile[aria-label$=", Projects"]');
    const tw = await tile.evaluate((t) => Math.round(t.getBoundingClientRect().width));
    expect(tw).toBeLessThan(640);
    await expect.poll(() => columns(p)).toBe(1);
    expect(await tile.locator('.pj-card[data-slug="app"] .pj-wait').innerText()).toMatch(/^1 for you/);
    if (SHOTS) await p.screenshot({ path: join(SHOTS, `projects-tile-${tw}.png`) });
    await p.context().close();
  });

  it('one column on a 390 px phone, with nothing scrolling sideways', async () => {
    const p = await screen(390, 844, '/projects', { phone: true });
    await expect.poll(() => columns(p)).toBe(1);
    const b = await boxes(p);
    expect(b[0].w).toBeGreaterThan(300);
    expect(await noSideScroll(p)).toBe(true);
    if (SHOTS) await p.screenshot({ path: join(SHOTS, 'projects-390.png'), fullPage: true });
    await p.context().close();
  });

  it('a card opens its hub inside the app, with no page load', async () => {
    const p = await screen(1280, 800, '/projects?t=*projects');
    await p.evaluate(() => { (window as unknown as { marker: number }).marker = 1; });
    await p.locator('.pj-card[data-slug="app"]').click({ position: { x: 300, y: 120 } });   // anywhere on the card
    await expect.poll(() => new URL(p.url()).pathname).toBe('/projects/art/app');
    await p.locator('.loom-tile').getByText('app#11 Wake drift under load').first().waitFor();
    expect(await p.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(1);
    expect(await p.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(1);
    await p.context().close();
  });
});
