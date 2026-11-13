/** Setup's one browser test: fixture next home, two windows, condition waits. CI only. */
import { it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startLoom } from '../foundation.js';
import { FakeClock } from '../core/clock.js';
import { fixture } from '../fixture.js';
import { PeopleStore } from '../backends/people.js';
const root = resolve(import.meta.dirname, '../../dist/web');
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', chromium.executablePath()].find(p => p && existsSync(p));
it.runIf(chrome && existsSync(join(root, 'next.html')))('Setup changes are live across windows and fit both looks at three widths', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-setup-browser-')); fixture(home);
  // Membership fixtures do not create the People directory required by setMember.
  mkdirSync(join(home, 'commons'), { recursive: true });
  const people = new PeopleStore({ dbPath: join(home, 'commons', 'people.db') });
  try { people.write({ slug: 'pollock', name: 'Pollock' }); } finally { people.close(); }
  const loom = await startLoom({ home, next: true, staging: true, clock: new FakeClock(Date.parse('2026-11-12T12:00:00Z')), webRoot: root });
  const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, serviceWorkers: 'block' });
    const a = await context.newPage(), b = await context.newPage();
    const errors: string[] = []; a.on('pageerror', e => errors.push(e.message)); b.on('pageerror', e => errors.push(e.message));
    const link = loom.operations.call('direct', { kind: 'member', id: 'jonathan' }, 'signin.link', { member: 'jonathan' });
    if (!link.ok) throw new Error('Fixture sign-in failed');
    await a.goto(loom.url + (link.value as { path: string }).path);
    const signedIn = a.waitForResponse(r => r.request().method() === 'POST');
    await a.getByRole('button', { name: 'Sign in', exact: true }).click(); expect((await signedIn).status()).toBe(303);
    await a.goto(loom.url + '/p/setup-preview'); await b.goto(loom.url + '/p/setup-preview');
    const accounts = a.getByRole('form', { name: 'Save accounts for art', exact: true });
    const otherAccounts = b.getByRole('form', { name: 'Save accounts for art', exact: true });
    await expect.poll(() => accounts.getByRole('textbox').isEnabled()).toBe(true);
    await accounts.getByRole('textbox').fill('art-bot'); await accounts.getByRole('button').click();
    await expect.poll(() => otherAccounts.getByRole('textbox').inputValue()).toBe('art-bot');
    const ownership = a.getByRole('form', { name: 'Save ownership for pollock', exact: true });
    await ownership.getByRole('checkbox', { name: 'mark', exact: true }).check();
    await ownership.getByRole('checkbox', { name: 'I confirm this ownership change', exact: true }).check();
    await ownership.getByRole('button').click();
    await expect.poll(() => b.getByText('member · mark, pond-bot', { exact: true }).count()).toBe(1);
    const projects = a.getByRole('form', { name: 'Save projects for pollock', exact: true });
    await projects.getByRole('checkbox', { name: 'other', exact: true }).check(); await projects.getByRole('button').click();
    await expect.poll(() => b.getByRole('form', { name: 'Save projects for pollock', exact: true }).getByRole('checkbox', { name: 'other', exact: true }).isChecked()).toBe(true);
    // The daemon rejects removal of the last household owner; the page surfaces it.
    const remove = a.getByRole('form', { name: 'Remove jonathan', exact: true });
    await remove.getByRole('checkbox').check(); await remove.getByRole('button').click();
    await expect.poll(() => a.getByText('invalid: A household owner must remain', { exact: true }).count()).toBe(1);
    const shots = resolve('artifacts/household-setup'); mkdirSync(shots, { recursive: true });
    for (const look of ['neon', 'daylight']) for (const width of [390, 1280, 1920]) {
      expect(loom.operations.call('direct', { kind: 'member', id: 'jonathan' }, 'household.setPreferences', { look }, `look-${look}-${width}`).ok).toBe(true);
      await b.setViewportSize({ width, height: 1000 }); await b.reload();
      await expect.poll(() => b.getByRole('form', { name: 'Save accounts for art', exact: true }).getByRole('textbox').inputValue()).toBe('art-bot');
      await expect.poll(() => b.locator('html').getAttribute('data-look')).toBe(look);
      expect(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await b.screenshot({ path: join(shots, `setup-${look}-${width}.png`), fullPage: true, animations: 'disabled' });
    }
    expect(errors).toEqual([]); await context.close();
  } finally { await browser.close(); await loom.close(); rmSync(home, { recursive: true, force: true }); }
}, 60_000);
