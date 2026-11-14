import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDataSchema } from './database.js';
import { dataAuthentication } from './authentication.js';
import { dataHttp } from './http.js';
import { members, tokens, sessions } from './schema.js';
const clients: Database.Database[] = [];
afterEach(() => clients.splice(0).forEach(c => c.close()));
const raw = 'a'.repeat(64), cookie = 'b'.repeat(64);
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const at = '2026-11-14T00:00:00.000Z';
function fixture() {
  const client = new Database(':memory:'); clients.push(client);
  const db = createDataSchema(client);
  db.insert(members).values({ id: 'sam', role: 'member', joinedAt: at }).run();
  db.insert(tokens).values({ fingerprint: hash(raw), label: 'sam', kind: 'owner', member: 'sam', createdAt: at }).run();
  db.insert(sessions).values({ id: hash(cookie), token: hash(raw), device: 'browser', via: 'token', isAgent: true, issuedAt: at, seenAt: at, provedAt: at }).run();
  let time = Date.parse(at);
  const authenticate = dataAuthentication(db, () => time);
  const request = (headers: Record<string, string>) => new Request('http://loom/graphql', { headers });
  return { client, db, authenticate, request, tick: (n: number) => { time += n; } };
}
it('resolves raw bearer/cookie while rejecting stored fingerprints and malformed bearer precedence', () => {
  const { authenticate, request } = fixture();
  expect(authenticate(request({ authorization: 'Bearer ' + raw }))?.viewer).toEqual({ kind: 'member', id: 'sam' });
  expect(authenticate(request({ cookie: 'loom_ui=' + cookie }))?.window).toBe(true);
  expect(authenticate(request({ authorization: 'Bearer ' + hash(raw) }))).toBeUndefined();
  expect(authenticate(request({ cookie: 'loom_ui=' + hash(cookie) }))).toBeUndefined();
  expect(authenticate(request({ authorization: 'bad', cookie: 'loom_ui=' + cookie }))).toBeUndefined();
});
it('revalidates session deletion, token revocation/expiry and identity rebinding', () => {
  const { db, authenticate, request, tick } = fixture();
  const session = authenticate(request({ cookie: 'loom_ui=' + cookie }))!;
  const bearer = authenticate(request({ authorization: 'Bearer ' + raw }))!;
  expect(session.valid()).toBe(true);
  tick(6 * 3600000);
  expect(session.valid()).toBe(false);
  expect(bearer.valid()).toBe(true);
  db.update(tokens).set({ expiresAt: '2026-11-14T06:00:00.000Z' }).run();
  expect(bearer.valid()).toBe(false);
  db.update(tokens).set({ expiresAt: null, revokedAt: at }).run();
  expect(bearer.valid()).toBe(false);
  db.update(tokens).set({ revokedAt: null }).run();
  db.delete(sessions).run();
  expect(session.valid()).toBe(false);
  db.insert(members).values({ id: 'other', role: 'member', joinedAt: at }).run();
  db.update(tokens).set({ member: 'other' }).where(eq(tokens.fingerprint, hash(raw))).run();
  expect(bearer.valid()).toBe(false);
});
it('serves the HTTP door through actual shared credentials and rejects revoked ones', async () => {
  const { db, client } = fixture();
  const app = dataHttp(db);
  const read = () => app.request('http://loom/graphql', { method: 'POST', headers: { authorization: 'Bearer ' + raw, 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ tasks { id } }' }) });
  expect(await (await read()).json()).toEqual({ data: { tasks: [] } });
  db.update(tokens).set({ revokedAt: at }).run();
  expect((await read()).status).toBe(401);
});

it('invalidates an unexpired deleted session independently of expiry', () => {
  const { db, authenticate, request } = fixture();
  const session = authenticate(request({ cookie: 'loom_ui=' + cookie }))!;
  expect(session.valid()).toBe(true);
  db.delete(sessions).run();
  expect(session.valid()).toBe(false);
});
it('ordinary browsers last thirty days, with an exact expiry boundary', () => {
  const { db, authenticate, request, tick } = fixture();
  db.update(sessions).set({ isAgent: false }).run();
  const session = authenticate(request({ cookie: 'loom_ui=' + cookie }))!;
  tick(30 * 86400000 - 1);
  expect(session.valid()).toBe(true);
  tick(1);
  expect(session.valid()).toBe(false);
});
