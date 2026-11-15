/** Shared Changes reader proof. Browsers run in CI, never on loom's machine. */
import { it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { chromium } from 'playwright-core';
import { FakeClock } from '../core/clock.js';
import { createDataSchema } from '../core/data/database.js';
import { sharedRoot } from '../shared-root.js';
import { tmpdir } from 'node:os';
import * as s from '../core/data/schema.js';
import { changesQuery } from '../../web/src/data/work-query.js';

const root = resolve(import.meta.dirname, '../../dist/web');
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', chromium.executablePath()].find(p => p && existsSync(p));
const title = 'Keep shared changes current', hiddenTitle = 'Private other project change';
const changeId = 'github:acme/app#3';

// Disposable shared database and the production root transport composition.
// Serve the shipped standalone app, with no intercepted query results, copied
// legacy records, custom authentication resolver or substituted browser feed.
async function fixture() {
  const client = new Database(':memory:');
  const at = '2026-11-14T20:00:00.000Z', clock = new FakeClock(Date.parse(at));
  const db = createDataSchema(client, () => new Date(clock.now()).toISOString());
  db.insert(s.members).values(['sam', 'lee'].map(id => ({ id, role: 'member' as const, joinedAt: at }))).run();
  db.insert(s.agents).values({id:'art',about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble',faceEyes:'dot'}).run();
  db.insert(s.projects).values(['pond', 'other'].map(id => ({ id, name: id }))).run();
  db.insert(s.projectMembers).values({ project: 'pond', member: 'sam' }).run();
  const cookie = 'c'.repeat(64), token = 't'.repeat(64);
  const fingerprint = createHash('sha256').update(token).digest('hex');
  const session = createHash('sha256').update(cookie).digest('hex');
  db.insert(s.tokens).values({ fingerprint, label: 'Disposable browser fixture', kind: 'owner', member: 'sam', createdAt: at }).run();
  db.insert(s.sessions).values({ id: session, token: fingerprint, device: 'Fixture', via: 'token', isAgent: false, issuedAt: at, seenAt: at, provedAt: at }).run();
  for (const [id, project, name] of [[changeId, 'pond', title], ['github:other/app#4', 'other', hiddenTitle]]) {
    db.insert(s.changes).values({ id, repository: project === 'pond' ? 'acme/app' : 'other/app', number: 3, title: name,
      body: 'Checks, reviews and task citations arrive in every window.', url: '', state: 'open', draft: false,
      authorLogin: 'art', project, agent: project === 'pond' ? 'art' : null, branch: 'work', headCommit: 'a'.repeat(40), baseBranch: 'next',
      checks: 'running', review: 'required', mergeable: 'unknown', waitingOn: 'ci', openedAt: at, updatedAt: at }).run();
  }
  db.insert(s.changeChecks).values({ change: changeId, name: 'Typecheck', state: 'running' }).run();
  db.insert(s.changePeople).values({ change: changeId, login: 'Reviewer', role: 'reviewer' }).run();
  for (const [id, name, ownerKind, owner, project] of [
    ['visible', 'Track the shared change', 'household', null, 'pond'],
    ['private', 'Private linked task', 'member', 'lee', null],
  ] as const) {
    db.insert(s.tasks).values({ id, title: name, ownerKind, owner, project, createdByKind: 'member', createdBy: 'sam', createdAt: at, changedAt: at }).run();
    db.insert(s.changeTasks).values({ change: changeId, task: id }).run();
  }
  db.insert(s.members).values({id:'pat',role:'owner',joinedAt:at}).run();
  const ownerCookie='d'.repeat(64), ownerFingerprint=createHash('sha256').update('disposable-owner-token').digest('hex');
  db.insert(s.tokens).values({fingerprint:ownerFingerprint,label:'Disposable owner',kind:'owner',member:'pat',createdAt:at}).run();
  db.insert(s.sessions).values({id:createHash('sha256').update(ownerCookie).digest('hex'),token:ownerFingerprint,device:'Owner fixture',via:'token',isAgent:false,issuedAt:at,seenAt:at,provedAt:at}).run();
  const data = sharedRoot({db,clock,originAllowed:request=>request.headers.origin === `http://${request.headers.host}`,reportError:error=>{throw error;}});
  const serveData = getRequestListener(request => data.http.fetch(request));
  const http = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    if (url.pathname === '/graphql' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) { void serveData(request, response); return; }
    const file = url.pathname.startsWith('/app/') ? resolve(root, url.pathname.slice(5)) : join(root, 'index.html');
    if (!file.startsWith(`${root}/`) || !existsSync(file)) { response.writeHead(404).end(); return; }
    response.setHeader('content-type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.woff2': 'font/woff2' } as Record<string, string>)[extname(file)] ?? 'application/octet-stream');
    response.end(readFileSync(file));
  });
  const detach = data.attach(http);
  await new Promise<void>(ok => http.listen(0, '127.0.0.1', ok));
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('No fixture listener');
  return { db, data, cookie, ownerCookie, session, url: `http://127.0.0.1:${address.port}`,
    async close() { detach(); await data.close(); await new Promise<void>(ok => http.close(() => ok())); client.close(); } };
}

