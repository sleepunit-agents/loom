/**
 * The Inbox as a mail client (t-1925, Jonathan's approved mock 2026-11-06; docs/specs/ui-app.md, "Master/detail"):
 * folders | list | reader in a big tile, the folders as chips and the reader over the list in a narrow tile and on a
 * phone. Picking an item shows it without a reload; Done answers it and moves it out of Needs you; an ask answered
 * elsewhere never shows live buttons and never sends. Real Chrome, Neon Noir.
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
import { answerNeeds, createConversationTables, recordTurn, writeDigest } from '../backends/conversations.js';
import { changed } from './live.js';
import { closeAllBackends } from '../backends/index.js';

const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);
const expect = Object.assign(((v: unknown, m?: string) => vexpect(v, m)) as typeof vexpect, vexpect,
  { poll: (f: () => unknown, o?: { timeout?: number }) => vexpect.poll(f, { timeout: 10_000, ...o }) }) as typeof vexpect;

describe.runIf(built && chrome)('the Inbox, a mail client', () => {
  let h: Household;
  let handle: HttpServeHandle;
  let browser: Browser;
  let base: string;
  let token: string;
  const saved: Record<string, string | undefined> = {};
  let n = 0;

  /** A new ask from Art: a yes/no question in its own conversation. Returns where it lives, to answer it elsewhere. */
  function ask(text: string): { conversation: string; digest: string } {
    const art = agentDir(h, 'art');
    const conv = recordTurn(art, 'art', { venue: 'wake', place: `lane:t${++n}`, label: `t-${900 + n}: ${text}`, at: new Date().toISOString(), from: { kind: 'schedule' }, kind: 'wake' }, 'runtime:clock').conversation;
    const d = writeDigest(art, { conversation: conv, run: `r${n}` }, { summary: 'Checked.', needs_owner: { ask: text, why: `Because ${text.toLowerCase()} matters.`, if_yes: 'I do it tonight.', if_no: 'I leave it as it is.' } } as never);
    return { conversation: conv, digest: d.id };
  }

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), 'loom-inbox-app-'));
    for (const a of ['art', 'mark']) {
      mkdirSync(join(home, 'agents', a), { recursive: true });
      writeFileSync(join(home, 'agents', a, 'IDENTITY.md'), `# ${a}\n`);
      const db = new BetterSqlite3(join(home, 'agents', a, 'memories.db')); createConversationTables(db); db.close();
    }
    writeFileSync(join(home, 'household.json'), JSON.stringify({ v: 1, agents: ['art', 'mark'], default: 'art', owner: 'jonathan' }));
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
    await handle?.close();
    await closeAllBackends();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (h) rmSync(h.home, { recursive: true, force: true });
  });

  async function screen(width: number, height: number, path: string, touch = false, still = false): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', serviceWorkers: 'block', ...(touch ? { hasTouch: true, isMobile: true } : {}) });
    await ctx.addInitScript(`if (!sessionStorage.getItem('t')) { sessionStorage.setItem('t', '1'); localStorage.setItem('loom-look', 'neon'); } sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
    await ctx.request.post(`${base}/login`, { form: { token }, maxRedirects: 0 });
    const p = await ctx.newPage();
    // Still: no live stream, so the page keeps the copy it has (a stale one, for the tests that answer behind it).
    if (still) await p.route('**/events', (r) => r.abort());
    await p.goto(`${base}${path}`);
    await p.locator('.loom-split').waitFor();
    await p.waitForTimeout(300);
    // A marker on the window: a full reload would lose it.
    await p.evaluate(() => { (window as unknown as { kept: number }).kept = 1; });
    return p;
  }
  const mode = (p: Page) => p.locator('.loom-inbox').getAttribute('data-mode');
  const kept = (p: Page) => p.evaluate(() => (window as unknown as { kept?: number }).kept);
  const row = (p: Page, words: string) => p.locator('[data-split-row]', { hasText: words });
  const reader = '.loom-split__reader';
  /** Screenshots for a PR's evidence, when LOOM_SHOTS names a directory. */
  const shot = async (p: Page, name: string) => { if (process.env.LOOM_SHOTS) await p.screenshot({ path: join(process.env.LOOM_SHOTS, `${name}.png`) }); };

  it('an open ask keeps its computed colours and enabled buttons through repeated events and rechecks', async () => {
    ask('Keep these answer buttons steady?');
    const p = await screen(1280, 800, '/inbox?t=*inbox');
    await row(p, 'Keep these answer buttons steady?').click();
    const buttons = p.locator(`${reader} button`).filter({ hasText: /^(Yes|No|Done)$/ });
    await expect.poll(() => buttons.count()).toBe(3);
    await p.evaluate((selector) => {
      const w = window as unknown as { samples: string[]; sample: () => void; baseline: string };
      w.samples = [];
      w.sample = () => {
        const values = Array.from(document.querySelectorAll<HTMLButtonElement>(`${selector} button`))
          .filter((b) => /^(Yes|No|Done)$/.test(b.textContent ?? ''))
          .map((b) => { const s = getComputedStyle(b); return [b.textContent, b.disabled, s.color, s.backgroundColor, s.opacity]; });
        const value = JSON.stringify(values);
        if (value !== w.baseline) w.samples.push(value);
      };
      w.sample(); w.baseline = w.samples.pop()!;
      const frame = () => { w.sample(); requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
    }, reader);
    let pages = 0, checks = 0;
    // Hold both checks in flight so a pending refresh lasts many browser frames.
    await p.route((url) => url.pathname === '/inbox', async (r) => {
      if (!r.request().headers().accept?.includes('application/json')) return r.continue();
      pages++; await new Promise((resolve) => setTimeout(resolve, 250)); await r.continue();
    });
    await p.route('**/inbox/open?*', async (r) => {
      checks++; await new Promise((resolve) => setTimeout(resolve, 250)); await r.continue();
    });
    for (let n = 0; n < 3; n++) {
      const before = pages;
      changed();
      await expect.poll(() => pages).toBeGreaterThan(before);
      await p.waitForTimeout(350);
    }
    // Picking the same ask is another background check, not a reason to remove its buttons.
    await row(p, 'Keep these answer buttons steady?').click();
    await p.waitForTimeout(350);
    expect(await p.evaluate(() => (window as unknown as { samples: string[] }).samples)).toEqual([]);
    expect(checks).toBeGreaterThanOrEqual(4);
    for (const b of await buttons.all()) expect(await b.isEnabled()).toBe(true);
    await p.context().close();
  });

  it('a send-time check leaves the other answers bright and prevents a second answer', async () => {
    ask('Wait for the check before sending?');
    const p = await screen(1280, 800, '/inbox?t=*inbox', false, true);
    await row(p, 'Wait for the check before sending?').click();
    const yes = p.locator(`${reader} button:text-is("Yes")`);
    await yes.waitFor();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let checks = 0, posts = 0;
    await p.route('**/inbox/open?*', async (r) => { checks++; await held; await r.fulfill({ json: { open: true } }); });
    await p.route('**/act/**', (r) => { posts++; return r.fulfill({ json: { ok: true } }); });
    const no = p.locator(`${reader} button:text-is("No")`);
    const appearance = () => no.evaluate((b) => { const s = getComputedStyle(b); return [s.color, s.backgroundColor, (b as HTMLButtonElement).disabled]; });
    const before = await appearance();
    await yes.click();
    await expect.poll(() => checks).toBe(1);
    expect(posts).toBe(0);
    expect(await appearance()).toEqual(before);
    await p.locator(`${reader} button:text-is("Done")`).click();
    expect(checks).toBe(1);
    expect(posts).toBe(0);
    release();
    await expect.poll(() => posts).toBe(1);
    await p.context().close();
  });

  for (const [w, hgt] of [[1280, 800], [1920, 1080]] as const) {
    it(`a big Inbox tile is three panes; picking an item reads it without a reload; Done moves it out of Needs you, at ${w}×${hgt}`, async () => {
      const a = ask(`Rotate the backup key ${w}?`);
      ask(`Turn off the recycle bin ${w}?`);
      const p = await screen(w, hgt, '/inbox?t=*inbox');
      await expect.poll(() => mode(p)).toBe('three');
      // The folders, as the mock has them, and who it's from.
      const folders = await p.locator('.loom-split__nav .loom-split__folder-name').allTextContents();
      expect(folders.slice(0, 6)).toEqual(['Needs you', 'Questions', 'Approvals', 'Alerts', 'Memory reviews', 'Done']);
      expect(folders.map((f) => f.toLowerCase())).toContain('art');
      await row(p, `Rotate the backup key ${w}?`).click();
      await expect.poll(() => p.locator(`${reader} h2`).textContent()).toBe(`Rotate the backup key ${w}?`);
      // The whole ask: why, what happens either way, where it lives and its trail.
      await expect.poll(() => p.locator(reader).textContent()).toMatch(/I do it tonight\./);
      expect(await p.locator(reader).textContent()).toMatch(/I leave it as it is\./);
      expect(await p.locator(`${reader} [aria-label="Trail"]`).textContent()).toMatch(/art asked/i);
      expect(await p.locator(`${reader} [aria-label="Where it lives"]`).textContent()).toMatch(/The conversation/);
      expect(await kept(p)).toBe(1);
      // Live once loom says it's open: Yes, No, Done.
      await p.locator(`${reader} button:text-is("Done")`).waitFor();
      await shot(p, `after-inbox-${w}`);
      expect(await p.locator(`${reader} button:text-is("Yes")`).count()).toBe(1);
      // Done answers it: out of Needs you, and loom says it's answered.
      await p.locator(`${reader} button:text-is("Done")`).click();
      await expect.poll(() => row(p, `Rotate the backup key ${w}?`).count()).toBe(0);
      const inbox = await p.evaluate(async () => ((await (await fetch('/inbox', { headers: { accept: 'application/json' } })).json()) as { items: Array<{ text: string; attention: boolean; box: string }> }).items);
      expect(inbox.filter((i) => i.text === `Rotate the backup key ${w}?`).every((i) => !i.attention)).toBe(true);
      void a;
      // Done holds it now.
      await p.locator('.loom-split__nav .loom-split__folder', { hasText: 'Done' }).click();
      await expect.poll(() => row(p, `Rotate the backup key ${w}?`).count()).toBe(1);
      expect(await kept(p)).toBe(1);
      expect(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      await p.context().close();
    });
  }

  it('the folder is in the address: a reload keeps it, and back and forward step through the folders (t-1925)', async () => {
    ask('Keep the folder in the address?');
    const p = await screen(1280, 800, '/inbox?t=*inbox');
    const current = () => p.locator('.loom-split__nav .loom-split__folder[aria-current="true"] .loom-split__folder-name').textContent();
    await expect.poll(current).toBe('Needs you');
    await p.locator('.loom-split__nav .loom-split__folder', { hasText: 'Questions' }).click();
    await expect.poll(current).toBe('Questions');
    await expect.poll(() => p.evaluate(() => new URL(location.href).searchParams.get('f'))).toBe('question');
    // Within the app: no reload.
    expect(await kept(p)).toBe(1);
    await p.locator('.loom-split__nav .loom-split__folder', { hasText: /^art/i }).click();
    await expect.poll(() => p.evaluate(() => new URL(location.href).searchParams.get('f'))).toBe('from:art');
    await p.reload();
    await p.locator('.loom-split').waitFor();
    await expect.poll(current).toMatch(/^art$/i);
    await p.goBack();
    await expect.poll(current).toBe('Questions');
    await p.goBack();
    await expect.poll(current).toBe('Needs you');
    await p.goForward();
    await expect.poll(current).toBe('Questions');
    await p.context().close();
  });

  it('an ask answered elsewhere never shows live buttons and never sends', async () => {
    const a = ask('Merge the launcher change?');
    const p = await screen(1280, 800, '/inbox?t=*inbox', false, true);
    // Answered somewhere else while this page holds its copy.
    answerNeeds(agentDir(h, 'art'), { conversation: a.conversation, digest: a.digest, verdict: 'done', by: 'jonathan' });
    let posts = 0;
    p.on('request', (r) => { if (r.method() === 'POST' && /\/act\//.test(r.url())) posts++; });
    await row(p, 'Merge the launcher change?').click();
    // Said, whichever comes first: loom's check (not open any more), or loom's newer page without it (not here any more).
    await expect.poll(() => p.locator(`${reader} [role="status"]`).first().textContent()).toMatch(/isn’t (open|here) any more/);
    expect(await p.locator(`${reader} button:text-is("Done")`).count()).toBe(0);
    expect(await p.locator(`${reader} button:text-is("Yes")`).count()).toBe(0);
    expect(posts).toBe(0);
    await p.context().close();
  });

  it('a live ask answered elsewhere after it was checked: its button asks again and sends nothing', async () => {
    const a = ask('Allow the nightly prune?');
    const p = await screen(1280, 800, '/inbox?t=*inbox', false, true);
    await row(p, 'Allow the nightly prune?').click();
    await p.locator(`${reader} button:text-is("Done")`).waitFor();
    answerNeeds(agentDir(h, 'art'), { conversation: a.conversation, digest: a.digest, verdict: 'done', by: 'jonathan' });
    let posts = 0;
    p.on('request', (r) => { if (r.method() === 'POST' && /\/act\//.test(r.url())) posts++; });
    await p.locator(`${reader} button:text-is("Done")`).click();
    await expect.poll(() => p.locator(`${reader} [role="status"]`).first().textContent()).toMatch(/isn’t (open|here) any more/);
    expect(await p.locator(`${reader} button:text-is("Done")`).count()).toBe(0);
    expect(posts).toBe(0);
    await p.context().close();
  });

  it('a narrow tile (Comms and the Inbox side by side at 1280) has chips, and the reader slides over the list with a way back', async () => {
    ask('Sign Claude Code in again?');
    const p = await screen(1280, 800, '/inbox?t=*inbox,comms');
    const width = await p.locator('.loom-inbox').evaluate((e) => e.getBoundingClientRect().width);
    expect(width).toBeLessThan(640);
    await expect.poll(() => mode(p)).toBe('one');
    await shot(p, 'after-inbox-narrow');
    expect(await p.locator('.loom-split__chips button').first().textContent()).toMatch(/Needs you/);
    expect(await p.locator(reader).count()).toBe(0);
    await row(p, 'Sign Claude Code in again?').click();
    await expect.poll(() => p.locator(`${reader} h2`).textContent()).toBe('Sign Claude Code in again?');
    await shot(p, 'after-inbox-narrow-open');
    // Over the list, in the tile: its box is the list's.
    const [r, l] = await Promise.all([p.locator(reader).boundingBox(), p.locator('.loom-split__list').boundingBox()]);
    expect(Math.abs(r!.x - l!.x)).toBeLessThan(2);
    await p.keyboard.press('Escape');
    await expect.poll(() => p.locator(reader).count()).toBe(0);
    await expect.poll(() => p.evaluate(() => document.activeElement?.hasAttribute('data-split-row'))).toBe(true);
    expect(await kept(p)).toBe(1);
    await p.context().close();
  });

  it('a phone (390) is one pane: chips, the list, then the item with Back', async () => {
    ask('Keep the old notes tree?');
    const p = await screen(390, 844, '/inbox', true);
    await expect.poll(() => mode(p)).toBe('one');
    await row(p, 'Keep the old notes tree?').tap();
    await expect.poll(() => p.locator(`${reader} h2`).textContent()).toBe('Keep the old notes tree?');
    await p.locator('#loom-reply').waitFor();
    await shot(p, 'after-inbox-390');
    expect(await p.locator('.loom-split__list').isVisible()).toBe(false);
    await p.locator('.loom-split__back').tap();
    await expect.poll(() => p.locator('.loom-split__list').isVisible()).toBe(true);
    expect(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await p.context().close();
  });

  it('a stamped answer (a kept copy, x-loom-saved-at) is "can not tell": no live buttons', async () => {
    ask('Reboot the field box?');
    const p = await screen(1280, 800, '/inbox?t=*inbox', false, true);
    await p.route('**/inbox/open?*', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'x-loom-saved-at': new Date().toISOString() }, body: '{"open":true}' }));
    await row(p, 'Reboot the field box?').click();
    await expect.poll(() => p.locator(`${reader} [role="status"]`).first().textContent()).toMatch(/Can’t check with loom/);
    expect(await p.locator(`${reader} button:text-is("Done")`).count()).toBe(0);
    expect(await p.locator(`${reader} button:text-is("Yes")`).count()).toBe(0);
    await p.context().close();
  });

  it('two panes between 640 and 900 px (Inbox beside Comms and the agents\' rail at 1920): chips over the list, the reader beside it; ↑ and ↓ read each in turn', async () => {
    ask('Rename the pond repo?');
    ask('Move the backups to Tuesday?');
    const p = await screen(1920, 1080, '/inbox?t=*inbox,comms');
    const width = await p.locator('.loom-inbox').evaluate((e) => e.getBoundingClientRect().width);
    expect(width).toBeGreaterThanOrEqual(640);
    expect(width).toBeLessThan(900);
    await expect.poll(() => mode(p)).toBe('two');
    expect(await p.locator('.loom-split__chips').count()).toBe(1);
    expect(await p.locator('.loom-split__nav').count()).toBe(0);
    const [r, l] = await Promise.all([p.locator(reader).boundingBox(), p.locator('.loom-split__list').boundingBox()]);
    expect(r!.x).toBeGreaterThanOrEqual(l!.x + l!.width - 1);
    await p.locator('[data-split-row]').first().focus();
    await p.keyboard.press('ArrowDown');
    const second = await p.locator('[data-split-row]').nth(1).locator('.loom-split__title').textContent();
    await expect.poll(() => p.locator(`${reader} h2`).textContent()).toBe(second);
    await p.keyboard.press('ArrowUp');
    const first = await p.locator('[data-split-row]').first().locator('.loom-split__title').textContent();
    await expect.poll(() => p.locator(`${reader} h2`).textContent()).toBe(first);
    expect(await kept(p)).toBe(1);
    await p.context().close();
  });

});
