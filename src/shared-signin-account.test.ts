import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { agents, members, notificationDevices, sessions, tokens } from './core/data/schema.js';
import { sharedRoot } from './shared-root.js';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const credentials = { owner: 'a'.repeat(64), lee: 'b'.repeat(64), art: 'c'.repeat(64) };
const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });
function fixture(changed?: () => void) {
  const client = new Database(':memory:'); clean.push(() => { client.close(); });
  const clock = new FakeClock(), at = new Date(clock.now()).toISOString(), db = createDataSchema(client, () => new Date(clock.now()).toISOString());
  db.insert(members).values([{ id: 'owner', role: 'owner', joinedAt: at }, { id: 'lee', role: 'member', joinedAt: at }]).run();
  db.insert(agents).values({ id: 'art', about: 'Fixture', markBg: '#000000', markFg: '#ffffff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(tokens).values([
    { fingerprint: hash(credentials.owner), label: 'Owner', kind: 'owner', member: 'owner', createdAt: at },
    { fingerprint: hash(credentials.lee), label: 'Lee', kind: 'owner', member: 'lee', createdAt: at },
    { fingerprint: hash(credentials.art), label: 'Art', kind: 'agent', agent: 'art', createdAt: at },
  ]).run();
  for (const [name, member] of [['first', 'lee'], ['second', 'lee'], ['owner', 'owner']] as const) {
    db.insert(sessions).values({ id: hash(name), token: hash(credentials[member]), device: name, via: 'link', isAgent: false, issuedAt: at, seenAt: at, provedAt: at }).run();
    db.insert(notificationDevices).values({ endpoint: 'https://push.invalid/PRIVATE-'+name, member, session: hash(name), keys: 'PRIVATE PUSH KEYS', device: name, createdAt: at, seenAt: at }).run();
  }
  const errors: unknown[] = [];
  const root = sharedRoot({ db, clock, originAllowed: () => true, changed, reportError: error => errors.push(error) }); clean.push(() => root.close());
  const call = (operation: string, input: unknown, actor: keyof typeof credentials = 'owner', id = 'request') => root.http.request('http://loom/api/signin/'+operation, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer '+credentials[actor] }, body: JSON.stringify({ input, id }),
  });
  return { db, client, clock, root, errors, call };
}
it('ends one member-owned browser and its notification device while preserving every other browser', async () => {
  const f = fixture(), input = { id: hash('first') };
  expect(await (await f.call('endSession', input, 'lee')).json()).toEqual({ ok: true, value: input });
  expect(f.root.services.signin.sessions().map(row => row.device)).toEqual(expect.arrayContaining(['second', 'owner']));
  expect(f.db.select().from(sessions).all()).toHaveLength(2);
  expect(f.root.services.signin.devices().map(row => row.device).sort()).toEqual(['owner', 'second']);
  expect(await (await f.call('endSession', input, 'lee')).json()).toEqual({ ok: true, value: input });
  expect(f.client.prepare('SELECT count(*) AS n FROM operation_results').get()).toEqual({ n: 1 });
});
it('denies other-member and agent browser/device changes before effects or receipts', async () => {
  const f = fixture(), device = f.root.services.signin.devices('owner')[0].id;
  expect((await f.call('endSession', { id: hash('owner') }, 'lee')).status).toBe(403);
  expect((await f.call('removeDevice', { id: device }, 'lee')).status).toBe(403);
  for (const operation of ['endSession', 'removeDevice', 'revokeToken']) expect((await f.call(operation, { id: hash('first') }, 'art')).status).toBe(403);
  expect(f.db.select().from(sessions).all()).toHaveLength(3);
  expect(f.db.select().from(notificationDevices).all()).toHaveLength(3);
  expect(f.client.prepare('SELECT * FROM operation_results').all()).toEqual([]);
});
it('removes only an explicitly selected device and keeps its session working', async () => {
  const f = fixture(), input = { id: f.root.services.signin.devices('lee')[0].id };
  expect((await f.call('removeDevice', input, 'lee')).status).toBe(200);
  expect(f.db.select().from(notificationDevices).all()).toHaveLength(2);
  expect(f.db.select().from(sessions).all()).toHaveLength(3);
  expect((await f.call('removeDevice', input, 'lee')).status).toBe(200);
});
it('allows only current owners to revoke household tokens and withdraws their bearer immediately', async () => {
  const f = fixture(), input = { id: hash(credentials.lee) };
  expect((await f.call('revokeToken', input, 'lee')).status).toBe(403);
  expect((await f.call('revokeToken', input)).status).toBe(200);
  expect((await f.call('endSession', { id: hash('first') }, 'lee')).status).toBe(401);
  f.root.writes.run(() => f.client.exec("UPDATE members SET role='member' WHERE id='owner'"));
  expect((await f.call('revokeToken', input)).status).toBe(403);
});
it('rolls back browser/device changes when receipt persistence fails', async () => {
  const f = fixture();
  f.client.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  expect((await f.call('endSession', { id: hash('first') }, 'lee')).status).toBe(503);
  expect(f.db.select().from(sessions).all()).toHaveLength(3);
  expect(f.db.select().from(notificationDevices).all()).toHaveLength(3);
});
it('reports publication failure once after committed removal and safely replays without another notification', async () => {
  let changed = 0;
  const f = fixture(() => { changed++; throw Error('fixture notification failed'); });
  const input = { id: hash('first') };
  expect((await f.call('endSession', input, 'lee')).status).toBe(200);
  expect((await f.call('endSession', input, 'lee')).status).toBe(200);
  expect(changed).toBe(1); expect(f.errors).toHaveLength(1);
  expect(f.db.select().from(sessions).all()).toHaveLength(2);
});
it('keeps typed metadata free of raw cookie/token/push credentials and scopes member lists', () => {
  const f = fixture();
  expect(f.root.services.signin.sessions('lee')).toHaveLength(2);
  expect(f.root.services.signin.devices('lee')).toHaveLength(2);
  const output = JSON.stringify({ sessions: f.root.services.signin.sessions(), devices: f.root.services.signin.devices(), tokens: f.root.services.signin.tokens() });
  for (const secret of [...Object.values(credentials), 'PRIVATE-', 'PRIVATE PUSH KEYS']) expect(output).not.toContain(secret);
  expect(output).not.toContain('fingerprint'); expect(output).not.toContain('endpoint');
});

