/** Shared Approvals reader proof. Browsers run in CI, never on loom's machine. */
import { it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { chromium, type Browser } from 'playwright-core';
import { FakeClock } from '../core/clock.js';
import { createDataSchema } from '../core/data/database.js';
import { nextData } from '../next-data.js';
import * as s from '../core/data/schema.js';
import { approvalsQuery } from '../../web/src/data/work-query.js';

const root = resolve(import.meta.dirname, '../../dist/web');
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', chromium.executablePath()].find(p => p && existsSync(p));
const title = 'Review the shared pump setting', ask = 'Change the pump setting?';
const hidden = 'Private request for another member', record = 'Shared request recorded';
const summary = 'Before: the default. After: 60 seconds.';

async function fixture() {
  const client = new Database(':memory:');
  const at = '2026-11-14T20:00:00.000Z', clock = new FakeClock(Date.parse(at));
  const db = createDataSchema(client, () => new Date(clock.now()).toISOString());
  db.insert(s.members).values(['sam', 'lee'].map(id => ({ id, role: 'member' as const, joinedAt: at }))).run();
  db.insert(s.agents).values({ id: 'art', about: '', markBg: '', markFg: '', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(s.projects).values({ id: 'pond', name: 'Pond' }).run();
  db.insert(s.projectMembers).values({ project: 'pond', member: 'sam' }).run();
  const cookie = 'c'.repeat(64), token = createHash('sha256').update('disposable-approval-token').digest('hex');
  const session = createHash('sha256').update(cookie).digest('hex');
  db.insert(s.tokens).values({ fingerprint: token, label: 'Disposable browser fixture', kind: 'owner', member: 'sam', createdAt: at }).run();
  db.insert(s.sessions).values({ id: session, token, device: 'Fixture', via: 'token', isAgent: false, issuedAt: at, seenAt: at, provedAt: at }).run();
  for (const [id, what, member] of [['shared', title, null], ['private', hidden, 'lee']] as const) {
    db.insert(s.approvals).values({ id, kind: 'setting', target: 'pump:settleSeconds', what, why: what, agent: 'art', project: 'pond', member,
      askedFrom: 'fixture', actingFor: 'unknown', state: 'pending', minutes: 5, ask: id === 'shared' ? ask : hidden,
      ifYes: 'Apply this exact setting.', ifNo: 'Keep the current setting.', details: what, changeSummary: summary, askedAt: at }).run();
    db.insert(s.approvalRecord).values({ seq: id === 'shared' ? 1 : 2, at, event: 'request', approval: id, agent: 'art', note: id === 'shared' ? record : hidden }).run();
  }
  db.insert(s.approvalRules).values({ kind: 'setting', scope: 'Private global rule', person: '', tier: 'ask', setBy: 'lee', setAt: at }).run();
  db.insert(s.approvalNotices).values({ id: 'notice', agent: 'art', kind: 'setting', target: 'private', what: 'Private agent notice', at }).run();
  const data = nextData(db, clock, request => request.headers.origin === `http://${request.headers.host}`);
  const serveData = getRequestListener(request => data.http.fetch(request));
  const http = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    if (url.pathname === '/graphql') { void serveData(request, response); return; }
    const file = url.pathname.startsWith('/app/') ? resolve(root, url.pathname.slice(5)) : join(root, 'index.html');
    if (!file.startsWith(`${root}/`) || !existsSync(file)) { response.writeHead(404).end(); return; }
    response.setHeader('content-type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2' } as Record<string, string>)[extname(file)] ?? 'application/octet-stream');
    response.end(readFileSync(file));
  });
  const detach = data.attach(http);
  await new Promise<void>(ok => http.listen(0, '127.0.0.1', ok));
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('No fixture listener');
  return { db, data, cookie, session, url: `http://127.0.0.1:${address.port}`,
    async close() { detach(); await data.close(); await new Promise<void>(ok => http.close(() => ok())); client.close(); } };
}

