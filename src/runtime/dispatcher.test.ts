import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema } from '../core/data/database.js';
import { Conversations } from '../core/conversations/index.js';
import { agents, members, boxes, agentModels, agentBoxes, agentRunSettings, memberAgents, modelAccounts, modelAccountWindows, modelAccountBoxes, jobs, jobNeeds, boxFacts } from '../core/data/schema.js';
import { Dispatcher } from './dispatcher.js';
const opened: Database.Database[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });
function fixture() {
  const client = new Database(':memory:'); opened.push(client);
  let at = '2026-11-14T20:00:00.000Z';
  const now = () => at, db = createDataSchema(client, now);
  db.insert(members).values({ id: 'owner', role: 'owner', joinedAt: at }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(memberAgents).values({ member: 'owner', agent: 'art' }).run();
  for (const id of ['first', 'second']) {
    db.insert(boxes).values({ id, name: id, owner: 'owner', sameMachineAsLoom: id === 'first', hostsAny: true, reportOnly: false, alwaysOn: false, enrolledAt: at, lastSeenAt: at }).run();
    db.insert(agentBoxes).values({ agent: 'art', box: id, position: id === 'first' ? 0 : 1 }).run();
  }
  db.insert(agentModels).values({ agent: 'art', model: 'primary', position: 0 }).run();
  db.insert(agentRunSettings).values({ agent: 'art', houseRepository: 'repo', houseFile: 'Housefile', houseBranch: 'main', nestedContainers: false, gpu: false }).run();
  db.insert(modelAccounts).values({ id: 'account', owner: 'owner', provider: 'provider', label: 'Subscription', hasRoom: true }).run();
  db.insert(modelAccountWindows).values({ account: 'account', window: 'week', usage: 0.2, usageReadAt: at, resetsAt: '2026-11-14T21:00:00.000Z', durationMs: 7 * 86400_000 }).run();
  db.insert(modelAccountBoxes).values([{ account: 'account', box: 'first' }, { account: 'account', box: 'second' }]).run();
  const roles = [{ model: 'primary', provider: 'provider', harness: 'codex', series: 'series' }];
  const runtime = new Dispatcher(db, now, () => roles), comms = new Conversations(db, now);
  const conversation = comms.open({ agent: 'art', venue: 'loom', place: 'thread', label: 'Reply', member: 'owner' });
  const mail = comms.send({ toKind: 'agent', to: 'art', conversation: conversation.id, source: 'thread', fromKind: 'person', fromId: 'owner', words: 'Private brief' });
  const job = runtime.jobs.admit(conversation.id)!;
  const tick = (ms: number) => { at = new Date(Date.parse(at) + ms).toISOString(); };
  return { client, db, now, tick, runtime, comms, conversation, mail, job, roles };
}
it('claims only on the selected worker and delivers an execution-ready snapshot once', () => {
  const f = fixture();
  expect(f.runtime.next('second')).toBeUndefined();
  expect(f.runtime.next('first')).toEqual({ id: f.job.id, box: 'first', agent: 'art', conversation: f.conversation.id,
    model: 'primary', account: 'account', harness: 'codex', brief: 'Private brief', house: { repository: 'repo', file: 'Housefile', branch: 'main' } });
  expect(f.runtime.next('first')).toBeUndefined();
  expect(f.runtime.next('second')).toBeUndefined();
  expect(f.runtime.jobs.get(f.job.id).state).toBe('starting');
});
it('connects worker acknowledgements and reports to receipts and terminal lifecycle', () => {
  const f = fixture(); f.runtime.next('first');
  expect(f.runtime.heartbeat('first', f.job.id, 'starting')).toEqual({ active: true });
  expect(f.runtime.started('first', f.job.id, 'image')).toEqual({ ok: true });
  expect(f.runtime.heartbeat('first', f.job.id, 'starting')).toEqual({ active: false });
  expect(f.runtime.heartbeat('first', f.job.id, 'running')).toEqual({ active: true });
  f.comms.take(f.conversation.id, f.job.id); f.comms.confirm(f.mail.id, f.job.id);
  expect(f.runtime.finish('first', f.job.id, 0, 'done').job).toMatchObject({ state: 'done', build: 'image', exitCode: 0 });
  expect(f.runtime.heartbeat('first', f.job.id, 'running')).toEqual({ active: false });
});
it('foreign worker reports cannot change the assigned job', () => {
  const f = fixture(); f.runtime.next('first');
  expect(f.runtime.heartbeat('second', f.job.id, 'starting')).toEqual({ active: false });
  expect(() => f.runtime.started('second', f.job.id, 'wrong')).toThrow();
  expect(() => f.runtime.finish('second', f.job.id, 0, 'wrong')).toThrow();
  expect(f.runtime.jobs.get(f.job.id)).toMatchObject({ state: 'starting', box: 'first', build: null });
});
it('polls refresh health while idle/report-only and revoked workers cannot claim', () => {
  const f = fixture(); f.tick(30_000);
  f.db.update(boxes).set({ reportOnly: true }).where(eq(boxes.id, 'first')).run();
  expect(f.runtime.next('first')).toBeUndefined();
  expect(f.db.select().from(boxes).where(eq(boxes.id, 'first')).get()?.lastSeenAt).toBe(f.now());
  expect(f.runtime.jobs.get(f.job.id).state).toBe('queued');
  f.db.update(boxes).set({ revokedAt: f.now() }).where(eq(boxes.id, 'first')).run();
  expect(() => f.runtime.next('first')).toThrow('Machine not available');
});
it('start retries respect backoff and preserve house snapshots through the dispatcher', () => {
  const f = fixture(); f.runtime.next('first');
  const retry = f.runtime.finish('first', f.job.id, 1, 'launch failed').retry!;
  f.db.update(agentRunSettings).set({ houseFile: 'Changed' }).run();
  expect(f.runtime.next('first')).toBeUndefined();
  f.tick(1_000);
  expect(f.runtime.next('first')).toMatchObject({ id: retry.id, house: { file: 'Housefile' } });
});
it('current capacity can select the next allowed model and records that worker request', () => {
  const f = fixture();
  f.db.update(modelAccounts).set({ hasRoom: false }).run();
  f.db.insert(agentModels).values({ agent: 'art', model: 'fallback', position: 1 }).run();
  f.roles.push({ model: 'fallback', provider: 'other', harness: 'claude', series: 'other-series' });
  f.db.insert(modelAccounts).values({ id: 'other', owner: 'owner', provider: 'other', label: 'Other subscription', hasRoom: true }).run();
  f.db.insert(modelAccountWindows).values({ account: 'other', window: 'week', usage: 0.2, usageReadAt: f.now(), resetsAt: '2026-11-14T21:00:00.000Z', durationMs: 7 * 86400_000 }).run();
  f.db.insert(modelAccountBoxes).values({ account: 'other', box: 'first' }).run();
  expect(f.runtime.next('first')).toMatchObject({ model: 'fallback', account: 'other', harness: 'claude' });
  expect(f.db.select().from(jobs).where(eq(jobs.id, f.job.id)).get()?.model).toBe('fallback');
});
it('a failed placement leaves the job queued and never releases its brief', () => {
  const f = fixture(); f.db.update(modelAccounts).set({ hasRoom: false }).run();
  expect(f.runtime.next('first')).toBeUndefined();
  expect(f.runtime.jobs.get(f.job.id)).toMatchObject({ box: null, state: 'queued', claimedAt: null });
});
it('keeps machine health when a report rejects, without changing the foreign or ended job', () => {
  const f = fixture(); f.runtime.next('first'); f.tick(10_000);
  expect(() => f.runtime.started('second', f.job.id, 'wrong')).toThrow();
  expect(f.db.select().from(boxes).where(eq(boxes.id, 'second')).get()?.lastSeenAt).toBe(f.now());
  f.runtime.started('first', f.job.id, 'image'); f.runtime.finish('first', f.job.id, 0, 'done'); f.tick(10_000);
  expect(() => f.runtime.finish('first', f.job.id, 0, 'duplicate')).toThrow();
  expect(f.db.select().from(boxes).where(eq(boxes.id, 'first')).get()?.lastSeenAt).toBe(f.now());
  expect(f.runtime.jobs.get(f.job.id)).toMatchObject({ state: 'done', logTail: 'done' });
});
it('refreshes health on every successful phase report', () => {
  const f = fixture(); f.runtime.next('first');
  const health = () => f.db.select().from(boxes).where(eq(boxes.id, 'first')).get()?.lastSeenAt;
  f.tick(10_000); f.runtime.started('first', f.job.id, 'image'); expect(health()).toBe(f.now());
  f.tick(10_000); f.runtime.heartbeat('first', f.job.id, 'running'); expect(health()).toBe(f.now());
  f.tick(10_000); f.runtime.finish('first', f.job.id, 0, 'done'); expect(health()).toBe(f.now());
});
it('holds the same transaction across placement reads and claim', () => {
  const f = fixture();
  const runtime = new Dispatcher(f.db, f.now, () => { expect(f.client.inTransaction).toBe(true); return f.roles; });
  const claim = runtime.jobs.claim.bind(runtime.jobs);
  const observed = vi.spyOn(runtime.jobs, 'claim').mockImplementation((...args) => { expect(f.client.inTransaction).toBe(true); return claim(...args); });
  expect(runtime.next('first')?.id).toBe(f.job.id);
  expect(observed).toHaveBeenCalledOnce();
});
it('forwards required capabilities and bypasses an ineligible preferred worker', () => {
  const f = fixture();
  f.db.insert(jobNeeds).values({ job: f.job.id, need: 'gpu:5090' }).run();
  f.db.insert(boxFacts).values({ box: 'second', fact: 'gpu:5090', fromOwner: false }).run();
  expect(f.runtime.next('first')).toBeUndefined();
  expect(f.runtime.next('second')?.id).toBe(f.job.id);
});
it('revocation rejects all phase reports for an already assigned worker', () => {
  const f = fixture(); f.runtime.next('first');
  f.db.update(boxes).set({ revokedAt: f.now() }).where(eq(boxes.id, 'first')).run();
  expect(() => f.runtime.started('first', f.job.id, 'image')).toThrow('Machine not available');
  expect(() => f.runtime.heartbeat('first', f.job.id, 'starting')).toThrow('Machine not available');
  expect(() => f.runtime.finish('first', f.job.id, 1, 'stop')).toThrow('Machine not available');
  expect(f.runtime.jobs.get(f.job.id).state).toBe('starting');
});
it('keeps the trusted dispatch import graph free of process and credential I/O', async () => {
  const { readFile } = await import('node:fs/promises');
  const { dirname, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { init, parse } = await import('es-module-lexer');
  await init();
  const seen = new Set<string>();
  const walk = async (path: string): Promise<void> => {
    if (seen.has(path)) return; seen.add(path);
    const source = await readFile(path, 'utf8');
    expect(source).not.toMatch(/\b(?:require|eval|fetch)\s*\(|\bprocess\s*\.\s*(?:env|getBuiltinModule|loadEnvFile|binding)\b/);
    for (const entry of parse(source)[0]) {
      if (entry.typeOnly) continue;
      expect(entry.type).toBe('static');
      const name = entry.specifier!;
      if (name.startsWith('.')) await walk(resolve(dirname(path), name.replace(/\.js$/, '.ts')));
      else expect(['drizzle-orm', 'drizzle-orm/sqlite-core', 'node:crypto']).toContain(name);
    }
  };
  await walk(fileURLToPath(new URL('./dispatcher.ts', import.meta.url)));
  expect(seen.size).toBeGreaterThan(1);
});