// Runs without a browser or built assets: catches /graphql falling through to
// HTML, missing Work fields and fixture visibility errors before CI screenshots.
it('serves the shipped Changes selection over the real authenticated HTTP listener', async () => {
  const app = await fixture();
  try {
    const post = (cookie?: string) => fetch(`${app.url}/graphql`, { method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie: `loom_ui=${cookie}` } : {}) }, body: JSON.stringify({ query: changesQuery }) });
    expect((await post()).status).toBe(401);
    const response = await post(app.cookie);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const result = await response.json(); expect(result.errors).toBeUndefined();
    expect(result.data.changes.map((row: { id: string }) => row.id)).toEqual([changeId]);
    expect(result.data.changeTasks.map((row: { task: string }) => row.task)).toEqual(['visible']);
    app.data.writes.run(() => app.db.delete(s.sessions).where(eq(s.sessions.id, app.session)).run());
    expect((await post(app.cookie)).status).toBe(401);
  } finally { await app.close(); }
});

it.runIf(process.env.CI === 'true' && chrome && existsSync(join(root, 'index.html')))('Changes shares generated checks, review and linked tasks across browser windows and withdraws revoked access', async () => {
  const app = await fixture();
  const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await context.addCookies([{ name: 'loom_ui', value: app.cookie, url: app.url }]);
    const a = await context.newPage(), b = await context.newPage();
    const errors: string[] = [];
    for (const page of [a, b]) page.on('pageerror', error => errors.push(error.message));
    await Promise.all([a.goto(`${app.url}/p/changes-preview`), b.goto(`${app.url}/p/changes-preview`)]);
    const row = (page: typeof a) => page.locator('[data-split-row]').filter({ hasText: title });
    for (const page of [a, b]) {
      await expect.poll(() => row(page).count()).toBe(1);
      expect(await page.getByText(hiddenTitle, { exact: true }).count()).toBe(0);
      await row(page).click();
      await expect.poll(() => page.getByText('Typecheck · running', { exact: true }).count()).toBe(1);
      await expect.poll(() => page.getByText('Track the shared change', { exact: true }).count()).toBe(1);
      expect(await page.getByText('Private linked task', { exact: true }).count()).toBe(0);
    }
    await b.reload();
    await expect.poll(() => b.getByRole('heading', { name: title, exact: true }).count()).toBe(1);
    // Commit once; both retained browser subscriptions receive the same rows.
    app.data.writes.run(() => {
      app.db.update(s.changes).set({ checks: 'failing', review: 'changes_requested' }).where(eq(s.changes.id, changeId)).run();
      app.db.update(s.changeChecks).set({ state: 'failing' }).where(eq(s.changeChecks.change, changeId)).run();
      app.db.update(s.tasks).set({ title: 'Updated linked task' }).where(eq(s.tasks.id, 'visible')).run();
    });
    for (const page of [a, b]) {
      await expect.poll(() => page.getByText('Typecheck · failing', { exact: true }).count()).toBe(1);
      await expect.poll(() => page.getByText('changes requested', { exact: true }).count()).toBe(1);
      await expect.poll(() => page.getByText('Updated linked task', { exact: true }).count()).toBe(1);
    }
    app.data.writes.run(() => app.db.delete(s.projectMembers).where(eq(s.projectMembers.member, 'sam')).run());
    for (const page of [a, b]) {
      await expect.poll(() => row(page).count()).toBe(0);
      expect(await page.getByRole('heading', { name: title, exact: true }).count()).toBe(0);
      expect(await page.getByText('Updated linked task', { exact: true }).count()).toBe(0);
    }
    // Ending a session also clears retained content and denies reconnection.
    app.data.writes.run(() => app.db.insert(s.projectMembers).values({ project: 'pond', member: 'sam' }).run());
    for (const page of [a, b]) await expect.poll(() => row(page).count()).toBe(1);
    app.data.writes.run(() => app.db.delete(s.sessions).where(eq(s.sessions.id, app.session)).run());
    for (const page of [a, b]) await expect.poll(() => row(page).count()).toBe(0);
    await b.reload();
    await expect.poll(() => b.getByText('Waiting for connection.', { exact: true }).count()).toBe(1);
    expect(await row(b).count()).toBe(0);

    app.data.writes.run(()=>app.db.update(s.changes).set({checks:'passing',review:'approved',mergeable:'yes',waitingOn:'you'}).where(eq(s.changes.id,changeId)).run());
    const request=()=>app.data.writes.run(()=>app.data.services.approvals.request({kind:'merge',target:`${changeId}@${app.db.select().from(s.changes).where(eq(s.changes.id,changeId)).get()!.headCommit}`,agent:'art',project:'pond',what:'Merge shared change',why:'Ready',askedFrom:'changes',actingFor:'unknown',ask:'Merge this exact commit?',ifYes:'Agent merges this head',ifNo:'Wait'})).value;
    const first=request();
    const owners=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900},reducedMotion:'reduce'});
    await owners.addCookies([{name:'loom_ui',value:app.ownerCookie,url:app.url}]);
    const c=await owners.newPage(), d=await owners.newPage();
    for (const page of [c,d]) page.on('pageerror',error=>errors.push(error.message));
    await Promise.all([c.goto(`${app.url}/p/changes-preview/change/${encodeURIComponent(changeId)}`),d.goto(`${app.url}/p/changes-preview/change/${encodeURIComponent(changeId)}`)]);
    for (const page of [c,d]) await expect.poll(()=>page.getByRole('button',{name:'Yes, merge it',exact:true}).count()).toBe(1);
    const shots = process.env.LOOM_TEST_SHOTS ?? join(tmpdir(),'loom-changes-piece'); mkdirSync(shots, { recursive: true });
    for (const look of ['neon', 'daylight']) for (const width of [390, 1280, 1920]) {
      await d.setViewportSize({ width, height: 900 });
      await d.evaluate(look => { document.documentElement.dataset.look = look; document.documentElement.dataset.mode = look === 'daylight' ? 'light' : 'dark'; }, look);
      await expect.poll(() => d.locator('.loom-split').getAttribute('data-mode')).toBe(width < 640 ? 'one' : 'three');
      expect(await d.locator('.loom-split').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await d.screenshot({ path: join(shots, `changes-${look}-${width}.png`), fullPage: true, animations: 'disabled' });
    }
    await c.getByRole('button',{name:'Yes, merge it',exact:true}).click();
    await expect.poll(()=>app.data.services.approvals.get(first.id).state).toBe('allowed');
    expect(app.data.services.approvals.get(first.id).decidedBy).toBe('pat');
    for (const page of [c,d]) await expect.poll(()=>page.getByRole('button',{name:'Yes, merge it',exact:true}).count()).toBe(0);
    app.data.writes.run(()=>app.db.update(s.changes).set({headCommit:'b'.repeat(40),waitingOn:'you'}).where(eq(s.changes.id,changeId)).run());
    const second=request();
    for (const page of [c,d]) await expect.poll(()=>page.getByRole('button',{name:'Not yet',exact:true}).count()).toBe(1);
    await c.getByRole('button',{name:'Not yet',exact:true}).click();
    await expect.poll(()=>app.data.services.approvals.get(second.id).state).toBe('denied');
    expect(app.data.services.approvals.get(second.id).decidedBy).toBe('pat');
    expect(app.db.select().from(s.changes).where(eq(s.changes.id,changeId)).get()!.state).toBe('open');
    await owners.close();
    expect(errors).toEqual([]);
    await context.close();
  } finally { await browser.close(); await app.close(); }
}, 60_000);