it('serves the shipped Approvals selection with private requests, audit, rules and notices filtered at the real HTTP door', async () => {
  const app = await fixture();
  try {
    const post = (cookie?: string) => fetch(`${app.url}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json',
      ...(cookie ? { cookie: `loom_ui=${cookie}` } : {}) }, body: JSON.stringify({ query: approvalsQuery }) });
    expect((await post()).status).toBe(401);
    const response = await post(app.cookie);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const result = await response.json(); expect(result.errors).toBeUndefined();
    expect(result.data.approvals.map((row: { id: string }) => row.id)).toEqual(['shared']);
    expect(result.data.approvalRecord.map((row: { note: string }) => row.note)).toEqual([record]);
    expect(result.data.approvalRules).toEqual([]); expect(result.data.approvalNotices).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(hidden);
    app.data.writes.run(() => app.db.delete(s.sessions).where(eq(s.sessions.id, app.session)).run());
    expect((await post(app.cookie)).status).toBe(401);
  } finally { await app.close(); }
});

it.runIf(chrome && existsSync(join(root, 'index.html')))('Approvals shares live request details and audit across windows, and withdraws revoked reads', async () => {
  const app = await fixture(); let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await context.addCookies([{ name: 'loom_ui', value: app.cookie, url: app.url }]);
    const a = await context.newPage(), b = await context.newPage(), errors: string[] = [];
    for (const page of [a, b]) page.on('pageerror', error => errors.push(error.message));
    await Promise.all([a.goto(`${app.url}/p/approvals-preview`), b.goto(`${app.url}/p/approvals-preview`)]);
    const row = (page: typeof a) => page.locator('[data-split-row]').filter({ hasText: title });
    for (const page of [a, b]) {
      await expect.poll(() => row(page).count()).toBe(1);
      expect(await page.getByText(hidden, { exact: true }).count()).toBe(0);
      await row(page).click();
      await expect.poll(() => page.getByRole('heading', { name: ask, exact: true }).count()).toBe(1);
      expect(await page.getByText(summary, { exact: true }).count()).toBe(1);
      expect(await page.getByText('Apply this exact setting.', { exact: true }).count()).toBe(1);
      expect(await page.getByText('Keep the current setting.', { exact: true }).count()).toBe(1);
      expect(await page.getByText(record, { exact: false }).count()).toBe(1);
    }
    await b.reload();
    await expect.poll(() => b.getByRole('heading', { name: ask, exact: true }).count()).toBe(1);
    app.data.writes.run(() => {
      app.db.update(s.approvals).set({ changeSummary: 'Before: 60 seconds. After: 90 seconds.' }).where(eq(s.approvals.id, 'shared')).run();
      app.db.insert(s.approvalRecord).values({ seq: 3, at: '2026-11-14T20:01:00.000Z', event: 'request', approval: 'shared', agent: 'art', note: 'Updated shared request' }).run();
    });
    for (const page of [a, b]) {
      await expect.poll(() => page.getByText('Before: 60 seconds. After: 90 seconds.', { exact: true }).count()).toBe(1);
      await expect.poll(() => page.getByText('Updated shared request', { exact: false }).count()).toBe(1);
    }
    const shots = process.env.LOOM_TEST_SHOTS ?? resolve('artifacts/approvals-piece'); mkdirSync(shots, { recursive: true });
    for (const look of ['neon', 'daylight']) for (const width of [390, 1280, 1920]) {
      await b.setViewportSize({ width, height: 900 });
      await b.evaluate(look => { document.documentElement.dataset.look = look; document.documentElement.dataset.mode = look === 'daylight' ? 'light' : 'dark'; }, look);
      await expect.poll(() => b.locator('.loom-split').getAttribute('data-mode')).toBe(width < 640 ? 'one' : 'three');
      expect(await b.locator('.loom-split').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await b.screenshot({ path: join(shots, `approvals-${look}-${width}.png`), fullPage: true, animations: 'disabled' });
    }
    app.data.writes.run(() => app.db.delete(s.projectMembers).where(eq(s.projectMembers.member, 'sam')).run());
    for (const page of [a, b]) {
      await expect.poll(() => row(page).count()).toBe(0);
      expect(await page.getByRole('heading', { name: ask, exact: true }).count()).toBe(0);
      expect(await page.getByText('Updated shared request', { exact: false }).count()).toBe(0);
    }
    app.data.writes.run(() => app.db.insert(s.projectMembers).values({ project: 'pond', member: 'sam' }).run());
    for (const page of [a, b]) await expect.poll(() => row(page).count()).toBe(1);
    app.data.writes.run(() => app.db.delete(s.sessions).where(eq(s.sessions.id, app.session)).run());
    for (const page of [a, b]) await expect.poll(() => row(page).count()).toBe(0);
    await b.reload();
    await expect.poll(() => b.getByText('Waiting for connection.', { exact: true }).count()).toBe(1);
    expect(await row(b).count()).toBe(0); expect(errors).toEqual([]);
    await context.close();
  } finally { await browser?.close(); await app.close(); }
}, 60_000);
