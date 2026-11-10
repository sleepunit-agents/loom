/**
 * The agent-centric desktop (docs/specs/agent-desk.md; t-1959), in a real browser. Home (nothing open) is a slim Needs
 * you band and a big card per agent: the viewer's own agents only, always there, alphabetical by name; each card has its
 * face, how it is, what it's on, its last thread, its next wake, what's unread (a count and the first line, opening that
 * thread), an ask badge and a composer that starts a thread in Comms. Work (apps open) is the tiles beside a
 * fixed-width rail: Needs you with its count and top item, then a compact card per agent, no composer. At 1280, 1440
 * and 1920, in all three looks. Needs the `age` programs (Comms' words are encrypted).
 *
 * Runs where the app is built (npm run build) and a Chrome is installed (GitHub's runners have one).
 */
import { describe, it, expect as vexpect, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright-core';
import { deskHome, type DeskHome } from './agent-desk.fixture.js';
import type { Thread } from '../comms.js';

vi.setConfig({ testTimeout: 90_000 });
const root = new URL('../../', import.meta.url).pathname;
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const built = existsSync(`${root}dist/web/index.html`);
const hasAge = spawnSync('sh', ['-c', 'command -v age && command -v age-keygen'], { encoding: 'utf-8' }).status === 0;
const SHOTS = process.env.LOOM_DESK_SHOTS;
const expect = Object.assign(((v: unknown, m?: string) => vexpect(v, m)) as typeof vexpect, vexpect,
  { poll: (f: () => unknown, o?: { timeout?: number }) => vexpect.poll(f, { timeout: 10_000, ...o }) }) as typeof vexpect;
const LOOKS = ['neon', 'lowlight', 'daylight'] as const;
const SIZES = [[1280, 800], [1440, 900], [1920, 1080]] as const;

describe.runIf(built && chrome && hasAge)('the agent-centric desktop', () => {
  let d: DeskHome;
  let browser: Browser;
  let plan: Thread;
  let backup: Thread;
  const errors: string[] = [];

  beforeAll(async () => {
    if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    // Out of alphabetical order on purpose: the household's order is mark, art, nova.
    d = await deskHome({ mark: 'Visual Mark', art: 'Art E Fish', nova: 'Nova' }, [{ person: 'jonathan', agents: '*' }, { person: 'sam', agents: ['mark'] }]);
    const now = new Date().toISOString();
    d.report({
      art: { doing: [{ text: 'Making the field box installer survive power loss', kind: 'lane', where: 'wake', since: now }], readings: [{ label: 'Next', value: 'tonight · 03:00', detail: 'backup check' }] },
      mark: { readings: [{ label: 'Next', value: 'Sun · 21:00', detail: 'weekly plan' }] },
    });
    plan = d.thread('jonathan', 'mark', 'Can you plan next week around the field box trip?', 'Plan for the week');
    d.reply(plan, 'On it. I’ll keep Wednesday clear and move the house jobs around it.');
    d.reply(plan, 'Ready for your review: the plan for the week is in your notes.');
    backup = d.thread('jonathan', 'art', 'Can the nightly backup go offsite?', 'An offsite copy for the backup');
    // Sam's own thread with Mark: never Jonathan's unread.
    const sams = d.thread('sam', 'mark', 'Sam here.', 'Sam’s thread');
    d.reply(sams, 'Only for Sam.');
    d.ask('art', 'OK to clear the stale lock and run the backup now?');
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  }, 90_000);
  afterAll(async () => { await browser?.close(); await d?.close(); });

  async function screen(w: number, h: number, path: string, o: { look?: string; who?: string; sw?: boolean } = {}): Promise<Page> {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: 'reduce', serviceWorkers: o.sw ? 'allow' : 'block' });
    await ctx.addInitScript(`localStorage.setItem('loom-look', '${o.look ?? 'neon'}'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
    await ctx.request.post(`${d.base}/login`, { form: { token: d.tok[o.who ?? 'jonathan'] }, maxRedirects: 0 });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${d.base}${path}`);
    return p;
  }
  const card = (p: Page, id: string) => p.locator(`.loom-bigcard[data-agent="${id}"]`);
  const rail = (p: Page, id: string) => p.locator(`.loom-arail .loom-rcard[data-agent="${id}"]`);
  const labels = (p: Page) => p.$$eval('.loom-tile', (ts) => ts.map((t) => (t.getAttribute('aria-label') ?? '').replace(/^tile \d+ of \d+, /, '')));
  /** Nothing of `sel` past its own box, and the page never scrolls. */
  const tidy = (p: Page, sel: string) => p.evaluate((s) => {
    const bad: string[] = [];
    for (const f of document.querySelectorAll(s)) {
      const b = f.getBoundingClientRect();
      for (const e of f.querySelectorAll('*')) {
        const cs = getComputedStyle(e);
        if (cs.display === 'contents' || cs.visibility === 'hidden') continue;
        const r = e.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        let clip = false;
        for (let a = e.parentElement; a && a !== f; a = a.parentElement) { const o = getComputedStyle(a); if (/(hidden|auto|scroll|clip)/.test(o.overflow)) { clip = true; break; } }
        if (!clip && (r.left < b.left - 1 || r.right > b.right + 1 || r.top < b.top - 1 || r.bottom > b.bottom + 1)) bad.push(`${s} ${e.className}`);
      }
    }
    const de = document.documentElement;
    if (de.scrollWidth > innerWidth || de.scrollHeight > innerHeight) bad.push(`page scrolls ${de.scrollWidth}x${de.scrollHeight}`);
    return bad;
  }, sel);

  for (const look of LOOKS) for (const [w, h] of SIZES) {
    it(`Home at ${w}×${h} (${look}): Needs you, then a big card per agent, alphabetical, each with its facts and a composer`, async () => {
      const p = await screen(w, h, '/', { look });
      await card(p, 'art').waitFor();
      await expect.poll(() => p.$$eval('.loom-bigcard', (cs) => cs.map((c) => c.getAttribute('data-agent')))).toEqual(['art', 'nova', 'mark']);
      // Needs you: one line over the cards, its count, the ask answerable in a line.
      const band = p.locator('.loom-needs-band');
      expect(await band.locator('.loom-needs-band__lab').textContent()).toBe('NEEDS YOU · 1');
      await band.getByRole('button', { name: 'Yes', exact: true }).waitFor();
      const bb = (await band.boundingBox())!;
      const cb = (await card(p, 'art').boundingBox())!;
      expect(bb.y + bb.height).toBeLessThan(cb.y);
      expect(bb.height).toBeLessThan(80);
      // Art: waiting on you (its ask), what it's on, its last thread, its next wake, its ask, nothing new.
      const art = card(p, 'art');
      expect(await art.locator('.loom-bigcard__eb').textContent()).toMatch(/waiting on you/i);
      expect(await art.locator('.loom-askb').textContent()).toBe('ASKS YOU');
      expect(await art.locator('[data-row="now"] dd').textContent()).toBe('Making the field box installer survive power loss');
      await expect.poll(() => art.locator('[data-row="last"] dd').textContent()).toMatch(/^An offsite copy for the backup · /);
      if (await art.locator('[data-row="wake"]').count()) expect(await art.locator('[data-row="wake"] dd').textContent()).toBe('tonight · 03:00 · backup check');
      expect(await art.locator('[data-kind="ask"]').textContent()).toContain('OK to clear the stale lock');
      // Mark: quiet, one thread with new replies (unread counts threads: the owner's decision, collections.md "Owner
      // decisions" 3; the replies are the thread's own count) and the first one's line; Sam's thread never counts.
      const mark = card(p, 'mark');
      expect(await mark.locator('.loom-bigcard__eb').textContent()).toMatch(/quiet/i);
      await expect.poll(() => mark.locator('[data-kind="unread"]').textContent()).toBe('1 new‘On it. I’ll keep Wednesday clear and move the house jobs around it.’');
      // Nova: nothing at all yet, said plainly.
      expect(await card(p, 'nova').locator('[data-kind="none"]').textContent()).toBe('No new messages');
      for (const id of ['art', 'mark', 'nova']) expect(await card(p, id).locator('input[aria-label^="Message"]').count()).toBe(1);
      // The cards fill the desktop between the band and the dock, side by side.
      const tops = await p.$$eval('.loom-bigcard', (cs) => cs.map((c) => Math.round(c.getBoundingClientRect().top)));
      expect(new Set(tops).size).toBe(1);
      expect(await tidy(p, '.loom-bigcard')).toEqual([]);
      expect(await p.locator('[data-widget], .loom-arail').count()).toBe(0);
      if (SHOTS) await p.screenshot({ path: `${SHOTS}/home-${look}-${w}.png` });
      await p.context().close();
    });

    it(`Work at ${w}×${h} (${look}): the tiles beside a fixed-width rail of Needs you and compact cards, no composer`, async () => {
      const p = await screen(w, h, '/inbox?t=*inbox');
      await rail(p, 'art').waitFor();
      const r = (await p.locator('.loom-arail').boundingBox())!;
      expect(Math.round(r.width)).toBe(w >= 1440 ? 320 : 296);
      // At the right edge, beside the tile, never under it.
      const t = (await p.locator('.loom-tile').boundingBox())!;
      expect(t.x + t.width).toBeLessThanOrEqual(r.x - 9);
      await expect.poll(() => p.$$eval('.loom-arail .loom-rcard', (cs) => cs.map((c) => c.getAttribute('data-agent')))).toEqual(['art', 'nova', 'mark']);
      // Needs you first: its count and top item.
      const needs = p.locator('.loom-arail > :first-child');
      expect(await needs.getAttribute('class')).toContain('loom-rneeds');
      expect(await needs.textContent()).toContain('NEEDS YOU · 1');
      expect(await needs.textContent()).toContain('OK to clear the stale lock');
      // Compact cards: how each is, what it's on, what's new; no composer on any.
      expect(await rail(p, 'art').locator('.loom-rcard__st').textContent()).toMatch(/waiting on you/i);
      await expect.poll(() => rail(p, 'mark').locator('.loom-rcard__ur').textContent()).toContain('On it. I’ll keep Wednesday clear');
      expect(await p.locator('.loom-arail input, .loom-arail form').count()).toBe(0);
      expect(await tidy(p, '.loom-rcard')).toEqual([]);
      if (SHOTS) await p.screenshot({ path: `${SHOTS}/work-${look}-${w}.png` });
      await p.context().close();
    });
  }

  it('only the viewer\'s own agents: Sam owns Mark, so Mark alone, and only Sam\'s unread', async () => {
    const p = await screen(1440, 900, '/', { who: 'sam' });
    await card(p, 'mark').waitFor();
    expect(await p.$$eval('.loom-bigcard', (cs) => cs.map((c) => c.getAttribute('data-agent')))).toEqual(['mark']);
    await expect.poll(() => card(p, 'mark').locator('[data-kind="unread"]').textContent()).toBe('1 new‘Only for Sam.’');
    expect(await p.locator('body').textContent()).not.toContain('Ready for your review');
    await p.context().close();
  });

  it('unread opens its thread in Comms beside the rail; read there, the count goes on the card', async () => {
    const p = await screen(1440, 900, '/');
    await card(p, 'mark').locator('[data-kind="unread"]').click();
    await expect.poll(() => labels(p)).toEqual(['Comms']);
    await expect.poll(() => new URL(p.url()).pathname).toBe(`/comms/${plan.id.slice(3)}`);
    await p.locator('.loom-tile .comms-thread').waitFor();
    // Mark's rail card is the comm screen while the thread is in front, and the thread is read there.
    await expect.poll(() => p.locator('.loom-arail .loom-rscreen[data-agent="mark"] .loom-rcard__ur').textContent(), { timeout: 15_000 }).toBe('Thread open in Comms');
    // Home again: the big card agrees.
    await p.click('.loom-dock-bar [data-part="item"][aria-label="Home"]');
    await expect.poll(() => card(p, 'mark').locator('[data-kind="none"]').count(), { timeout: 15_000 }).toBe(1);
    await p.context().close();
  });

  it('a reply landing while Home is open shows on its card without a reload (the live stream asks again)', async () => {
    const p = await screen(1440, 900, '/');
    await expect.poll(() => card(p, 'art').locator('[data-kind="ask"]').count()).toBe(1);
    expect(await card(p, 'art').locator('[data-kind="unread"]').count()).toBe(0);
    d.reply(backup, 'Lock cleared. The run is going now.');
    await expect.poll(() => card(p, 'art').locator('[data-kind="unread"]').textContent(), { timeout: 20_000 }).toBe('1 new‘Lock cleared. The run is going now.’');
    // Signed out (loom sends the next ask to sign in): the card shows nothing of the thread any more, not the last answer.
    await p.context().clearCookies();
    await p.evaluate(() => dispatchEvent(new Event('loom-comms-read')));
    await expect.poll(() => card(p, 'art').locator('[data-kind="unread"]').count()).toBe(0);
    expect(await p.locator('.loom-adesk').textContent()).not.toContain('Lock cleared');
    await p.context().close();
  });

  it('the Comms summary is never kept on the device: the service worker keeps Home\'s page, not it', async () => {
    const p = await screen(1440, 900, '/', { sw: true });
    await p.evaluate(() => navigator.serviceWorker.ready);
    await p.reload();
    await expect.poll(() => p.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await expect.poll(() => card(p, 'mark').locator('[data-kind="unread"], [data-kind="none"]').count()).toBe(1);
    await p.evaluate(() => dispatchEvent(new Event('loom-comms-read')));
    await p.waitForTimeout(800);
    const kept = () => p.evaluate(async () => {
      const name = (await caches.keys()).find((n) => n.endsWith('-views'));
      return name ? (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname) : [];
    });
    await expect.poll(kept).toContain('/');
    expect(await kept()).not.toContain('/comms/agents');
    await p.context().close();
  });

  it('a rail card opens that agent\'s thread; Comms when it has none', async () => {
    const p = await screen(1440, 900, '/inbox?t=*inbox');
    await rail(p, 'art').click();
    await expect.poll(() => new URL(p.url()).pathname).toBe(`/comms/${backup.id.slice(3)}`);
    expect(await labels(p)).toEqual(['Inbox', 'Comms']);
    await rail(p, 'nova').click();
    await expect.poll(() => new URL(p.url()).pathname).toBe('/comms');
    await p.context().close();
  });

  it('the composer starts a thread with the agent and opens it in Comms', async () => {
    const p = await screen(1440, 900, '/');
    const box = card(p, 'nova').locator('input[aria-label="Message Nova"]');
    await box.fill('Can you sort the photo backlog by year?');
    await card(p, 'nova').getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => labels(p)).toEqual(['Comms']);
    await expect.poll(() => new URL(p.url()).pathname).toMatch(/^\/comms\/[a-z2-7]{10}$/);
    await p.locator('.loom-tile .comms-thread').getByText('Can you sort the photo backlog by year?').first().waitFor();
    // And on Nova's rail card, its new last thread.
    await p.click('.loom-dock-bar [data-part="item"][aria-label="Home"]');
    await expect.poll(() => card(p, 'nova').locator('[data-row="last"] dd').textContent()).toMatch(/^New thread|^Can you sort/);
    await p.context().close();
  });

  // ---- the comm screen in the rail (phase 3): the avatar appears once ----
  for (const look of LOOKS) for (const [w, h] of SIZES) {
    it(`at ${w}×${h} (${look}), Comms on Mark's thread: Mark's rail card is the comm screen and the band has no avatar`, async () => {
      const p = await screen(w, h, `/comms/${plan.id.slice(3)}?t=*comms`, { look });
      const card = p.locator('.loom-arail .loom-rscreen[data-agent="mark"]');
      await card.locator('.comms-screen').waitFor();
      expect(await p.locator('.comms-screen').count()).toBe(1);
      expect(await p.locator('.comms-band .comms-screen').count()).toBe(0);
      expect(await p.locator('.comms-band[data-noav]').count()).toBe(1);
      expect(await card.locator('.comms-screen__label').textContent()).toMatch(/^VISUAL MARK · /);
      expect(await card.textContent()).toContain('Thread open in Comms');
      // Comms keeps its list beside the thread: the screen's room is the rail's now.
      if (w >= 1440) await p.locator('.loom-tile .comms:not([data-one]) .comms-list').waitFor();
      expect(await tidy(p, '.loom-rscreen')).toEqual([]);
      if (SHOTS) await p.screenshot({ path: `${SHOTS}/screen-${look}-${w}.png` });
      await p.context().close();
    });
  }

  it('a reply landing plays on the rail\'s screen: the signal, then talking', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference', serviceWorkers: 'block' });
    await ctx.addInitScript(`localStorage.setItem('loom-look', 'neon'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
    await ctx.request.post(`${d.base}/login`, { form: { token: d.tok.jonathan }, maxRedirects: 0 });
    const p = await ctx.newPage();
    await p.goto(`${d.base}/comms/${backup.id.slice(3)}?t=*comms`);
    const scr = p.locator('.loom-rscreen[data-agent="art"] .comms-screen');
    await scr.waitFor();
    await p.evaluate(() => { const w = window as unknown as { seen: string[] }; w.seen = [];
      new MutationObserver(() => { const e = document.querySelector('.loom-rscreen .comms-screen'); if (e) w.seen.push(`${e.getAttribute('data-signal') ?? ''}|${e.getAttribute('data-face')}`); })
        .observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-signal', 'data-face'] }); });
    d.reply(backup, 'Done: 42 snapshots, the newest from a minute ago.');
    await expect.poll(() => p.evaluate(() => (window as unknown as { seen: string[] }).seen.join(',')), { timeout: 20_000 }).toMatch(/^on\|.*talking/);
    await ctx.close();
  });

  it('under 1280 (no rail) the band keeps the comm screen, and a phone keeps its own', async () => {
    const p = await screen(1100, 800, `/comms/${plan.id.slice(3)}?t=*comms`);
    await p.locator('.comms-band .comms-screen').waitFor();
    expect(await p.locator('.loom-arail, .loom-rscreen').count()).toBe(0);
    await p.context().close();
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await ctx.addInitScript(`localStorage.setItem('loom-look', 'neon'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
    await ctx.request.post(`${d.base}/login`, { form: { token: d.tok.jonathan }, maxRedirects: 0 });
    const q = await ctx.newPage();
    await q.goto(`${d.base}/comms/${plan.id.slice(3)}`);
    await q.locator('.comms-thread__strip .comms-screen').waitFor();
    expect(await q.locator('.loom-arail').count()).toBe(0);
    await ctx.close();
  });

  // ---- a phone's Home (phase 6) ----
  for (const look of LOOKS) {
    it(`a phone (390×844, ${look}): Needs you, then a card per agent, alphabetical, with what's new and a composer`, async () => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce', serviceWorkers: 'block' });
      await ctx.addInitScript(`localStorage.setItem('loom-look', '${look}'); sessionStorage.setItem('loom-arrived', '1'); sessionStorage.setItem('loom-booted', '1');`);
      await ctx.request.post(`${d.base}/login`, { form: { token: d.tok.jonathan }, maxRedirects: 0 });
      const p = await ctx.newPage();
      p.on('pageerror', (e) => errors.push(e.message));
      await p.goto(`${d.base}/`);
      await p.locator('.loom-phome .loom-bigcard').first().waitFor();
      expect(await p.locator('.loom-phome > :first-child').getAttribute('class')).toContain('loom-needs-band');
      expect(await p.$$eval('.loom-phome .loom-bigcard', (cs) => cs.map((c) => c.getAttribute('data-agent')))).toEqual(['art', 'nova', 'mark']);
      await expect.poll(() => p.locator('.loom-bigcard[data-agent="art"] [data-row="now"] dd').textContent()).toBe('Making the field box installer survive power loss');
      expect(await p.locator('.loom-bigcard input[aria-label^="Message"]').count()).toBe(3);
      // No desktop on a phone: no tiles, no rail.
      expect(await p.locator('.loom-tiles, .loom-arail').count()).toBe(0);
      expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      if (SHOTS) await p.screenshot({ path: `${SHOTS}/phone-${look}-390.png`, fullPage: true });
      await ctx.close();
    });
  }

  it('no page threw', () => { expect(errors).toEqual([]); });
});
