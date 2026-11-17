import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDataSchema } from './database.js';
import { currentSession, dataAuthentication, presentedCredential, sessionEnds } from './authentication.js';
import { dataHttp } from './http.js';
import { agents, boxes, jobs, members, programTokens, tokens, sessions } from './schema.js';
import { readHouseholdSetup } from './household-read.js';
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
  tick(6 * 3600000 - 1);
  expect(session.valid()).toBe(true);
  tick(1);
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
it('valid bearer takes precedence over a different valid cookie identity', () => {
  const { db, authenticate, request } = fixture();
  const otherRaw = 'c'.repeat(64);
  db.insert(members).values({ id: 'other', role: 'member', joinedAt: at }).run();
  db.insert(tokens).values({ fingerprint: hash(otherRaw), label: 'other', kind: 'owner', member: 'other', createdAt: at }).run();
  expect(authenticate(request({ cookie: 'loom_ui=' + cookie, authorization: 'Bearer ' + otherRaw }))?.viewer).toEqual({ kind: 'member', id: 'other' });
});
it('refuses, without any stronger door around it, a removed member, a revoked machine and a body whose job has ended', () => {
  const { db, authenticate, request } = fixture(), runner = 'c'.repeat(64), body = 'd'.repeat(64);
  db.insert(agents).values({ id: 'bot', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(boxes).values({ id: 'box', owner: 'sam', name: 'box', sameMachineAsLoom: false, hostsAny: true, reportOnly: false, alwaysOn: false, enrolledAt: at }).run();
  db.insert(jobs).values({ id: 'job', agent: 'bot', box: 'box', title: '', state: 'running', brief: '', model: 'm', startedByKind: 'agent', startedBy: 'bot', houseRepository: '', houseFile: '', houseBranch: '', queuedAt: at }).run();
  db.insert(tokens).values([{ fingerprint: hash(runner), label: 'runner', kind: 'runner', box: 'box', createdAt: at }, { fingerprint: hash(body), label: 'body', kind: 'agent', agent: 'bot', job: 'job', createdAt: at }]).run();
  const asRunner = () => authenticate(request({ authorization: 'Bearer ' + runner })), asBody = () => authenticate(request({ authorization: 'Bearer ' + body }));
  const held = { runner: asRunner()!, body: asBody()!, member: authenticate(request({ authorization: 'Bearer ' + raw }))! };
  expect(held.runner.viewer).toEqual({ kind: 'runner', id: 'box' }); expect(held.body).toMatchObject({ viewer: { kind: 'agent', id: 'bot' }, job: 'job' });
  db.update(jobs).set({ state: 'done' }).run();
  expect(held.body.valid()).toBe(false); expect(asBody()).toBeUndefined(); expect(held.runner.valid()).toBe(true);
  db.update(jobs).set({ state: 'running' }).run(); expect(asBody()).toBeDefined();
  db.update(boxes).set({ revokedAt: at }).run();
  expect(held.runner.valid()).toBe(false); expect(asRunner()).toBeUndefined(); expect(asBody()).toBeUndefined();
  db.update(members).set({ removedAt: at }).run();
  expect(held.member.valid()).toBe(false); expect(currentSession(db, hash(cookie), Date.parse(at))).toBeUndefined();
});
it('ends a body\'s token with the machine token it was enrolled from: revoked or run out, the body is nobody', () => {
  const { db, authenticate, request, tick } = fixture(), runner = 'c'.repeat(64), body = 'd'.repeat(64);
  db.insert(agents).values({ id: 'bot', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(boxes).values({ id: 'box', owner: 'sam', name: 'box', sameMachineAsLoom: false, hostsAny: true, reportOnly: false, alwaysOn: false, enrolledAt: at }).run();
  db.insert(jobs).values({ id: 'job', agent: 'bot', box: 'box', title: '', state: 'running', brief: '', model: 'm', startedByKind: 'agent', startedBy: 'bot', houseRepository: '', houseFile: '', houseBranch: '', queuedAt: at }).run();
  db.insert(tokens).values({ fingerprint: hash(runner), label: 'runner', kind: 'runner', box: 'box', createdAt: at }).run();
  db.insert(tokens).values({ fingerprint: hash(body), label: 'body', kind: 'agent', agent: 'bot', job: 'job', madeFrom: hash(runner), createdAt: at }).run();
  const asBody = () => authenticate(request({ authorization: 'Bearer ' + body })), held = asBody()!;
  expect(held).toMatchObject({ viewer: { kind: 'agent', id: 'bot' }, job: 'job' });
  // The machine and the job are untouched: only the leaked machine token is revoked.
  db.update(tokens).set({ revokedAt: at }).where(eq(tokens.fingerprint, hash(runner))).run();
  expect(held.valid()).toBe(false); expect(asBody()).toBeUndefined();
  db.update(tokens).set({ revokedAt: null, expiresAt: '2026-11-14T01:00:00.000Z' }).where(eq(tokens.fingerprint, hash(runner))).run();
  expect(asBody()).toBeDefined(); tick(3600_000); expect(asBody()).toBeUndefined();
});
it('says on a body\'s viewer which member its job is for, with no door around it, and ends the credential when that changes', () => {
  const { db, authenticate, request } = fixture(), body = 'd'.repeat(64), other = 'e'.repeat(64);
  db.insert(members).values({ id: 'lee', role: 'member', joinedAt: at }).run();
  db.insert(agents).values({ id: 'bot', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(boxes).values({ id: 'box', owner: 'sam', name: 'box', sameMachineAsLoom: false, hostsAny: true, reportOnly: false, alwaysOn: false, enrolledAt: at }).run();
  const job = { agent: 'bot', box: 'box', title: '', state: 'running' as const, brief: '', model: 'm', startedByKind: 'agent', startedBy: 'bot', houseRepository: '', houseFile: '', houseBranch: '', queuedAt: at };
  db.insert(jobs).values([{ ...job, id: 'private', member: 'sam' }, { ...job, id: 'room' }]).run();
  db.insert(tokens).values([{ fingerprint: hash(body), label: 'body', kind: 'agent', agent: 'bot', job: 'private', createdAt: at }, { fingerprint: hash(other), label: 'room', kind: 'agent', agent: 'bot', job: 'room', createdAt: at }]).run();
  const held = authenticate(request({ authorization: 'Bearer ' + body }))!;
  expect(held.viewer).toEqual({ kind: 'agent', id: 'bot', workingFor: 'sam' });
  // Work that is for no member is the agent alone.
  expect(authenticate(request({ authorization: 'Bearer ' + other }))!.viewer).toEqual({ kind: 'agent', id: 'bot' });
  // What was admitted as working for one member is not carried on as working for another.
  db.update(jobs).set({ member: 'lee' }).where(eq(jobs.id, 'private')).run();
  expect(held.valid()).toBe(false);
  expect(authenticate(request({ authorization: 'Bearer ' + body }))!.viewer).toEqual({ kind: 'agent', id: 'bot', workingFor: 'lee' });
});
it('names the one credential a request presents, and which token and session it resolved', () => {
  const { authenticate, request } = fixture();
  expect(presentedCredential(request({ authorization: 'Bearer ' + raw, cookie: 'loom_ui=' + cookie }))).toEqual({ bearer: raw });
  expect(presentedCredential(request({ cookie: 'other=1; loom_ui=' + cookie }))).toEqual({ cookie });
  expect(presentedCredential(request({ authorization: 'Basic ' + raw, cookie: 'loom_ui=' + cookie }))).toBeUndefined();
  expect(presentedCredential(request({ cookie: 'loom_ui=' + 'b'.repeat(31) + '!' }))).toBeUndefined();
  expect(authenticate(request({ authorization: 'Bearer ' + raw }))!.credential).toEqual({ token: hash(raw), session: undefined });
  expect(authenticate(request({ cookie: 'loom_ui=' + cookie }))!.credential).toEqual({ token: hash(raw), session: hash(cookie) });
});
it('shows Setup a browser as ended at the same instant the door stops accepting it', () => {
  const { db, authenticate, request, tick } = fixture();
  const ends = sessionEnds(db.select().from(sessions).get()!), shown = (time: number) => readHouseholdSetup(db, new Date(time).toISOString()).sessions[0].ended;
  tick(ends - Date.parse(at) - 1);
  expect(authenticate(request({ cookie: 'loom_ui=' + cookie }))).toBeDefined(); expect(shown(ends - 1)).toBe(false);
  tick(1);
  expect(authenticate(request({ cookie: 'loom_ui=' + cookie }))).toBeUndefined(); expect(shown(ends)).toBe(true);
});
it('never takes a program token for a whole member unless the door that applies its grants asks for it', async () => {
  const { db, authenticate, request } = fixture(), held = authenticate(request({ authorization: 'Bearer ' + raw }))!;
  db.insert(programTokens).values({ token: hash(raw) }).run();
  expect(held.valid()).toBe(false);
  expect(authenticate(request({ authorization: 'Bearer ' + raw }))).toBeUndefined();
  expect(authenticate(request({ cookie: 'loom_ui=' + cookie }))).toBeUndefined();
  // The door composed with no authenticator of its own refuses it too.
  const read = await dataHttp(db).request('http://loom/graphql', { method: 'POST', headers: { authorization: 'Bearer ' + raw, 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ tasks { id } }' }) });
  expect(read.status).toBe(401);
  expect(dataAuthentication(db, () => Date.parse(at), { programs: 'admit' })(request({ authorization: 'Bearer ' + raw }))?.viewer).toEqual({ kind: 'member', id: 'sam' });
});

it('stops a machine\'s token, and a body running there, being current while the machine\'s owner is removed', () => {
  const { db, authenticate, request } = fixture(), runner = 'c'.repeat(64), body = 'd'.repeat(64);
  db.insert(agents).values({ id: 'art', about: '', markBg: '', markFg: '', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(boxes).values({ id: 'sams', name: 'sams', owner: 'sam', sameMachineAsLoom: false, hostsAny: false, reportOnly: false, alwaysOn: false, enrolledAt: at }).run();
  db.insert(jobs).values({ id: 'job', agent: 'art', box: 'sams', title: '', brief: '', model: 'm', state: 'running', startedByKind: 'agent', startedBy: 'art', houseRepository: 'r', houseFile: 'f', houseBranch: 'b', queuedAt: at }).run();
  db.insert(tokens).values([{ fingerprint: hash(runner), label: 'Worker', kind: 'runner', box: 'sams', createdAt: at }, { fingerprint: hash(body), label: 'Body', kind: 'agent', agent: 'art', job: 'job', madeFrom: hash(runner), createdAt: at }]).run();
  const viewers = () => [runner, body].map(token => authenticate(request({ authorization: 'Bearer ' + token }))?.viewer);
  expect(viewers()).toEqual([{ kind: 'runner', id: 'sams' }, { kind: 'agent', id: 'art' }]);
  // Removing a member leaves their machines enrolled and unrevoked. To every rule a removed member is nobody.
  db.update(members).set({ removedAt: at }).where(eq(members.id, 'sam')).run();
  expect(viewers()).toEqual([undefined, undefined]);
  db.update(members).set({ removedAt: null }).where(eq(members.id, 'sam')).run();
  expect(viewers()).toEqual([{ kind: 'runner', id: 'sams' }, { kind: 'agent', id: 'art' }]);
});
