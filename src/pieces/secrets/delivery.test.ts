import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema, dataDatabase } from '../../core/data/database.js';
import { agents, jobs, members, secrets, secretChanges, secretUses } from '../../core/data/schema.js';
import { SecretRequests } from './requests.js';
import { SecretDelivery, type SecretDeliveryHolder } from './delivery.js';

const clients: Database.Database[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
function fixture() {
  const client = new Database(':memory:'); clients.push(client);
  let time = Date.parse('2026-11-14T12:00:00Z');
  const now = () => new Date(time).toISOString();
  const db = createDataSchema(client, now);
  db.insert(members).values({ id: 'owner', role: 'owner', joinedAt: now() }).run();
  for (const id of ['art', 'mark']) db.insert(agents).values({ id, about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(secrets).values({ name: 'github-token', description: '', changedAt: now(), changedBy: 'owner' }).run();
  db.insert(secretChanges).values({ id: 'initial', secret: 'github-token', action: 'add', by: 'owner', at: now() }).run();
  for (const [id, agent] of [['j-art', 'art'], ['j-mark', 'mark']]) db.insert(jobs).values({ id, agent, title: id, state: 'running', brief: '', model: 'test', startedByKind: 'agent', startedBy: agent, houseRepository: '', houseFile: '', houseBranch: '', queuedAt: now() }).run();
  const requests = new SecretRequests(db, now);
  const allow = (job?: string) => {
    const row = requests.request({ id: `q-${job ?? 'all'}`, secret: 'github-token', agent: 'art', job, why: 'Review the change', minutes: 5 });
    requests.answer(row.id, 'owner', true);
    return row.id;
  };
  const call = vi.fn<SecretDeliveryHolder['handTo']>();
  const service = new SecretDelivery(db, now, { handTo: call });
  const uses = () => db.select().from(secretUses).all();
  return { client, db, now, allow, call, service, uses, requests, advance: (ms: number) => { time += ms; } };
}

describe('shared-schema secret delivery', () => {
  it.each([false, true])('commits before release and discards holder output (async: %s)', async asynchronous => {
    const f = fixture(); f.allow();
    f.call.mockImplementation((name, destination) => {
      expect(f.client.inTransaction).toBe(false);
      expect(f.uses()).toEqual([{ id: expect.stringMatching(/^use-/), secret: name, ...destination, at: f.now(), state: 'started' }]);
      // A trusted holder accidentally returning bytes must not expose them.
      const output = Buffer.from('private credential');
      return asynchronous ? Promise.resolve(output) as unknown as Promise<void> : output as unknown as void;
    });
    const result = await f.service.handTo('github-token', 'j-art');
    expect(result).toEqual({ id: f.uses()[0].id, state: 'released' });
    expect(f.call).toHaveBeenCalledExactlyOnceWith('github-token', { agent: 'art', job: 'j-art' });
    expect(JSON.stringify(f.uses())).not.toContain('private credential');
  });

  it('does not call the holder or create an attempt without the matching agent grant', async () => {
    const f = fixture();
    await expect(f.service.handTo('github-token', 'j-art')).rejects.toThrow('current grant');
    f.allow();
    await expect(f.service.handTo('github-token', 'j-mark')).rejects.toThrow('current grant');
    await expect(f.service.handTo('other-token', 'j-art')).rejects.toThrow('current grant');
    expect(f.call).not.toHaveBeenCalled(); expect(f.uses()).toEqual([]);
  });

  it('honors job-scoped grants and revocation', async () => {
    const f = fixture(); const id = f.allow('j-art');
    f.db.insert(jobs).values({ ...f.db.select().from(jobs).where(eq(jobs.id, 'j-art')).get()!, id: 'j-other' }).run();
    await expect(f.service.handTo('github-token', 'j-other')).rejects.toThrow('current grant');
    await expect(f.service.handTo('github-token', 'j-art')).resolves.toMatchObject({ state: 'released' });
    f.requests.revoke(id);
    await expect(f.service.handTo('github-token', 'j-art')).rejects.toThrow('current grant');
    expect(f.call).toHaveBeenCalledTimes(1);
  });

  it('rejects future and expired grants at the exact boundary', async () => {
    const f = fixture(); f.allow();
    f.advance(-1);
    await expect(f.service.handTo('github-token', 'j-art')).rejects.toThrow('current grant');
    f.advance(5 * 60000);
    await expect(f.service.handTo('github-token', 'j-art')).resolves.toMatchObject({ state: 'released' });
    f.advance(1);
    await expect(f.service.handTo('github-token', 'j-art')).rejects.toThrow('current grant');
    expect(f.call).toHaveBeenCalledTimes(1);
  });

  it.each(['queued', 'starting', 'running', 'waiting', 'done', 'failed', 'stopped', 'lost'] as const)('uses the grant, without adding a %s job-state policy', async state => {
    const f = fixture(); f.allow(); f.db.update(jobs).set({ state }).run();
    await expect(f.service.handTo('github-token', 'j-art')).resolves.toMatchObject({ state: 'released' });
    expect(f.uses()[0].state).toBe('released');
  });

  it('rejects unknown jobs and refuses a surrounding transaction', async () => {
    const f = fixture(); f.allow();
    await expect(f.service.handTo('github-token', 'missing')).rejects.toThrow('existing job');
    f.client.exec('BEGIN');
    try { await expect(f.service.handTo('github-token', 'j-art')).rejects.toThrow('own transaction'); }
    finally { f.client.exec('ROLLBACK'); }
    expect(f.call).not.toHaveBeenCalled(); expect(f.uses()).toEqual([]);
  });

  it('never releases if the attempt cannot be committed', async () => {
    const f = fixture(); f.allow();
    f.client.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON secret_uses BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
    await expect(f.service.handTo('github-token', 'j-art')).rejects.toThrow('audit unavailable');
    expect(f.call).not.toHaveBeenCalled(); expect(f.uses()).toEqual([]);
  });

  it.each([false, true])('sanitizes %s asynchronous holder errors and records a failed acknowledgement', async asynchronous => {
    const f = fixture(); f.allow();
    f.call.mockImplementation(() => { if (asynchronous) return Promise.reject(Error('private credential')); throw Error('private credential'); });
    const result = await f.service.handTo('github-token', 'j-art');
    expect(result).toEqual({ id: f.uses()[0].id, state: 'failed' });
    expect(f.uses()[0].state).toBe('failed');
    expect(JSON.stringify({ result, rows: f.uses() })).not.toContain('private credential');
  });

  it('keeps an in-flight attempt started across service recreation and never replays it', async () => {
    const f = fixture(); f.allow();
    let finish!: () => void;
    f.call.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const result = f.service.handTo('github-token', 'j-art');
    expect(f.uses()[0].state).toBe('started');
    // Reopen the committed SQLite bytes, as after a crash between dispatch and
    // acknowledgement. No pending JavaScript state is present in the new service.
    const reopened = new Database(f.client.serialize()); clients.push(reopened);
    const restarted = dataDatabase(reopened, f.now);
    new SecretDelivery(restarted, f.now, { handTo: f.call });
    expect(restarted.select().from(secretUses).get()?.state).toBe('started');
    expect(f.call).toHaveBeenCalledTimes(1);
    f.requests.revoke('q-all');
    finish(); await expect(result).resolves.toMatchObject({ state: 'released' });
    await expect(f.service.handTo('github-token', 'j-art')).rejects.toThrow('current grant');
  });

  it('leaves a started attempt when completion metadata cannot be saved, without leaking holder errors', async () => {
    const f = fixture(); f.allow();
    f.client.exec("CREATE TRIGGER fail_finish BEFORE UPDATE ON secret_uses BEGIN SELECT RAISE(ABORT, 'private credential'); END");
    await expect(f.service.handTo('github-token', 'j-art')).rejects.toThrow(/^Secret delivery completion could not be recorded$/);
    expect(f.uses()[0].state).toBe('started'); expect(f.call).toHaveBeenCalledTimes(1);
  });

  it('does not let a surrounding transaction roll back completion after an asynchronous hand-off', async () => {
    const f = fixture(); f.allow();
    let finish!: () => void;
    f.call.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const result = f.service.handTo('github-token', 'j-art');
    f.client.exec('BEGIN'); finish();
    try { await expect(result).rejects.toThrow('completion could not be recorded'); }
    finally { f.client.exec('ROLLBACK'); }
    expect(f.uses()[0].state).toBe('started');
  });
});
