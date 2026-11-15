import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { members, agents, tokens, sessions, projects, changes, approvalRecord, operationResults } from './core/data/schema.js';
import { sharedRoot } from './shared-root.js';
import { sharedSharing } from './shared-sharing.js';
import { mayAct, type RecordScope } from './policy.js';
import type { Approval } from './apps/approvals.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const cookie = 'b'.repeat(64), token = 'a'.repeat(64), head = 'a'.repeat(40), changeId = 'github:house/pond#1';
function fixture(install = true) {
  const client = new Database(':memory:'); cleanup.push(() => { client.close(); });
  const clock = new FakeClock(), at = new Date(clock.now()).toISOString();
  const db = createDataSchema(client, () => new Date(clock.now()).toISOString());
  db.insert(members).values({ id: 'sam', role: 'owner', joinedAt: at }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(projects).values({ id: 'pond', name: 'Pond' }).run();
  db.insert(tokens).values({ fingerprint: hash(token), label: 'Sam', kind: 'owner', member: 'sam', createdAt: at }).run();
  db.insert(sessions).values({ id: hash(cookie), token: hash(token), device: 'Browser', via: 'token', isAgent: false, issuedAt: at, seenAt: at, provedAt: at }).run();
  const scope = (row: Approval): RecordScope => ({ type: 'approval', agent: row.agent, project: row.project ?? undefined, member: row.member ?? undefined });
  // A fixture caller explicitly supplies the existing household authority rule.
  // This is not a default policy for the new shared kinds.
  const root = sharedRoot({ db, clock, originAllowed: () => true, reportError: () => {},
    workAnswerAuthority: install ? {
      approval: (viewer, row) => mayAct(viewer, scope(row), sharedSharing(db), 'household'),
      change: (viewer, row, approval) => mayAct(viewer, { type: 'change', agent: row.agent ?? undefined, project: row.project ?? undefined }, sharedSharing(db), 'household') && mayAct(viewer, scope(approval), sharedSharing(db), 'household'),
    } : undefined,
  });
  cleanup.push(() => root.close());
  const request = () => root.writes.run(() => root.services.approvals.request({ kind: 'merge', target: `${changeId}@${head}`, agent: 'art', project: 'pond', what: 'Merge pump', why: 'Ready', askedFrom: 'loom', actingFor: 'owner', ask: 'Merge?', ifYes: 'Agent merges this head', ifNo: 'Wait' })).value;
  const send = (piece: string, input: unknown, id = 'answer') => root.http.request(`http://loom/api/${piece}/answer`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'loom_ui=' + cookie }, body: JSON.stringify({ input, id }) });
  const seedChange = () => db.insert(changes).values({ id: changeId, repository: 'house/pond', number: 1, title: 'Pump', body: '', url: 'https://github.com/house/pond/pull/1', state: 'open', draft: false, authorLogin: 'art', project: 'pond', agent: 'art', branch: 'pump', headCommit: head, baseBranch: 'next', checks: 'passing', review: 'approved', mergeable: 'yes', waitingOn: 'you', openedAt: at, updatedAt: at }).run();
  return { db, root, request, send, seedChange };
}

it('does not install an answer route without the caller-supplied authority gate', async () => {
  const f = fixture(false), request = f.request();
  expect((await f.send('approvals', { id: request.id, answer: 'allow' })).status).toBe(404);
  expect(f.root.services.approvals.get(request.id).state).toBe('pending');
  expect(f.db.select().from(operationResults).all()).toEqual([]);
});

it('binds approval answers to the current member, receipts and current supplied authority', async () => {
  const f = fixture(), request = f.request(), input = { id: request.id, answer: 'allow' };
  expect(await (await f.send('approvals', input)).json()).toEqual({ ok: true, value: { id: request.id } });
  expect((await f.send('approvals', input)).status).toBe(200);
  expect(f.root.services.approvals.get(request.id)).toMatchObject({ state: 'allowed', decidedBy: 'sam' });
  expect(f.db.select().from(approvalRecord).all().map(row => row.event)).toEqual(['request', 'allow']);
  expect((await f.send('approvals', { ...input, member: 'other' }, 'spoof')).status).toBe(400);
  f.root.writes.run(() => f.db.update(members).set({ role: 'member' }).where(eq(members.id, 'sam')).run());
  expect((await f.send('approvals', input)).status).toBe(403);
  expect(f.db.select().from(operationResults).all()).toHaveLength(1);
});

it('keeps an exact-head merge answer atomic and refuses stale replay after the head moves', async () => {
  const f = fixture(); f.seedChange(); const request = f.request();
  const input = { id: changeId, head, approval: request.id, answer: 'yes' };
  expect(await (await f.send('changes', input)).json()).toEqual({ ok: true, value: { id: changeId } });
  expect(f.db.select().from(changes).get()?.waitingOn).toBe('agent');
  expect((await f.send('changes', input)).status).toBe(200);
  f.root.writes.run(() => f.db.update(changes).set({ headCommit: 'c'.repeat(40) }).run());
  expect((await f.send('changes', input)).status).toBe(409);
  expect((await f.send('changes', input, 'fresh-stale')).status).toBe(409);
  expect(f.root.services.approvals.get(request.id).target).toBe(`${changeId}@${head}`);
  expect(f.db.select().from(operationResults).all()).toHaveLength(1);
});