it('does not mistake an existing nonmember session for a missing idempotent target', async () => {
  const f = fixture(), at = new Date(f.clock.now()).toISOString();
  f.db.insert(sessions).values({ id: hash('agent-cookie'), token: hash(credentials.art), device: 'Agent', via: 'token', isAgent: true, issuedAt: at, seenAt: at, provedAt: at }).run();
  expect((await f.call('endSession', { id: hash('agent-cookie') }, 'lee')).status).toBe(403);
  expect(f.db.select().from(sessions).all()).toHaveLength(4);
  expect((await f.call('endSession', { id: hash('agent-cookie') })).status).toBe(200);
});
it('ends the current cookie session immediately even when the final command response loses authentication', async () => {
  const f = fixture(), raw = 'd'.repeat(64), at = new Date(f.clock.now()).toISOString();
  f.db.insert(sessions).values({ id: hash(raw), token: hash(credentials.lee), device: 'Current', via: 'link', isAgent: false, issuedAt: at, seenAt: at, provedAt: at }).run();
  const response = await f.root.http.request('http://loom/api/signin/endSession', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'loom_ui='+raw }, body: JSON.stringify({ input: { id: hash(raw) }, id: 'self-end' }) });
  expect(response.status).toBe(403);
  expect(f.db.select().from(sessions).all()).toHaveLength(3);
  expect(await (await f.root.http.request('http://loom/auth/session', { headers: { cookie: 'loom_ui='+raw } })).json()).toEqual({ viewer: null });
  expect(f.client.prepare('SELECT count(*) AS n FROM operation_results').get()).toEqual({ n: 1 });
});
