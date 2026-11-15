import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { sharedSigninLinks } from './shared-links.js';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { FakeClock } from '../clock.js';
import { createDataSchema } from '../data/database.js';
import { members, sessions, signinLinks, tokens } from '../data/schema.js';
import { sharedRoot } from '../../shared-root.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const credential = 'a'.repeat(64), other = 'b'.repeat(64);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture(publicOrigin?: string) {
  const client = new Database(':memory:'); cleanup.push(() => client.close());
  const clock = new FakeClock(), at = new Date(clock.now()).toISOString();
  const db = createDataSchema(client, () => new Date(clock.now()).toISOString());
  for (const id of ['sam', 'other']) db.insert(members).values({ id, role: 'member', joinedAt: at }).run();
  for (const [id, raw] of [['sam', credential], ['other', other]]) db.insert(tokens).values({ fingerprint: hash(raw), kind: 'owner', member: id, label: id, createdAt: at }).run();
  const errors: unknown[] = [];
  const root = sharedRoot({ db, clock, publicOrigin, originAllowed: () => true, reportError: error => errors.push(error) }); cleanup.push(() => root.close());
  const mint = (headers: Record<string, string> = { authorization: 'Bearer ' + credential }, input: unknown = {}) => root.http.request('http://loom/api/signin/link', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ input }) });
  const link = async () => {
    const response = await mint(); expect(response.status).toBe(200);
    const result = await response.json() as { ok: true; value: { path: string; expiresAt: string } };
    return result.value.path;
  };
  const redeem = (path: string, headers: Record<string, string> = {}) => root.http.request('http://loom' + path, { method: 'POST', headers });
  const read = (cookie: string) => root.http.request('http://loom/graphql', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ query: '{ tasks { id } }' }) });
  return { client, db, clock, root, errors, mint, link, redeem, read };
}

it('mints only for the admitted bearer and spends one link into a shared fingerprint-only session', async () => {
  const f = fixture();
  const response = await f.mint({ authorization: 'Bearer ' + credential }, { member: 'other', token: hash(other), actor: { kind: 'member', id: 'other' } });
  expect(response.status).toBe(200);
  const result = await response.json() as { value: { path: string } };
  const path = result.value.path, code = path.split('/').at(-1)!;
  expect(f.db.select().from(signinLinks).get()).toMatchObject({ id: hash(code), token: hash(credential) });
  const before = f.db.select().from(signinLinks).all();
  const page = await f.root.http.request('http://loom' + path);
  expect(page.status).toBe(200); expect(page.headers.get('referrer-policy')).toBe('no-referrer');
  const html = await page.text();
  expect(html).not.toContain(code);
  expect(html).toContain('<form method="post">'); expect(html).toContain('<button>Sign in</button>');
  expect(f.db.select().from(signinLinks).all()).toEqual(before); // navigation/prefetch spends nothing
  const signed = await f.redeem(path);
  expect(signed.status).toBe(303); expect(signed.headers.get('cache-control')).toBe('no-store');
  const setCookie = signed.headers.get('set-cookie')!;
  expect(setCookie).toContain('HttpOnly'); expect(setCookie).toContain('SameSite=Strict'); expect(setCookie).toContain('Max-Age=2592000');
  const cookie = setCookie.split(';', 1)[0], rawCookie = cookie.slice('loom_ui='.length);
  expect(f.db.select().from(sessions).get()).toMatchObject({ id: hash(rawCookie), token: hash(credential), via: 'link', isAgent: false });
  expect(await (await f.read(cookie)).json()).toEqual({ data: { tasks: [] } });
  expect((await f.redeem(path)).status).toBe(401);
  const serialized = JSON.stringify({ links: f.db.select().from(signinLinks).all(), sessions: f.db.select().from(sessions).all(), tokens: f.db.select().from(tokens).all() });
  for (const secret of [credential, code, rawCookie]) expect(serialized).not.toContain(secret);
  expect(f.client.prepare('SELECT * FROM operation_results').all()).toEqual([]);
  expect(f.client.prepare("SELECT name FROM sqlite_schema WHERE name GLOB 'core_*'").all()).toEqual([]);
});

