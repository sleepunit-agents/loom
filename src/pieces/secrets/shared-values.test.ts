import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createDataSchema, dataDatabase } from '../../core/data/database.js';
import { agents, inbox, jobs, members, secrets, secretChanges, secretWriteJournal, secretGrants, secretRequests, secretRules, secretRuleAgents, secretUses } from '../../core/data/schema.js';
import { DataWrites } from '../../core/data/writes.js';
import { SecretRequests } from './requests.js';
import { SecretValues } from './shared-values.js';
import type { AsyncSecretMutations } from './async-values.js';
const clients: Database.Database[] = [], homes: string[] = [];
afterEach(() => { for (const db of clients.splice(0)) if (db.open) db.close(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function fixture(durable = false) {
  const home = mkdtempSync(join(tmpdir(), 'shared-secret-values-')); homes.push(home);
  const path = durable ? join(home, 'loom.db') : ':memory:';
  const client = new Database(path); clients.push(client);
  const now = () => '2026-11-14T12:00:00.000Z', db = createDataSchema(client, now), key = randomBytes(32);
  db.insert(members).values({ id: 'owner', role: 'owner', joinedAt: now() }).run();
  db.insert(members).values({ id: 'other', role: 'owner', joinedAt: now() }).run();
  const receipts = new Set<string>(), values = new Map<string, string>();
  const holder: AsyncSecretMutations = {
    hasReceipt: vi.fn(async who => receipts.has(JSON.stringify(who))),
    set: vi.fn(async (who, name, bytes, mode) => {
      expect(client.inTransaction).toBe(false);
      if ((mode === 'add') === values.has(name)) throw Error('Wrong mode');
      values.set(name, Buffer.from(bytes).toString()); receipts.add(JSON.stringify(who));
    }),
    remove: vi.fn(async (who, name) => { values.delete(name); receipts.add(JSON.stringify(who)); }),
  };
  const notifications = { refreshAccess: vi.fn(), changed: vi.fn() };
  const writes = new DataWrites(db, notifications);
  const service = new SecretValues(db, now, holder, key, write => { writes.run(write); });
  const input = { id: randomUUID(), member: 'owner', name: 'API', mode: 'add' as const, description: 'Purpose', value: 'NEVER-IN-LOOM-SENTINEL' };
  return { home, path, client, db, now, key, holder, service, input, values, receipts, notifications };
}
it('hands bytes only to holder and commits typed metadata/change/journal exactly once', async () => {
  const f = fixture(); let owned: Uint8Array | undefined;
  const actual = vi.mocked(f.holder.set).getMockImplementation()!;
  vi.mocked(f.holder.set).mockImplementation(async (...args) => { owned = args[2]; await actual(...args); });
  expect(await f.service.set(f.input)).toEqual({ saved: true });
  expect(owned?.every(byte => byte === 0)).toBe(true);
  expect(f.values.get('API')).toBe(f.input.value);
  expect(f.db.select().from(secrets).get()).toEqual({ name: 'API', description: 'Purpose', changedAt: f.now(), changedBy: 'owner' });
  expect(f.db.select().from(secretChanges).all()).toEqual([{ id: f.input.id, secret: 'API', action: 'add', by: 'owner', at: f.now() }]);
  expect(await f.service.set(f.input)).toEqual({ saved: true });
  expect(f.holder.set).toHaveBeenCalledTimes(1);
  for (const { name } of f.client.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as { name: string }[]) {
    expect(JSON.stringify(f.client.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all())).not.toContain(f.input.value);
  }
});
it('binds the UUID to member and complete keyed input, without calling the holder on conflicts', async () => {
  const f = fixture(); await f.service.set(f.input);
  for (const changed of [{ value: 'different' }, { member: 'other' }, { name: 'OTHER' }, { mode: 'replace' as const }, { description: 'Other purpose' }]) {
    await expect(f.service.set({ ...f.input, ...changed })).rejects.toThrow('reserved');
  }
  await expect(f.service.remove({ id: f.input.id, name: f.input.name, member: f.input.member })).rejects.toThrow('reserved');
  expect(f.holder.set).toHaveBeenCalledTimes(1); expect(f.holder.remove).not.toHaveBeenCalled();
});
it('recovers a holder commit after lost acknowledgement and durable database reopen', async () => {
  const f = fixture(true), actual = vi.mocked(f.holder.set).getMockImplementation()!;
  vi.mocked(f.holder.set).mockImplementation(async (...args) => { await actual(...args); throw Error(f.input.value); });
  await expect(f.service.set(f.input)).rejects.toThrow(/^Secret write awaits reconciliation$/);
  expect(f.db.select().from(secretWriteJournal).get()?.state).toBe('prepared');
  expect(f.db.select().from(secrets).all()).toEqual([]);
  f.service.close(); f.client.close();
  const reopened = new Database(f.path); clients.push(reopened); reopened.pragma('foreign_keys = ON');
  const db = dataDatabase(reopened, f.now), service = new SecretValues(db, f.now, f.holder, f.key, write => { new DataWrites(db, { refreshAccess() {}, changed() {} }).run(write); });
  await service.reconcilePending();
  expect(db.select().from(secretWriteJournal).get()?.state).toBe('committed');
  expect(db.select().from(secretChanges).all()).toHaveLength(1);
  await expect(service.set(f.input)).resolves.toEqual({ saved: true });
  expect(f.holder.set).toHaveBeenCalledTimes(1);
});
it('negative recovery evidence retains reservation and lets exact input retry', async () => {
  const f = fixture(), actual = vi.mocked(f.holder.set).getMockImplementation()!;
  vi.mocked(f.holder.set).mockRejectedValueOnce(Error(f.input.value));
  await expect(f.service.set(f.input)).rejects.toThrow(/^Secret write awaits reconciliation$/);
  await f.service.reconcilePending();
  expect(f.db.select().from(secretWriteJournal).get()?.state).toBe('prepared');
  await expect(f.service.set({ ...f.input, id: randomUUID(), name: 'OTHER' })).rejects.toThrow('reconciliation');
  vi.mocked(f.holder.set).mockImplementation(actual);
  await expect(f.service.set(f.input)).resolves.toEqual({ saved: true });
});
it('metadata failure rolls audit and journal back together, then positive receipt repairs without repeating mutation', async () => {
  const f = fixture();
  f.client.exec("CREATE TRIGGER fail_change BEFORE INSERT ON secret_changes BEGIN SELECT RAISE(ABORT, 'failure'); END");
  await expect(f.service.set(f.input)).rejects.toThrow('reconciliation');
  expect(f.db.select().from(secrets).all()).toEqual([]);
  expect(f.db.select().from(secretWriteJournal).get()?.state).toBe('prepared');
  f.client.exec('DROP TRIGGER fail_change'); await f.service.reconcilePending();
  expect(f.db.select().from(secretChanges).all()).toHaveLength(1); expect(f.holder.set).toHaveBeenCalledTimes(1);
});
it('removal retains history, records removal and supports a new holder add in the same clock tick', async () => {
  const f = fixture(); await f.service.set(f.input);
  const remove = { id: randomUUID(), member: 'owner', name: 'API' };
  expect(await f.service.remove(remove)).toEqual({ removed: true });
  expect(f.values.has('API')).toBe(false);
  expect(f.db.select().from(secretChanges).all().map(row => row.action)).toEqual(['add', 'removed']);
  await expect(f.service.remove(remove)).resolves.toEqual({ removed: true });
  await expect(f.service.set({ ...f.input, id: randomUUID(), value: 'REPLACEMENT' })).resolves.toEqual({ saved: true });
  expect(f.values.get('API')).toBe('REPLACEMENT');
  expect(f.db.select().from(secretChanges).all()).toHaveLength(3);
});
it('close while receipt is awaiting prevents a mutation and all later database work', async () => {
  const f = fixture(); let release!: (found: boolean) => void;
  vi.mocked(f.holder.hasReceipt).mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const pending = f.service.set(f.input); await Promise.resolve();
  f.service.close(); f.client.close(); release(false);
  await expect(pending).rejects.toThrow(/^Secret write awaits reconciliation$/);
  expect(f.holder.set).not.toHaveBeenCalled();
});
it('refuses an unrelated outer transaction before reserving or contacting holder', async () => {
  const f = fixture(); f.client.exec('BEGIN');
  await expect(f.service.set(f.input)).rejects.toThrow('reconciliation'); f.client.exec('ROLLBACK');
  expect(f.holder.hasReceipt).not.toHaveBeenCalled(); expect(f.db.select().from(secretWriteJournal).all()).toEqual([]);
});
it('never treats a caller-selected existing holder UUID as evidence for a new journal write', async () => {
  const f = fixture();
  f.receipts.add(JSON.stringify({ member: f.input.member, writeId: f.input.id }));
  await f.service.set(f.input);
  expect(f.holder.set).toHaveBeenCalledTimes(1);
  const who = vi.mocked(f.holder.set).mock.calls[0][0];
  expect(who.member).toBe(f.input.member); expect(who.writeId).not.toBe(f.input.id);
  expect(who.writeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
it('publishes reservation and completed metadata through the required shared write boundary', async () => {
  const f = fixture(); const snapshots: string[][] = [];
  f.notifications.changed.mockImplementation(() => { snapshots.push(f.db.select().from(secretChanges).all().map(row => row.action)); });
  await f.service.set(f.input);
  expect(snapshots).toEqual([[], ['add']]);
  expect(f.notifications.refreshAccess).toHaveBeenCalledTimes(2);
  expect(f.notifications.refreshAccess.mock.invocationCallOrder[1]).toBeLessThan(f.notifications.changed.mock.invocationCallOrder[1]);
});
it('uses a daemon-keyed full-input fingerprint instead of an offline-testable digest', async () => {
  const f = fixture(), other = fixture(); await f.service.set(f.input); await other.service.set(f.input);
  const canonical = JSON.stringify([f.input.member, f.input.id, f.input.name, f.input.mode, f.input.description, f.input.value]);
  const fingerprint = f.db.select().from(secretWriteJournal).get()!.inputHash;
  expect(fingerprint).toBe(createHmac('sha256', f.key).update('loom-shared-secret-write-v1\0').update(canonical).digest('hex'));
  expect(fingerprint).not.toBe(other.db.select().from(secretWriteJournal).get()!.inputHash);
  expect(fingerprint).not.toBe(createHash('sha256').update(canonical).digest('hex'));
  expect(fingerprint).not.toBe(createHash('sha256').update(f.input.value).digest('hex'));
});
it('replaces successfully with actor/description audit and exactly one holder mutation on retry', async () => {
  const f = fixture(); await f.service.set(f.input);
  const replacement = { ...f.input, id: randomUUID(), member: 'other', mode: 'replace' as const, value: 'NEW-VALUE', description: 'New purpose' };
  await expect(f.service.set(replacement)).resolves.toEqual({ saved: true });
  await expect(f.service.set(replacement)).resolves.toEqual({ saved: true });
  expect(f.values.get('API')).toBe(replacement.value);
  expect(f.db.select().from(secrets).get()).toMatchObject({ description: 'New purpose', changedBy: 'other' });
  expect(f.db.select().from(secretChanges).all()).toEqual([
    { id: f.input.id, secret: 'API', action: 'add', by: 'owner', at: f.now() },
    { id: replacement.id, secret: 'API', action: 'replace', by: 'other', at: f.now() },
  ]);
  expect(f.holder.set).toHaveBeenCalledTimes(2);
});
it('removal revokes grants and requests, resolves pending Inbox mail, clears startup assignments and retains use history', async () => {
  const f = fixture(); await f.service.set(f.input);
  f.db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  f.db.insert(jobs).values({ id: 'job', agent: 'art', title: '', brief: '', houseRepository: '', houseFile: '', houseBranch: '', state: 'running', model: 'test', startedByKind: 'agent', startedBy: 'art', queuedAt: f.now() }).run();
  const requests = new SecretRequests(f.db, f.now);
  for (const id of ['pending', 'allowed', 'denied']) requests.request({ id, secret: 'API', agent: 'art', job: 'job', why: 'Use the credential', minutes: 5 });
  requests.answer('allowed', 'owner', true); requests.answer('denied', 'owner', false);
  requests.setRule({ secret: 'API', answer: 'auto', minutes: 5, agents: [{ agent: 'art', when: 'at_start' }, { agent: 'art', when: 'on_request' }] });
  f.db.insert(secretUses).values({ id: 'use', secret: 'API', agent: 'art', job: 'job', at: f.now(), state: 'released' }).run();
  expect(f.db.select().from(secretGrants).all()).toHaveLength(1);
  expect(f.db.select().from(inbox).all().filter(row => row.state === 'waiting')).toHaveLength(2);
  await f.service.remove({ id: randomUUID(), member: 'owner', name: 'API' });
  expect(f.db.select().from(secretGrants).all()).toEqual([]);
  expect(f.db.select().from(secretRequests).all().map(row => [row.id, row.state])).toEqual([['pending', 'cancelled'], ['allowed', 'revoked'], ['denied', 'denied']]);
  expect(f.db.select().from(inbox).all().filter(row => row.state === 'waiting')).toEqual([]);
  expect(f.db.select().from(secretRules).get()).toMatchObject({ answer: 'ask', minutes: 5 });
  expect(f.db.select().from(secretRuleAgents).all()).toEqual([]);
  expect(f.db.select().from(secretUses).all()).toHaveLength(1);
  expect(f.db.select().from(secretChanges).all().map(row => row.action)).toEqual(['add', 'removed']);
  expect(f.db.select().from(secrets).all()).toHaveLength(1);
});
it.each(['set', 'remove', 'reconcile'] as const)('close during %s prevents database work after its acknowledgement', async kind => {
  const f = fixture(); let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  let pending: Promise<unknown>;
  if (kind === 'reconcile') {
    vi.mocked(f.holder.set).mockRejectedValueOnce(Error('lost'));
    await expect(f.service.set(f.input)).rejects.toThrow('reconciliation');
    vi.mocked(f.holder.hasReceipt).mockImplementation(async () => { entered(); await blocked; return true; });
    pending = f.service.reconcilePending();
  } else if (kind === 'remove') {
    await f.service.set(f.input);
    vi.mocked(f.holder.remove).mockImplementation(async () => { entered(); await blocked; });
    pending = f.service.remove({ id: randomUUID(), member: 'owner', name: 'API' });
  } else {
    vi.mocked(f.holder.set).mockImplementation(async () => { entered(); await blocked; });
    pending = f.service.set(f.input);
  }
  await started; f.service.close(); f.client.close(); release();
  if (kind === 'reconcile') await expect(pending).resolves.toBeUndefined();
  else await expect(pending).rejects.toThrow(/^Secret write awaits reconciliation$/);
});
