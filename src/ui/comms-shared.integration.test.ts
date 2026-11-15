/** One shipped Comms proof. CI owns Chromium; all rows and credentials are fictitious. */
import { it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { chromium } from 'playwright-core';
import { eq } from 'drizzle-orm';
import { generateX25519Identity } from 'age-encryption';
import { FakeClock } from '../core/clock.js';
import { createDataSchema } from '../core/data/database.js';
import { dataAuthentication } from '../core/data/authentication.js';
import { OperationResults } from '../core/data/operation-results.js';
import { members, memberAgents, agents, messages, inbox, operationResults, threads } from '../core/data/schema.js';
import { Operations } from '../core/operations/index.js';
import { Live } from '../core/live/index.js';
import { CommsMessages } from '../core/conversations/messages.js';
import { CommsQueries, commsQueryFields } from '../core/conversations/comms-query.js';
import { InboxQueries, inboxQueryFields } from '../core/conversations/inbox-query.js';
import { registerConversationOperations } from '../core/conversations/operations.js';
import { wordsKey } from '../pieces/comms/crypto.js';
import { nextData } from '../next-data.js';
const root = resolve(import.meta.dirname, '../../dist/web');
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', chromium.executablePath()].find(p => p && existsSync(p));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
it.runIf(chrome && existsSync(join(root, 'next.html')))('shipped shared Comms sends, receives and answers inline across windows, then withdraws revoked reads', async () => {
  const client = new Database(':memory:'), clock = new FakeClock(Date.now());
  const now = () => new Date(clock.now()).toISOString(), db = createDataSchema(client, now);
  db.insert(members).values({ id: 'alice', role: 'member', joinedAt: now() }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(memberAgents).values({ member: 'alice', agent: 'art' }).run();
  const token = 't'.repeat(64), cookie = 'c'.repeat(64);
  client.prepare('INSERT INTO tokens (fingerprint,label,kind,member,created_at,expires_at) VALUES (?,?,?,?,?,?)').run(hash(token), 'Fixture', 'owner', 'alice', now(), new Date(clock.now() + 3600000).toISOString());
  client.prepare('INSERT INTO sessions (id,token,device,via,is_agent,issued_at,seen_at,proved_at) VALUES (?,?,?,?,?,?,?,?)').run(hash(cookie), hash(token), 'Browser', 'token', 0, now(), now(), now());
  const key = wordsKey(await generateX25519Identity()), comms = new CommsMessages(db, key, now);
  const thread = comms.threads.open({ member: 'alice', agent: 'art', title: 'Pump' });
  const question = await comms.ask(thread.id, 'art', 'question', { words: 'PRIVATE PUMP QUESTION', answers: 'yes-no', why: 'A private reason' });
  // This proof supplies a strict recipient policy. Default-root sharing and
  // sign-in composition are covered by their own owner, rather than emulated here.
  const query = new InboxQueries(db, key, (viewer, fields) => eq(fields.member, viewer.id), now);
  const originAllowed = (req: import('node:http').IncomingMessage) => !req.headers.origin || req.headers.origin === `http://${req.headers.host}`;
  const data = nextData(db, clock, originAllowed, undefined, { ...inboxQueryFields(query), ...commsQueryFields(new CommsQueries(db, key, (viewer, fields) => eq(fields.member, viewer.id), now)) });
  let live!: Live;
  const operations = new Operations(client, clock, changes => live.changed(changes), {
    receipts: new OperationResults(db), writes: data.writes, reportError: error => { throw error; },
  });
  live = new Live(clock, operations);
  registerConversationOperations(operations, comms, { authorize: (viewer, access) => viewer.kind === 'member' &&
    ('item' in access ? access.item.toKind === 'person' && access.item.to === viewer.id && access.item.member === viewer.id : access.action === 'open' ? access.member === viewer.id && access.agent === 'art' : access.conversation.member === viewer.id) });
  const authenticate = dataAuthentication(db, () => clock.now());
  const auth = (req: import('node:http').IncomingMessage) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(',') : value);
    return authenticate(new Request('http://localhost/', { headers }));
  };
  const graphql = getRequestListener(data.http.fetch);
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/graphql') { void graphql(req, res); return; }
    if (path === '/auth/session') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ viewer: auth(req)?.viewer ?? null, csrf: '' })); return; }
    const file = path.startsWith('/app/') ? resolve(root, path.slice(5)) : join(root, 'next.html');
    if (!file.startsWith(root + '/') || !existsSync(file)) { res.writeHead(404).end(); return; }
    res.setHeader('content-type', ({ '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' } as Record<string, string>)[extname(file)] ?? 'application/octet-stream');
    res.end(readFileSync(file));
  });
  const detachQuery = data.attach(server), detachLive = live.attach(server, auth, originAllowed);
  let browser: import('playwright-core').Browser | undefined;
  try {
    await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
    const address = server.address(); if (!address || typeof address === 'string') throw Error('No address');
    const url = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    context.setDefaultTimeout(10_000);
    await context.addCookies([{ name: 'loom_ui', value: cookie, url }]);
    const a = await context.newPage(), b = await context.newPage();
    await Promise.all([a, b].map(page => page.goto(`${url}/p/comms-preview/thread/${encodeURIComponent(thread.id.replace(/^th:/,''))}`)));
    for (const page of [a, b]) await expect.poll(() => page.getByRole('heading', { name: 'PRIVATE PUMP QUESTION', exact: true }).count()).toBe(1);
    await a.getByRole('textbox', { name: 'Message art', exact: true }).fill('PRIVATE PERSON MESSAGE');
    await a.getByRole('button', { name: 'Send', exact: true }).click();
    for (const page of [a, b]) await expect.poll(() => page.getByText('PRIVATE PERSON MESSAGE', { exact: true }).count()).toBe(1);
    await comms.send({ thread: thread.id, kind: 'reply', sender: 'art', words: 'PRIVATE AGENT REPLY' }); data.changed();
    for (const page of [a, b]) await expect.poll(() => page.getByText('PRIVATE AGENT REPLY', { exact: true }).count()).toBe(1);
    await a.getByRole('button', { name: 'Allow', exact: true }).click();
    for (const page of [a, b]) {
      await expect.poll(() => page.getByRole('button', { name: 'Allow', exact: true }).count()).toBe(0);
      await expect.poll(() => page.getByRole('heading', { name: 'Answer', exact: true }).count()).toBe(1);
    }
    await a.getByRole('button', { name: 'Pin', exact: true }).click();
    await expect.poll(() => db.select().from(threads).where(eq(threads.id,thread.id)).get()?.pinned).toBe(true);
    await expect.poll(() => db.select().from(threads).where(eq(threads.id,thread.id)).get()?.readSeq).toBe(4);
    expect(db.select().from(messages).all()).toHaveLength(4);
    const durable = JSON.stringify([db.select().from(inbox).all(), db.select().from(operationResults).all()]);
    for (const words of ['PRIVATE PUMP QUESTION','PRIVATE PERSON MESSAGE','PRIVATE AGENT REPLY']) expect(durable).not.toContain(words);
    if (process.env.LOOM_SHOTS) {
      mkdirSync(process.env.LOOM_SHOTS, { recursive: true });
      await a.screenshot({ path: join(process.env.LOOM_SHOTS, 'comms-shared-wide.png'), fullPage: true });
      await b.setViewportSize({ width: 390, height: 844 });
      await b.screenshot({ path: join(process.env.LOOM_SHOTS, 'comms-shared-phone.png'), fullPage: true });
    }
    client.prepare('UPDATE tokens SET revoked_at=? WHERE fingerprint=?').run(now(), hash(token));
    data.changed(); live.refreshAccess();
    for (const page of [a, b]) for (const words of ['PRIVATE PUMP QUESTION','PRIVATE PERSON MESSAGE','PRIVATE AGENT REPLY']) await expect.poll(() => page.getByText(words, { exact: true }).count()).toBe(0);
  } finally {
    await browser?.close(); detachQuery(); detachLive(); live.close(); operations.close(); await data.close();
    await new Promise<void>(ok => server.close(() => ok())); client.close();
  }
});
