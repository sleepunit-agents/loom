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
    const create = a.getByRole('form', { name: 'Create agent', exact: true });
    await create.getByRole('textbox', { name: 'Short name', exact: true }).fill('gabe');
    await create.getByRole('textbox', { name: 'Name', exact: true }).fill('Gabe');
    await create.getByRole('textbox', { name: 'What it’s for', exact: true }).fill('Help with the garden.');
    await create.getByRole('textbox', { name: 'How it talks', exact: true }).fill('Warm and direct.');
    await create.getByRole('textbox', { name: 'Rules', exact: true }).fill('Keep private things private.');
    await create.getByRole('textbox', { name: 'When to ask first', exact: true }).fill('Before spending money.');
    await create.getByRole('checkbox').check(); await create.getByRole('button').click();
    await expect.poll(() => a.getByLabel('Harness configuration', { exact: true }).textContent()).toContain('--next');
    await expect.poll(() => b.getByRole('form', { name: 'Save accounts for gabe', exact: true }).count()).toBe(1);
    const mint = a.getByRole('form', { name: 'Create token', exact: true });
    await expect.poll(() => mint.locator('select[name=role]').inputValue()).toBe('agent');
    expect(await mint.locator('select[name=agent]').inputValue()).toBe('gabe');
    expect(await mint.getByRole('textbox', { name: 'Token label', exact: true }).inputValue()).toBe('gabe · first token');
    await mint.getByRole('textbox', { name: 'Token label', exact: true }).fill('setup-browser-token');
    await mint.getByRole('button', { name: 'Create token', exact: true }).click();
    await expect.poll(() => a.getByLabel('Token value', { exact: true }).textContent()).toMatch(/^loom_/);
    // Only the initiating window sees the bearer; both see authoritative safe metadata.
    const revokeToken = b.getByRole('form', { name: 'Revoke token setup-browser-token', exact: true });
    await expect.poll(() => revokeToken.count()).toBe(1);
    expect(await b.getByLabel('Token value', { exact: true }).count()).toBe(0);
    await a.getByRole('button', { name: 'Home', exact: true }).click();
    await expect.poll(() => a.locator('[data-tile]').count()).toBe(0);
    await a.getByRole('button', { name: 'Open Household setup', exact: true }).click();
    expect(await a.getByLabel('Token value', { exact: true }).count()).toBe(0);
    // A separately seeded browser session is revoked through the real screen.
    const session = loom.operations.call('direct', { kind: 'member', id: 'jonathan' }, 'sessions.list', {});
    if (!session.ok) throw new Error('Fixture session list failed');
    const active = (session.value as { ref: string }[])[0].ref;
    const { signin, hash } = await import('../core/signin/index.js');
    const auth = signin(loom);
    const temporary = auth.createSession(auth.sessions.read().sessions[Object.keys(auth.sessions.read().sessions)[0]].secret, { label: 'temporary-browser' });
    loom.live.changed([{ type: 'signin.admin', id: 'household' }]);
    const revokeSession = a.getByRole('form', { name: `Revoke session ${hash(temporary).slice(0, 16)}`, exact: true });
    await expect.poll(() => revokeSession.count()).toBe(1);
    await revokeSession.getByRole('button').click();
    expect(await revokeSession.evaluate(form => !(form as HTMLFormElement).checkValidity())).toBe(true);
    expect(auth.session(temporary)).toBeDefined();
    await revokeSession.getByRole('checkbox').check(); await revokeSession.getByRole('button').click();
    await expect.poll(() => b.getByRole('form', { name: `Revoke session ${hash(temporary).slice(0, 16)}`, exact: true }).count()).toBe(0);
    expect(auth.session(temporary)).toBeUndefined();
    expect((loom.operations.call('direct', { kind: 'member', id: 'jonathan' }, 'sessions.list', {}) as { value: { ref: string }[] }).value.some(x => x.ref === active)).toBe(true);
    const shots = resolve('artifacts/household-setup'); mkdirSync(shots, { recursive: true });
    for (const look of ['neon', 'daylight']) for (const width of [390, 1280, 1920]) {
      expect(loom.operations.call('direct', { kind: 'member', id: 'jonathan' }, 'household.setPreferences', { look }, `look-${look}-${width}`).ok).toBe(true);
      await b.setViewportSize({ width, height: 1000 }); await b.reload();
      await expect.poll(() => b.getByRole('form', { name: 'Save accounts for art', exact: true }).getByRole('textbox').inputValue()).toBe('art-bot');
      await expect.poll(() => b.locator('html').getAttribute('data-look')).toBe(look);
      expect(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await b.getByRole('heading', { name: 'Create an agent', exact: true }).scrollIntoViewIfNeeded();
      await b.screenshot({ path: join(shots, `setup-${look}-${width}.png`), fullPage: true, animations: 'disabled' });
    }
    await revokeToken.getByRole('button').click();
    expect(await revokeToken.evaluate(form => !(form as HTMLFormElement).checkValidity())).toBe(true);
    expect(auth.tokens.list().find(t => t.label === 'setup-browser-token')?.revoked).toBeUndefined();
    await revokeToken.getByRole('checkbox', { name: 'I confirm revoking setup-browser-token', exact: true }).check();
    await revokeToken.getByRole('button').click();
    await expect.poll(() => a.getByRole('form', { name: 'Revoke token setup-browser-token', exact: true }).count()).toBe(0);
    expect(errors).toEqual([]); await context.close();
  } finally { await browser.close(); await loom.close(); rmSync(home, { recursive: true, force: true }); }
}, 60_000);
