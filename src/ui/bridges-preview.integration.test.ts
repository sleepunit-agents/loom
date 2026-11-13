/** CI-only browser evidence. Fake venue IO; no platform or installed home access. */
import { it, expect } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startLoom } from '../foundation.js';
import { FakeClock } from '../core/clock.js';
import { installFixture, fixtureSharing } from '../fixture.js';
import { TokenDatabase } from '../core/household/tokens.js';
import { Bridges } from '../pieces/bridges/engine.js';
import { venueSchema } from '../pieces/bridges/model.js';
import type { Incoming, VenueAdapter } from '../pieces/bridges/role.js';
const root = resolve(import.meta.dirname, '../../dist/web');
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', chromium.executablePath()].find(p => p && existsSync(p));
it.runIf(chrome && existsSync(join(root, 'next.html')))('Bridges shares status and staging release between windows without replaying an uncertain send', async () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-bridges-browser-'));
  const clock = new FakeClock(Date.parse('2026-11-13T12:00:00Z'));
  const loom = await startLoom({ home, clock, next: true, staging: true, webRoot: root, sharing: fixtureSharing, install: app => {
    installFixture(app);
    app.db.transaction(() => new TokenDatabase(app.db).replace({ v: 1, tokens: [] }, {}))();
  } });
  const owner = { kind: 'member', id: 'jonathan' } as const;
  const venue = venueSchema.parse({ id: 'art-discord', platform: 'discord', agent: 'art', workspace: 'house', bot: '100', tokenSecret: 'fixture-reference' });
  const write = (name: string, input: unknown) => { expect(loom.operations.call('direct', owner, name, input, crypto.randomUUID()).ok).toBe(true); };
  write('bridges.putVenues', venue);
  write('bridges.putLinks', { id: 'jonathan-link', platform: 'discord', workspace: 'house', user: '200', person: 'jonathan' });
  write('bridges.putRoutes', { id: 'house-route', platform: 'discord', workspace: 'house', channel: '300', primary: 'art' });
  const deliveries: Incoming[] = [];
  let posts = 0;
  const adapter: VenueAdapter = {
    platform: 'discord', async connect() { return { close() {} }; }, async inspect() { return 'allow'; },
    async send() { posts++; throw new Error('Fake uncertain transport'); },
  };
  const engine = new Bridges(loom, clock, { async admit() { return 'allow'; }, async deliver(input) { deliveries.push(input); return 'delivered'; }, async stop() {} },
    { async may() { return true; }, async get() { return 'not-a-credential'; } }, [adapter], loom.effects!);
  const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  try {
    await engine.sync();
    await engine.receive(venue.id, { id: 'message', channel: '300', user: '200', text: 'Private inbound words', at: '2026-11-13T12:00:00Z', mentions: [], dm: false });
    await engine.flush(); expect(deliveries).toHaveLength(1);
    engine.reply({ id: 'reply-with-a-stable-operation-id', incomingId: deliveries[0].id, text: 'Private reply words' });
    await engine.flush(); expect(posts).toBe(0);
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await context.grantPermissions(['local-network-access'], { origin: loom.url });
    const a = await context.newPage(), b = await context.newPage();
    const link = loom.operations.call('direct', owner, 'signin.link', { member: 'jonathan' });
    if (!link.ok) throw new Error(`Fixture sign-in link failed: ${link.code}`);
    await a.goto(loom.url + (link.value as { path: string }).path);
    const signingIn = a.waitForResponse(r => r.request().method() === 'POST');
    await a.getByRole('button', { name: 'Sign in', exact: true }).click();
    expect((await signingIn).status()).toBe(303);
    await Promise.all([a.goto(`${loom.url}/p/bridges-preview`), b.goto(`${loom.url}/p/bridges-preview`)]);
    const row = (page: typeof a, title: string) => page.locator('[data-split-row]').filter({ hasText: title });
    for (const p of [a, b]) await expect.poll(() => row(p, 'art · discord').count()).toBe(1);
    loom.db.prepare("UPDATE bridges_status SET state='backoff' WHERE id=?").run(venue.id);
    loom.live.changed([{ type: 'bridges.venue', id: venue.id }]);
    for (const p of [a, b]) await expect.poll(() => row(p, 'art · discord').textContent()).toContain('backoff');
    for (const p of [a, b]) {
      await p.getByRole('button', { name: 'Routes', exact: false }).click();
      await row(p, '300').click();
      await expect.poll(() => p.getByRole('button', { name: 'Save route', exact: true }).isEnabled()).toBe(true);
    }
    await a.getByRole('textbox', { name: 'Primary agent', exact: true }).fill('mark');
    await a.getByRole('textbox', { name: 'Note references', exact: true }).fill('house/brief');
    await a.getByRole('button', { name: 'Save route', exact: true }).click();
    await expect.poll(() => row(b, '300').getByText('Primary: mark', { exact: true }).count()).toBe(1);
    await expect.poll(() => b.getByRole('button', { name: 'Save route', exact: true }).isDisabled()).toBe(true);
    await b.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect.poll(() => b.getByRole('textbox', { name: 'Primary agent', exact: true }).inputValue()).toBe('mark');
    const shots = process.env.LOOM_TEST_SHOTS ?? resolve('artifacts/bridges-preview'); mkdirSync(shots, { recursive: true });
    for (const look of ['neon', 'daylight']) for (const width of [390, 1280, 1920]) {
      await b.setViewportSize({ width, height: 900 });
      await b.evaluate(look => { document.documentElement.dataset.look = look; document.documentElement.dataset.mode = look === 'daylight' ? 'light' : 'dark'; document.documentElement.dataset.motion = 'reduce'; }, look);
      await expect.poll(() => b.locator('.loom-split').getAttribute('data-mode')).toBe(width < 640 ? 'one' : 'three');
      await b.screenshot({ path: join(shots, `bridges-route-${look}-${width}.png`), fullPage: true, animations: 'disabled' });
      const geometry = await b.locator('.loom-split').evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }));
      expect(geometry.scroll <= geometry.client + 1, JSON.stringify({ width, ...geometry })).toBe(true);
    }
    await b.setViewportSize({ width: 1280, height: 900 });
    for (const p of [a, b]) {
      await p.getByRole('button', { name: 'Routes', exact: false }).click();
      await expect.poll(() => row(p, '300').count()).toBe(1);
      await p.getByRole('button', { name: 'Pending sends', exact: false }).click();
      await row(p, 'reply-with-a-stable-operation-id').click();
      await expect.poll(() => p.getByRole('button', { name: 'Release this send', exact: true }).isEnabled()).toBe(true);
      expect(await p.getByText('Private reply words', { exact: true }).count()).toBe(0);
      expect(await p.getByText('Private inbound words', { exact: true }).count()).toBe(0);
    }
    await b.reload();
    await expect.poll(() => b.getByRole('button', { name: 'Release this send', exact: true }).isEnabled()).toBe(true);
    for (const look of ['neon', 'daylight']) for (const width of [390, 1280, 1920]) {
      await b.setViewportSize({ width, height: 900 });
      await b.evaluate(look => { document.documentElement.dataset.look = look; document.documentElement.dataset.mode = look === 'daylight' ? 'light' : 'dark'; document.documentElement.dataset.motion = 'reduce'; }, look);
      await expect.poll(() => b.locator('.loom-split').getAttribute('data-mode')).toBe(width < 640 ? 'one' : 'three');
      await b.screenshot({ path: join(shots, `bridges-${look}-${width}.png`), fullPage: true, animations: 'disabled' });
      const geometry = await b.locator('.loom-split').evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth, overflowing: [...el.querySelectorAll('*')].filter(n => n.scrollWidth > n.clientWidth + 1).map(n => ({ tag: n.tagName, class: n.className, client: n.clientWidth, scroll: n.scrollWidth })).slice(0, 12) }));
      expect(geometry.scroll <= geometry.client + 1, JSON.stringify({ width, ...geometry })).toBe(true);
    }
    await a.getByRole('button', { name: 'Release this send', exact: true }).click();
    await expect.poll(() => loom.db.prepare('SELECT state FROM core_effects').get()).toEqual({ state: 'released' });
    clock.advance(0); await engine.flush();
    expect(posts).toBe(1);
    for (const p of [a, b]) {
      await expect.poll(() => p.getByText('Uncertain · review required', { exact: true }).count()).toBeGreaterThan(0);
      await expect.poll(() => p.getByRole('button', { name: 'Release this send', exact: true }).count()).toBe(0);
    }
    clock.advance(60_000); await engine.flush(); expect(posts).toBe(1);
  } finally { await browser.close(); await engine.close(); await loom.close(); rmSync(home, { recursive: true, force: true }); }
}, 60_000);
