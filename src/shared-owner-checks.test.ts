/** The doors outside the policy module's own files ask the one current-owner check: a removed owner is nobody. */
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { agents, inbox, jobs, memberAgents, members, secrets, secretChanges } from './core/data/schema.js';
import { sharedTokenOwner } from './core/signin/shared-tokens.js';
import { bridgeSecretsReaderFields } from './pieces/bridges/readers.js';
import { SecretRequests } from './pieces/secrets/requests.js';
import type { Viewer } from './policy.js';
import { OperationResults } from './core/data/operation-results.js';
import { DataWrites } from './core/data/writes.js';
import { Operations } from './core/operations/index.js';
import { BridgeSettings } from './pieces/bridges/settings.js';
import { registerSharedBridgeCommands } from './shared-bridge-commands.js';
import { registerSharedJobControl } from './shared-job-control.js';
const close: (() => unknown)[] = [];
afterEach(async () => { for (const f of close.splice(0).reverse()) await f(); });
function fixture() {
  const client = new Database(':memory:'); close.push(() => client.close());
  const clock = new FakeClock(), at = new Date(clock.now()).toISOString(), db = createDataSchema(client, () => at);
  db.insert(members).values([{ id: 'owner', role: 'owner', joinedAt: at }, { id: 'gone', role: 'owner', joinedAt: at, removedAt: at }, { id: 'lee', role: 'member', joinedAt: at }, { id: 'sam', role: 'member', joinedAt: at }]).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '', markFg: '', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(memberAgents).values([{ member: 'lee', agent: 'art' }, { member: 'gone', agent: 'art' }]).run();
  // The operations alone, with no door in front: authentication already refuses a removed member's
  // credential, so only here can each operation's own check be seen to refuse one.
  const operations = new Operations(client, clock, () => {}, { receipts: new OperationResults(db), writes: new DataWrites(db, { refreshAccess() {}, changed() {} }), reportError: () => {} }); close.push(() => operations.close());
  registerSharedJobControl(operations, db, { now: () => at, jobEnded() {} });
  registerSharedBridgeCommands(operations, db, new BridgeSettings(db, () => at, write => write()));
  const root = { operations };
  const job = () => { const id = 'job-' + randomUUID(); db.insert(jobs).values({ id, agent: 'art', title: '', state: 'queued', brief: '', model: 'm', startedByKind: 'member', startedBy: 'owner', houseRepository: '', houseFile: '', houseBranch: '', queuedAt: at }).run(); return id; };
  const member = (id: string): Viewer => ({ kind: 'member', id });
  return { db, at, root, job, member };
}
it('lets a current household owner or the agent\'s own member end a job, and nobody removed or unrelated', () => {
  const f = fixture(), stop = (who: string) => f.root.operations.call('http', f.member(who), 'runtime.jobStop', { job: f.job(), reason: 'reset' }, randomUUID());
  expect(stop('owner')).toMatchObject({ ok: true });
  expect(stop('lee')).toMatchObject({ ok: true });
  expect(stop('sam')).toMatchObject({ ok: false, code: 'denied' });
  // Still an owner by role and still on the agent's list, but removed from the household.
  expect(stop('gone')).toMatchObject({ ok: false, code: 'denied' });
});
it('refuses a removed owner the bridge review, the bridge and secrets reader facts and the token door', () => {
  const f = fixture(), review = { action: 'review', id: 'missing', decision: 'dismiss' };
  expect(f.root.operations.call('http', f.member('gone'), 'bridges.command', review, randomUUID())).toMatchObject({ ok: false, code: 'denied' });
  expect(f.root.operations.call('http', f.member('lee'), 'bridges.command', review, randomUUID())).toMatchObject({ ok: false, code: 'denied' });
  // The owner passes the check and reaches the service, which has no such reply.
  expect(f.root.operations.call('http', f.member('owner'), 'bridges.command', review, randomUUID())).toMatchObject({ ok: false, code: 'invalid' });
  const fields = bridgeSecretsReaderFields(f.db), read = (name: 'bridgeReader' | 'secretsReader', who: string) => (fields[name].resolve as (s: unknown, a: unknown, c: { viewer: Viewer }) => unknown)(null, {}, { viewer: f.member(who) });
  expect(read('bridgeReader', 'owner')).toEqual({ id: 'owner', manage: true });
  expect(read('bridgeReader', 'lee')).toEqual({ id: 'lee', manage: false });
  expect(read('bridgeReader', 'gone')).toBeNull();
  expect(read('secretsReader', 'owner')).toMatchObject({ id: 'owner' });
  expect(read('secretsReader', 'gone')).toBeNull();
  expect(read('secretsReader', 'lee')).toBeNull();
  expect(sharedTokenOwner(f.db, f.member('owner'))).toBe(true);
  expect(sharedTokenOwner(f.db, f.member('gone'))).toBe(false);
});
it('asks only the current owners about a secret request', () => {
  const f = fixture();
  f.db.insert(secrets).values({ name: 'TOKEN', description: '', changedAt: f.at, changedBy: 'owner' }).run();
  f.db.insert(secretChanges).values({ id: 'c-1', secret: 'TOKEN', action: 'add', by: 'owner', at: f.at }).run();
  new SecretRequests(f.db, () => f.at).request({ id: 'q-1', secret: 'TOKEN', agent: 'art', minutes: 5, why: 'Deploy' } as never);
  expect(f.db.select().from(inbox).where(eq(inbox.source, 'secret-request')).all().map(row => row.to)).toEqual(['owner']);
});
