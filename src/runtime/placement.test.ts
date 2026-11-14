import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema } from '../core/data/database.js';
import { agents, members, memberAgents, boxes, boxAgents, boxFacts, agentBoxes, agentModels, modelAccounts, modelAccountBoxes } from '../core/data/schema.js';
import { selectPlacement } from './placement.js';
const opened: Database.Database[] = [];
afterEach(() => opened.splice(0).forEach(client => client.close()));
function fixture() {
  const client = new Database(':memory:'); opened.push(client);
  const db = createDataSchema(client);
  const now = '2026-11-14T20:00:00.000Z';
  db.insert(members).values({ id: 'owner', role: 'owner', joinedAt: now }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(memberAgents).values({ member: 'owner', agent: 'art' }).run();
  for (const id of ['remote', 'local']) {
    db.insert(boxes).values({ id, name: id, owner: 'owner', sameMachineAsLoom: id === 'local', hostsAny: true, reportOnly: false, alwaysOn: false, enrolledAt: now, lastSeenAt: now }).run();
    db.insert(agentBoxes).values({ agent: 'art', box: id, position: id === 'local' ? 0 : 1 }).run();
  }
  db.insert(agentModels).values([{ agent: 'art', model: 'preferred', position: 0 }, { agent: 'art', model: 'backup', position: 1 }]).run();
  db.insert(modelAccounts).values({ id: 'shared', owner: 'owner', provider: 'provider', label: 'Subscription', hasRoom: true }).run();
  db.insert(modelAccountBoxes).values([{ account: 'shared', box: 'local' }, { account: 'shared', box: 'remote' }]).run();
  const input = { agent: 'art', now, roles: [{ model: 'unlisted', provider: 'provider', harness: 'runner', series: 'series' }, { model: 'preferred', provider: 'provider', harness: 'runner', series: 'series' }, { model: 'backup', provider: 'provider', harness: 'other', series: 'series' }] };
  return { db, input };
}
it('uses ordered workers and models, with the same heartbeat requirement on loom’s machine', () => {
  const { db, input } = fixture();
  expect(selectPlacement(db, input)).toEqual({ box: 'local', model: 'preferred', account: 'shared', harness: 'runner' });
  db.update(boxes).set({ lastSeenAt: '2026-11-14T19:55:00.000Z' }).where(eq(boxes.id, 'local')).run();
  expect(selectPlacement(db, input)?.box).toBe('remote');
  db.update(boxes).set({ reportOnly: true }).where(eq(boxes.id, 'remote')).run();
  expect(selectPlacement(db, input)).toBeUndefined();
});
it('matches capabilities and never silently substitutes a disallowed requested model', () => {
  const { db, input } = fixture();
  db.insert(boxFacts).values({ box: 'remote', fact: 'gpu:5090', fromOwner: false }).run();
  expect(selectPlacement(db, { ...input, needs: ['gpu:5090'] })?.box).toBe('remote');
  expect(selectPlacement(db, { ...input, model: 'unlisted' })).toBeUndefined();
  expect(selectPlacement(db, { ...input, model: 'backup' })?.harness).toBe('other');
});
it('shares exhausted account capacity across workers and respects actual sign-in locations', () => {
  const { db, input } = fixture();
  db.delete(modelAccountBoxes).where(eq(modelAccountBoxes.box, 'local')).run();
  expect(selectPlacement(db, input)?.box).toBe('remote');
  db.update(modelAccounts).set({ hasRoom: false }).run();
  expect(selectPlacement(db, input)).toBeUndefined();
});
it('uses explicit lending when the worker does not host the agent owner’s agents', () => {
  const { db, input } = fixture();
  db.update(boxes).set({ hostsAny: false }).run();
  expect(selectPlacement(db, input)).toBeUndefined();
  db.insert(boxAgents).values({ box: 'remote', agent: 'art', lent: true }).run();
  expect(selectPlacement(db, input)?.box).toBe('remote');
  db.update(boxes).set({ revokedAt: input.now }).where(eq(boxes.id, 'remote')).run();
  expect(selectPlacement(db, input)).toBeUndefined();
});

it('rejects foreign-owned hostsAny machines and unrelated provider accounts', () => {
  const { db, input } = fixture();
  db.insert(members).values({ id: 'other', role: 'member', joinedAt: input.now }).run();
  db.update(boxes).set({ owner: 'other' }).run();
  expect(selectPlacement(db, input)).toBeUndefined();
  db.insert(boxAgents).values({ box: 'remote', agent: 'art', lent: true }).run();
  db.update(modelAccounts).set({ provider: 'unrelated' }).run();
  expect(selectPlacement(db, input)).toBeUndefined();
  db.update(modelAccounts).set({ provider: 'provider' }).run();
  expect(selectPlacement(db, input)?.box).toBe('remote');
});
it('matches complete capability values and pins the heartbeat boundary', () => {
  const { db, input } = fixture();
  db.insert(boxFacts).values({ box: 'local', fact: 'gpu:15090', fromOwner: true }).run();
  expect(selectPlacement(db, { ...input, needs: ['gpu:5090'] })).toBeUndefined();
  db.update(boxes).set({ lastSeenAt: null }).where(eq(boxes.id, 'remote')).run();
  db.update(boxes).set({ lastSeenAt: '2026-11-14T19:58:00.000Z' }).where(eq(boxes.id, 'local')).run();
  expect(selectPlacement(db, input)?.box).toBe('local');
  db.update(boxes).set({ lastSeenAt: '2026-11-14T19:57:59.999Z' }).where(eq(boxes.id, 'local')).run();
  expect(selectPlacement(db, input)).toBeUndefined();
});
it('honors configured preference positions even when they oppose identifier order', () => {
  const { db, input } = fixture();
  db.update(agentBoxes).set({ position: -1 }).where(eq(agentBoxes.box, 'remote')).run();
  db.update(agentModels).set({ position: -1 }).where(eq(agentModels.model, 'backup')).run();
  expect(selectPlacement(db, input)).toEqual({ box: 'remote', model: 'backup', account: 'shared', harness: 'other' });
});
