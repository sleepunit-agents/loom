/** The agreed large-card and contacts layouts, over real HTTP and a disposable household. */
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { deskHome, type DeskHome } from './agent-desk.fixture.js';
import { PeopleStore } from '../backends/people.js';
import { commonsPeoplePath } from '../backends/people-household.js';
const root = new URL('../../', import.meta.url).pathname;
const chrome = process.env.LOOM_TEST_CHROME ?? '/usr/bin/google-chrome';
describe.runIf(existsSync(`${root}dist/web/index.html`) && existsSync(chrome))('agreed desktop layouts', () => {
  let d: DeskHome, browser: Browser;
  beforeAll(async () => {
    d = await deskHome({ art: 'Art', mark: 'Mark' }, [{ person: 'jonathan', agents: '*' }, { person: 'sam', agents: ['art'] }]);
    d.report({ art: { doing: [{ text: 'A full current work description which must remain readable instead of being truncated in the middle of its sentence.' }], readings: [{ label: 'Next', value: 'Tomorrow', detail: 'Check the result of the complete overnight audit and report everything still waiting.' }] } });
    d.ask('art', 'Use the agreed layouts and keep this complete question readable on a small phone as well as a large desktop?');
    d.thread('jonathan', 'art', 'Work with Art', 'Layout conversation');
    d.thread('sam', 'art', 'Private to Sam', 'Sam’s thread');
    mkdirSync(join(commonsPeoplePath(d.h), '..'), { recursive: true });
    const people = new PeopleStore({ dbPath: commonsPeoplePath(d.h) });
    people.write({ slug: 'jonathan', name: 'Jonathan Barket' });
    people.write({ slug: 'art', name: 'Art', how: { kind: 'agent' } });
    people.write({ slug: 'mark', name: 'Mark', how: { kind: 'agent' } });
    people.close();
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  }, 60000);
  afterAll(async () => { await browser?.close(); await d?.close(); });
  const open = async (width: number, path: string) => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await ctx.addInitScript(() => { sessionStorage.setItem('loom-booted', '1'); sessionStorage.setItem('loom-arrived', '1'); });
    await ctx.request.post(`${d.base}/login`, { form: { token: d.tok.jonathan }, maxRedirects: 0 });
    const p = await ctx.newPage(); await p.goto(`${d.base}${path}`); return { ctx, p };
  };
  for (const width of [1600, 390]) it(`full card question, consequences and guarded answer at ${width}`, async () => {
    const { ctx, p } = await open(width, '/');
    try {
      const art = p.locator('.loom-bigcard[data-agent="art"]');
      await art.locator('.loom-bigcard__question').waitFor();
      expect(await art.locator('.loom-inbox__ifs').textContent()).toContain('I leave it.');
      expect(await art.locator('.loom-bigcard__st').count()).toBe(0);
      expect(await art.locator('[data-row="wake"] dd').textContent()).toContain('complete overnight audit');
      const question = art.locator('.loom-split__head');
      expect(await question.evaluate((e) => ({ white: getComputedStyle(e).whiteSpace, clip: getComputedStyle(e).webkitLineClamp }))).toEqual({ white: 'normal', clip: 'none' });
      // A still-open check must gate the card's own buttons, not only the separate Needs you band.
      await art.getByRole('button', { name: 'Yes', exact: true }).waitFor();
      if (process.env.LOOM_LAYOUT_SHOTS) { mkdirSync(process.env.LOOM_LAYOUT_SHOTS, { recursive: true }); await p.screenshot({ path: `${process.env.LOOM_LAYOUT_SHOTS}/cards-${width}.png`, fullPage: true }); }
      // Become stale at the click: the background refresh must not remove Yes before Playwright can press it.
      await art.getByRole('button', { name: 'Yes', exact: true }).evaluate((el) => el.addEventListener('click', () => { (window as unknown as { staleAnswer: boolean }).staleAnswer = true; }, { capture: true }));
      await p.route('**/inbox/open?*', async (route) => {
        if (await p.evaluate(() => (window as unknown as { staleAnswer?: boolean }).staleAnswer)) await route.fulfill({ contentType: 'application/json', body: '{"open":false}' });
        else await route.continue();
      });
      let sends = 0; p.on('request', (r) => { if (r.method() === 'POST' && /act\//.test(r.url())) sends++; });
      await art.getByRole('button', { name: 'Yes', exact: true }).click();
      await art.getByText(/This isn’t open any more/).waitFor();
      expect(sends).toBe(0);
      expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    } finally { await ctx.close(); }
  }, 30000);
  for (const width of [1600, 390]) it(`contacts search, selection, return and direct links at ${width}`, async () => {
    const { ctx, p } = await open(width, '/people');
    try {
      await p.locator('.loom-people').waitFor();
      await p.getByRole('searchbox', { name: 'Search people' }).fill('Art');
      // Barket also matches Art, so search by full contact name to exercise a single result.
      await p.getByRole('searchbox', { name: 'Search people' }).fill('Mark');
      expect(await p.locator('.loom-people__row').count()).toBe(1);
      expect(await p.locator('.loom-people__row').getAttribute('href')).toBe('/people/mark?q=Mark');
      await p.locator('.loom-people__row').click();
      await p.locator('.loom-people__detail [data-section="profile"]').waitFor();
      expect(new URL(p.url()).pathname).toBe('/people/mark');
      expect(new URL(p.url()).searchParams.get('q')).toBe('Mark');
      expect(await p.locator('.loom-people__detail').textContent()).toContain('How each agent knows it');
      if (width === 390) {
        await p.getByRole('button', { name: 'Contacts', exact: true }).click();
        expect(await p.getByRole('searchbox', { name: 'Search people' }).inputValue()).toBe('Mark');
        expect(await p.locator('.loom-people__row').count()).toBe(1);
      } else expect(await p.locator('.loom-people').getAttribute('data-mode')).not.toBe('one');
      expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await p.goto(`${d.base}/people/art`);
      await p.locator('.loom-people__detail [data-section="profile"]').waitFor();
      expect(await p.locator('.loom-people__detail').textContent()).toContain('Layout conversation');
      if (process.env.LOOM_LAYOUT_SHOTS) { mkdirSync(process.env.LOOM_LAYOUT_SHOTS, { recursive: true }); await p.screenshot({ path: `${process.env.LOOM_LAYOUT_SHOTS}/people-${width}.png`, fullPage: true }); }
      expect(await p.locator('.loom-people__detail').textContent()).not.toContain('Sam’s thread');
    } finally { await ctx.close(); }
  }, 30000);
});
