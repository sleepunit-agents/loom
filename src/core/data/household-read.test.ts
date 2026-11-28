/** Setup lists a browser as ended exactly when the door would refuse it. Fictional people. */
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { afterEach, expect, it } from 'vitest';
import { createDataSchema } from './database.js';
import { readHouseholdSetup } from './household-read.js';
import { currentSession, currentToken } from './authentication.js';
import { agents, boxes, jobs, members, sessions, tokens } from './schema.js';

const clean: (() => void)[] = [];
afterEach(() => { for (const close of clean.splice(0)) close(); });

it('lists a browser as ended when the door would refuse it, whatever the reason', () => {
  const client = new Database(':memory:'); clean.push(() => client.close());
  const at = '2026-11-17T12:00:00.000Z', now = Date.parse(at), db = createDataSchema(client, () => at);
  for (const id of ['sam', 'gone', 'revoked', 'old']) {
    db.insert(members).values({ id, role: 'member', joinedAt: at }).run();
    db.insert(tokens).values({ fingerprint: id.padEnd(64, '0'), label: id, kind: 'owner', member: id, createdAt: at }).run();
    db.insert(sessions).values({ id: id.padEnd(64, '1'), token: id.padEnd(64, '0'), device: 'Browser', isAgent: false, via: 'link', issuedAt: at, seenAt: at, provedAt: at }).run();
  }
  // gone was removed from the household; revoked's token was revoked. sam is as before.
  db.update(members).set({ removedAt: at }).where(eq(members.id, 'gone')).run();
  db.update(tokens).set({ revokedAt: at }).where(eq(tokens.member, 'revoked')).run();
  // old signed in long ago: the session has run out.
  db.update(sessions).set({ issuedAt: '2026-01-01T00:00:00.000Z' }).where(eq(sessions.id, 'old'.padEnd(64, '1'))).run();
  const listed = Object.fromEntries(readHouseholdSetup(db, at).sessions.map(row => [row.member, row.ended]));
  expect(listed).toEqual({ sam: false, gone: true, revoked: true, old: true });
  // And it is the door's own answer, not a second rule beside it.
  for (const id of ['sam', 'gone', 'revoked', 'old']) expect(!currentSession(db, id.padEnd(64, '1'), now), id).toBe(listed[id]);
});

it('lists a body token as ended with its job exactly when sign-in refuses it for that job', () => {
  const client = new Database(':memory:'); clean.push(() => client.close());
  const at = '2026-11-17T12:00:00.000Z', now = Date.parse(at), db = createDataSchema(client, () => at);
  db.insert(members).values({ id: 'sam', role: 'owner', joinedAt: at }).run();
  db.insert(agents).values(['art', 'mark'].map(id => ({ id, about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }))).run();
  db.insert(boxes).values({ id: 'box-1', name: 'box-1', owner: 'sam', sameMachineAsLoom: false, hostsAny: false, reportOnly: false, alwaysOn: false, enrolledAt: at }).run();
  const job = (id: string, state: typeof jobs.$inferInsert.state, extra: Partial<typeof jobs.$inferInsert> = {}) => ({ id, agent: 'art', box: 'box-1', member: 'sam', title: id, state, brief: '', model: 'fixture',
    startedByKind: 'agent', startedBy: 'art', houseRepository: 'fixture', houseFile: 'HOUSE.md', houseBranch: 'next', queuedAt: at, ...extra });
  // Every state a job can be in, and the shapes of a job sign-in refuses a body for whatever its state.
  const states = ['queued', 'starting', 'running', 'done', 'failed', 'stopped', 'lost'] as const;
  db.insert(jobs).values([...states.map(state => job(state, state)), job('terminal', 'running', { startedByKind: 'terminal' }), job('other-agent', 'running', { agent: 'mark' }),
    job('no-box', 'queued', { box: null })]).run();
  const bodies = [...states, 'terminal', 'other-agent', 'no-box'];
  db.insert(tokens).values([
    ...bodies.map(id => ({ fingerprint: id.padEnd(64, '0'), label: `body-${id}`, kind: 'agent' as const, agent: 'art', job: id, createdAt: at })),
    // Not bound to a job: an agent's own, a member's, and a body's whose row was also revoked.
    { fingerprint: 'agent'.padEnd(64, '0'), label: 'agent', kind: 'agent' as const, agent: 'art', createdAt: at },
    { fingerprint: 'sam'.padEnd(64, '0'), label: 'sam', kind: 'owner' as const, member: 'sam', createdAt: at },
    { fingerprint: 'revoked'.padEnd(64, '0'), label: 'revoked', kind: 'agent' as const, agent: 'art', job: 'done', revokedAt: at, createdAt: at },
  ]).run();
  const listed = Object.fromEntries(readHouseholdSetup(db, at).tokens.map(row => [row.label, [row.state, row.forJob]]));
  expect(listed).toEqual({
    'body-queued': ['ended with its job', true], 'body-starting': ['active', true], 'body-running': ['active', true],
    'body-done': ['ended with its job', true], 'body-failed': ['ended with its job', true], 'body-stopped': ['ended with its job', true], 'body-lost': ['ended with its job', true],
    'body-terminal': ['ended with its job', true], 'body-other-agent': ['ended with its job', true], 'body-no-box': ['ended with its job', true],
    agent: ['active', false], sam: ['active', false], revoked: ['revoked', true],
  });
  // The listing is sign-in's own answer, not a second rule beside it: it fails if the two drift apart.
  for (const id of bodies) expect(!currentToken(db, id.padEnd(64, '0'), now), id).toBe(listed[`body-${id}`]![0] === 'ended with its job');
  // A job ending moves its token across, on the next read, with no change to the token's row.
  db.update(jobs).set({ state: 'done' }).where(eq(jobs.id, 'running')).run();
  expect(readHouseholdSetup(db, at).tokens.find(row => row.label === 'body-running')?.state).toBe('ended with its job');
  expect(currentToken(db, 'running'.padEnd(64, '0'), now)).toBeFalsy();
});
