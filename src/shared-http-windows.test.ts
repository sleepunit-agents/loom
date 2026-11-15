import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { agents, members, sessions, tokens, tasks } from './core/data/schema.js';
import { sharedRoot } from './shared-root.js';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const bearer = 'a'.repeat(64), cookie = 'b'.repeat(64), agentToken = 'c'.repeat(64), agentCookie = 'd'.repeat(64);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture(gate: 'all' | 'record', prepare?: () => Promise<unknown>) {
  const client = new Database(':memory:'); cleanup.push(() => { client.close(); });
  const clock = new FakeClock(), at = new Date(clock.now()).toISOString(), db = createDataSchema(client, () => new Date(clock.now()).toISOString());
  db.insert(members).values({ id: 'sam', role: 'owner', joinedAt: at }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(tokens).values([{ fingerprint: hash(bearer), label: 'Sam', kind: 'owner', member: 'sam', createdAt: at }, { fingerprint: hash(agentToken), label: 'Art', kind: 'agent', agent: 'art', createdAt: at }]).run();
  db.insert(sessions).values([{ id: hash(cookie), token: hash(bearer), device: 'Browser', via: 'link', isAgent: false, issuedAt: at, seenAt: at, provedAt: at }, { id: hash(agentCookie), token: hash(agentToken), device: 'Browser', via: 'link', isAgent: false, issuedAt: at, seenAt: at, provedAt: at }]).run();
  const root = sharedRoot({ db, clock, originAllowed: () => true, reportError: () => {} }); cleanup.push(() => root.close());
  const privateTask = root.services.tasks.create({ title: 'Private fixture', goal: 'Works', why: 'Needed', owner: { kind: 'member', id: 'sam' } }, { kind: 'member', id: 'sam' });
  root.operations.register({ name: 'private.save', write: true, recheckPolicy: true,
    input: z.object({ id: z.string() }).strict(), output: z.object({ ack: z.literal(true) }),
    ...(gate === 'all' ? { windowOnly: true } : { requiresWindow: (input: { id: string }) => db.select().from(tasks).where(eq(tasks.id, input.id)).get()?.ownerKind === 'member' }),
    // Admit both identities here so the window gate itself must exclude agents.
    may: viewer => (viewer.kind === 'member' && viewer.id === 'sam') || (viewer.kind === 'agent' && viewer.id === 'art'), prepare,
    run(ctx, input) { root.services.tasks.edit(input.id, { title: 'Saved' }); ctx.changed('task', input.id); return { ack: true }; },
  });
  const call = (headers: Record<string,string> = { cookie: 'loom_ui='+cookie }, id = 'save', envelope: Record<string,unknown> = {}) => root.http.request('http://loom/api/private/save', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ input: { id: privateTask.id }, id, ...envelope }),
  });
  return { db, client, clock, root, call, id: privateTask.id };
}
it.each(['all','record'] as const)('admits a current member cookie for %s window gates and refuses bearer replay or forged capabilities', async gate => {
  const f = fixture(gate);
  expect((await f.call({ authorization: 'Bearer '+bearer, cookie: 'loom_ui='+cookie, 'x-window': 'true', 'x-loom-window': 'yes' })).status).toBe(403);
  expect((await f.call({ cookie: 'loom_ui=forged', 'x-window': 'true' })).status).toBe(401);
  expect((await f.call(undefined, 'forged', { window: true })).status).toBe(400);
  expect(f.client.prepare('SELECT * FROM operation_results').all()).toEqual([]);
  expect(await (await f.call()).json()).toEqual({ ok: true, value: { ack: true } });
  expect(await (await f.call()).json()).toEqual({ ok: true, value: { ack: true } });
  expect((await f.call({ authorization: 'Bearer '+bearer })).status).toBe(403);
  expect((await f.call({ cookie: 'loom_ui='+agentCookie })).status).toBe(403);
  expect(f.db.select().from(tasks).get()?.title).toBe('Saved');
  expect(f.client.prepare('SELECT count(*) AS n FROM operation_results').get()).toEqual({ n: 1 });
  for (const door of ['mcp','direct'] as const)
    expect(await f.root.operations.callAsync(door, { kind: 'member', id: 'sam' }, 'private.save', { id: f.id }, 'save', true)).toMatchObject({ ok: false, code: 'denied' });
});
it.each(['session','token','expiry'] as const)('rechecks the exact cookie %s after preparation without effects or receipt', async reason => {
  let began!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const f = fixture('all', () => { began(); return held; });
  const pending = f.call(); await started;
  if (reason === 'session') f.root.writes.run(() => f.db.delete(sessions).where(eq(sessions.id, hash(cookie))).run());
  if (reason === 'token') f.root.writes.run(() => f.db.update(tokens).set({ revokedAt: new Date(f.clock.now()).toISOString() }).where(eq(tokens.fingerprint, hash(bearer))).run());
  if (reason === 'expiry') f.clock.advance(30 * 86400000);
  release(); expect((await pending).status).toBe(403);
  expect(f.db.select().from(tasks).get()?.title).toBe('Private fixture');
  expect(f.client.prepare('SELECT * FROM operation_results').all()).toEqual([]);
});
it('rejects cross-origin cookie commands before their window capability is used', async () => {
  const f = fixture('all');
  for (const headers of [{ origin: 'https://elsewhere.test' }, { 'sec-fetch-site': 'cross-site' }] as Record<string,string>[])
    expect((await f.call({ cookie: 'loom_ui='+cookie, ...headers })).status).toBe(403);
  expect(f.db.select().from(tasks).get()?.title).toBe('Private fixture');
  expect(f.client.prepare('SELECT * FROM operation_results').all()).toEqual([]);
});
it.each([undefined, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data'])('refuses a cookie window POST with content type %s before effects or receipt', async contentType => {
  const f = fixture('all');
  const request = new Request('http://loom/api/private/save', { method: 'POST', headers: { cookie: 'loom_ui='+cookie },
    body: JSON.stringify({ input: { id: f.id }, id: 'csrf-media' }) });
  if (contentType === undefined) request.headers.delete('content-type');
  else request.headers.set('content-type', contentType);
  expect((await f.root.http.fetch(request)).status).toBe(415);
  expect(f.db.select().from(tasks).get()?.title).toBe('Private fixture');
  expect(f.client.prepare('SELECT * FROM operation_results').all()).toEqual([]);
});