it('allows only one concurrent redemption and rolls back link consumption if session persistence fails', async () => {
  const f = fixture(), path = await f.link();
  f.client.exec("CREATE TRIGGER reject_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  expect((await f.redeem(path)).status).toBe(401);
  expect(f.db.select().from(signinLinks).all()).toHaveLength(1); expect(f.db.select().from(sessions).all()).toEqual([]);
  f.client.exec('DROP TRIGGER reject_session');
  const responses = await Promise.all([f.redeem(path), f.redeem(path)]);
  expect(responses.map(response => response.status).sort()).toEqual([303, 401]);
  expect(f.db.select().from(sessions).all()).toHaveLength(1);
});

it.each(['link', 'token', 'revoked'])('refuses expired or revoked authority before redemption: %s', async how => {
  const f = fixture(), path = await f.link();
  if (how === 'link') f.clock.advance(5 * 60_000);
  else f.db.update(tokens).set(how === 'token' ? { expiresAt: new Date(f.clock.now()).toISOString() } : { revokedAt: new Date(f.clock.now()).toISOString() }).where(eq(tokens.fingerprint, hash(credential))).run();
  expect((await f.redeem(path)).status).toBe(401); expect(f.db.select().from(sessions).all()).toEqual([]);
});

it('uses a six-hour agent browser session and secure cookies at the configured HTTPS origin', async () => {
  const f = fixture('https://loom'), path = await f.link();
  const signed = await f.redeem(path, { 'user-agent': 'Mozilla/5.0 HeadlessChrome/140.0' });
  expect(signed.headers.get('set-cookie')).toContain('Max-Age=21600'); expect(signed.headers.get('set-cookie')).toContain('; Secure');
  const cookie = signed.headers.get('set-cookie')!.split(';', 1)[0];
  expect(f.db.select().from(sessions).get()?.isAgent).toBe(true);
  expect((await f.read(cookie)).status).toBe(200);
  f.clock.advance(6 * 3600_000); expect((await f.read(cookie)).status).toBe(401);
});

it('refuses cross-origin requests, cookies or a fingerprint as minting authority, and follows session deletion', async () => {
  const f = fixture();
  expect((await f.mint({ authorization: 'Bearer ' + credential, origin: 'https://elsewhere.test' })).status).toBe(403);
  expect((await f.mint({ authorization: 'Bearer ' + hash(credential) })).status).toBe(401);
  const path = await f.link(), signed = await f.redeem(path), cookie = signed.headers.get('set-cookie')!.split(';', 1)[0];
  expect((await f.mint({ cookie })).status).toBe(401);
  f.root.writes.run(() => f.db.delete(sessions).run());
  expect((await f.read(cookie)).status).toBe(401);
  const next = await f.link(); expect((await f.redeem(next, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
  await f.root.close(); expect((await f.redeem(next)).status).toBe(503);
});

it('admits the newly issued cookie on the real shared socket and ends that same browser on logout', async () => {
  const f = fixture(), signed = await f.redeem(await f.link()), cookie = signed.headers.get('set-cookie')!.split(';', 1)[0];
  const second = await f.redeem(await f.link()), secondCookie = second.headers.get('set-cookie')!.split(';', 1)[0];
  const identity = await f.root.http.request('http://loom/auth/session', { headers: { cookie } });
  expect(await identity.json()).toEqual({ viewer: { kind: 'member', id: 'sam' } });
  const server = createServer(), detach = f.root.attach(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { detach(); await f.root.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  const origin = `http://127.0.0.1:${address.port}`;
  const ws = new WebSocket(origin.replace('http:', 'ws:') + '/graphql', 'graphql-transport-ws', { headers: { cookie, origin } });
  cleanup.push(() => ws.terminate()); await once(ws, 'open');
  let next = once(ws, 'message'); ws.send(JSON.stringify({ type: 'connection_init' })); await next;
  next = once(ws, 'message'); ws.send(JSON.stringify({ type: 'subscribe', id: 'tasks', payload: { query: '{ tasks { id } }' } }));
  expect(JSON.parse(String((await next)[0])).payload.data).toEqual({ tasks: [] });
  const otherSocket = new WebSocket(origin.replace('http:', 'ws:') + '/graphql', 'graphql-transport-ws', { headers: { cookie: secondCookie, origin } });
  cleanup.push(() => otherSocket.terminate()); await once(otherSocket, 'open');
  const otherAck = once(otherSocket, 'message'); otherSocket.send(JSON.stringify({ type: 'connection_init' })); await otherAck;
  const closed = once(ws, 'close');
  const out = await f.root.http.request('http://loom/logout', { method: 'POST', headers: { cookie } });
  expect(out.status).toBe(200); expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
  expect((await closed)[0]).toBe(4403);
  expect((await f.read(cookie)).status).toBe(401);
  expect((await f.read(secondCookie)).status).toBe(200);
  expect(otherSocket.readyState).toBe(WebSocket.OPEN);
  const still = once(otherSocket, 'message'); otherSocket.send(JSON.stringify({ type: 'subscribe', id: 'still', payload: { query: '{ tasks { id } }' } }));
  expect(JSON.parse(String((await still)[0])).payload.data).toEqual({ tasks: [] });
  expect(await (await f.root.http.request('http://loom/auth/session', { headers: { cookie } })).json()).toEqual({ viewer: null });
});

it('caps links and browser cookie lifetime at their token deadline', async () => {
  const f = fixture(), expiresAt = new Date(f.clock.now() + 10_000).toISOString();
  f.db.update(tokens).set({ expiresAt }).where(eq(tokens.fingerprint, hash(credential))).run();
  const path = await f.link(); expect(f.db.select().from(signinLinks).get()?.expiresAt).toBe(expiresAt);
  const signed = await f.redeem(path); expect(signed.headers.get('set-cookie')).toContain('Max-Age=10');
  const cookie = signed.headers.get('set-cookie')!.split(';', 1)[0];
  f.clock.advance(10_000); expect((await f.read(cookie)).status).toBe(401);
});

it.each(['code', 'token'])('stores a recognized device name rather than a raw credential supplied as User-Agent: %s', async value => {
  const f = fixture(), path = await f.link(), code = path.split('/').at(-1)!;
  expect((await f.redeem(path, { 'user-agent': value === 'code' ? code : credential })).status).toBe(303);
  expect(f.db.select().from(sessions).get()?.device).toBe('Browser');
  const stored = JSON.stringify(f.db.select().from(sessions).all());
  expect(stored).not.toContain(code); expect(stored).not.toContain(credential);
});

it('lets trusted callers explicitly create an agent session with a six-hour lifetime', () => {
  const f = fixture(), signin = sharedSigninLinks(f.db, f.clock);
  const path = f.root.writes.run(() => signin.makeLink(hash(credential))).value.path;
  const result = f.root.writes.run(() => signin.redeem(path.split('/').at(-1)!, 'Agent browser', true)).value;
  expect(result.maxAge).toBe(21600); expect(f.db.select().from(sessions).get()?.isAgent).toBe(true);
});

it.each([false, true])('keeps one committed session and reports notification failure without retry, even if reporter throws=%s', async throws => {
  const f = fixture(), path = await f.link(), error = new Error('notification failed');
  const run = f.root.writes.run.bind(f.root.writes);
  const write = vi.spyOn(f.root.writes, 'run').mockImplementation(<T>(work: () => T) => ({ ...run(work), notificationErrors: [error] }));
  const reporter = throws ? vi.spyOn(f.errors, 'push').mockImplementation(() => { throw new Error('reporter failed'); }) : undefined;
  try {
    const response = await f.redeem(path);
    expect(response.status).toBe(303); expect(response.headers.get('set-cookie')).toContain('loom_ui=');
    expect(f.db.select().from(sessions).all()).toHaveLength(1); expect(f.db.select().from(signinLinks).all()).toEqual([]);
    if (reporter) expect(reporter).toHaveBeenCalledExactlyOnceWith(error); else expect(f.errors).toEqual([error]);
    expect((await f.redeem(path)).status).toBe(401); expect(f.db.select().from(sessions).all()).toHaveLength(1);
  } finally { write.mockRestore(); reporter?.mockRestore(); }
});

it('expires an ordinary browser after the thirty-day lifetime', async () => {
  const f = fixture(), response = await f.redeem(await f.link()), cookie = response.headers.get('set-cookie')!.split(';', 1)[0];
  expect(response.headers.get('set-cookie')).toContain('Max-Age=2592000');
  f.clock.advance(30 * 86400_000 - 1); expect((await f.read(cookie)).status).toBe(200);
  f.clock.advance(1); expect((await f.read(cookie)).status).toBe(401);
});
