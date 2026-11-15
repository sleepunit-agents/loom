import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { agents, members, boxes, agentModels, agentBoxes, agentRunSettings, memberAgents, modelAccounts, modelAccountWindows, modelAccountBoxes, jobs, tokens, operationResults } from './core/data/schema.js';
import { sharedRoot } from './shared-root.js';
import { httpWorkerControl } from './runtime/worker-http.js';
import { workOnce } from './runtime/worker.js';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const credential = 'a'.repeat(64), otherCredential = 'b'.repeat(64), ownerCredential = 'c'.repeat(64), agentCredential = 'd'.repeat(64);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture() {
  const client = new Database(':memory:'); cleanup.push(() => { if (client.open) client.close(); });
  const clock = new FakeClock(), now = () => new Date(clock.now()).toISOString();
  const db = createDataSchema(client, now);
  db.insert(members).values({ id: 'owner', role: 'owner', joinedAt: now() }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(memberAgents).values({ member: 'owner', agent: 'art' }).run();
  for (const id of ['worker', 'other']) db.insert(boxes).values({ id, name: id, owner: 'owner', hostsAny: true, sameMachineAsLoom: false, reportOnly: false, alwaysOn: false, enrolledAt: now(), lastSeenAt: now() }).run();
  for (const [value, box] of [[credential, 'worker'], [otherCredential, 'other']]) db.insert(tokens).values({ fingerprint: hash(value), label: box, kind: 'runner', box, createdAt: now() }).run();
  db.insert(tokens).values({ fingerprint: hash(ownerCredential), label: 'Owner', kind: 'owner', member: 'owner', createdAt: now() }).run();
  db.insert(tokens).values({ fingerprint: hash(agentCredential), label: 'Agent', kind: 'agent', agent: 'art', createdAt: now() }).run();
  db.insert(agentBoxes).values({ agent: 'art', box: 'worker', position: 0 }).run();
  db.insert(agentModels).values({ agent: 'art', model: 'model', position: 0 }).run();
  db.insert(agentRunSettings).values({ agent: 'art', houseRepository: 'repo', houseFile: 'Housefile', houseBranch: 'next', nestedContainers: false, gpu: false }).run();
  db.insert(modelAccounts).values({ id: 'account', owner: 'owner', provider: 'provider', label: 'Subscription', hasRoom: true }).run();
  db.insert(modelAccountWindows).values({ account: 'account', window: 'week', usage: 0.2, usageReadAt: now(), resetsAt: new Date(clock.now() + 7 * 86400_000).toISOString(), durationMs: 7 * 86400_000 }).run();
  db.insert(modelAccountBoxes).values({ account: 'account', box: 'worker' }).run();
  const ended = vi.fn((id: string) => { expect(client.inTransaction).toBe(false); const job = db.select().from(jobs).where(eq(jobs.id, id)).get()!; expect(job.endedAt).toBe(now());
    if (job.state === 'done' || job.state === 'failed') expect(db.select().from(operationResults).all().some(row => row.operation === 'runtime.finish')).toBe(true); });
  const errors = vi.fn(); let roles = [{ model: 'model', provider: 'provider', harness: 'codex', series: 'series' }];
  const root = sharedRoot({ db, clock, originAllowed: () => true, reportError: errors, modelRoles: () => roles, runtimeJobEnded: ended });
  cleanup.push(() => root.close());
  const send = (venue: 'loom' | 'handoff' = 'loom', place = 'thread') => {
    const conversation = root.services.conversations.open({ agent: 'art', venue, place, label: place });
    const mail = root.services.conversations.send({ toKind: 'agent', to: 'art', conversation: conversation.id, source: 'thread', fromKind: 'person', fromId: 'owner', words: 'Private work instructions' });
    expect(root.services.runtime.admit({ kind: 'agent', id: 'art' }, [mail])).toBe(true);
    return db.select().from(jobs).where(eq(jobs.conversation, conversation.id)).get()!;
  };
  const call = (name: string, input: unknown, id = `${name}-id`, bearer = credential) => root.http.request(`http://loom/api/runtime/${name}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + bearer }, body: JSON.stringify({ input, id }),
  });
  const control = httpWorkerControl({ url: 'https://loom.example', token: credential, signal: new AbortController().signal,
    fetch: async (input, init) => root.http.fetch(new Request(input, init)) });
  return { root, client, db, clock, now, send, call, control, errors, ended, setRoles: (value: typeof roles) => { roles = value; } };
}
it('runs the real worker client through root authentication, shared dispatcher, receipts and commit notifications', async () => {
  const f = fixture(), queued = f.send(), released = vi.fn(async () => {}), stopped = vi.fn(async () => {});
  const run = await workOnce({ box: 'worker', control: f.control, signal: new AbortController().signal,
    schedule: { every: () => () => {} }, executor: { build: async () => 'image:built', start: assignment => {
      expect(assignment.id).toBe(queued.id); expect(assignment.brief).toBe('');
      return { spawned: Promise.resolve(), exited: Promise.resolve({ exitCode: 0, logTail: 'private-log-output' }), release: released, stop: stopped };
    } } });
  expect(run).toBe('finished'); expect(released).toHaveBeenCalledOnce(); expect(stopped).toHaveBeenCalled();
  expect(f.db.select().from(jobs).where(eq(jobs.id, queued.id)).get()).toMatchObject({ state: 'done', box: 'worker', build: 'image:built', model: 'model', account: 'account', brief: '', logTail: null });
  expect(f.ended).toHaveBeenCalledExactlyOnceWith(queued.id); expect(f.errors).not.toHaveBeenCalled();
  const receipts = f.db.select().from(operationResults).all(); expect(receipts.map(row => row.operation).sort()).toEqual(['runtime.finish', 'runtime.next', 'runtime.started']);
  const stored = JSON.stringify(receipts.map(row => ({ ...row, result: row.result.toString('utf8') })));
  expect(stored).not.toContain('Private work instructions'); expect(stored).not.toContain('private-log-output');
  expect(f.client.prepare("SELECT name FROM sqlite_schema WHERE name GLOB 'core_*'").all()).toEqual([]);
});
it('binds every worker report to the authenticated live machine and refuses supplied identities', async () => {
  const f = fixture(), queued = f.send(); const next = await f.control.next(); expect(next?.id).toBe(queued.id);
  for (const bearer of [otherCredential, ownerCredential, agentCredential]) for (const [name, input] of [
    ['started', { job: queued.id, build: 'image' }], ['heartbeat', { job: queued.id, state: 'starting' }], ['finish', { job: queued.id, exitCode: 0, logTail: '' }],
  ] as const) expect((await f.call(name, input, `${name}-${bearer[0]}`, bearer)).status).toBe(403);
  expect((await f.call('next', { box: 'other' })).status).toBe(400);
  expect((await f.call('started', { job: queued.id, build: 'image', box: 'worker' })).status).toBe(400);
  expect(f.db.select().from(jobs).where(eq(jobs.id, queued.id)).get()?.state).toBe('starting');
  f.root.writes.run(() => f.db.update(boxes).set({ revokedAt: f.now() }).where(eq(boxes.id, 'worker')).run());
  expect((await f.call('next', {})).status).toBe(403);
  expect((await f.call('started', { job: queued.id, build: 'image' })).status).toBe(403);
});
it('refuses stale claim/heartbeat replay while report receipts remain atomic and bound to current box authority', async () => {
  const f = fixture(), queued = f.send();
  expect((await f.call('next', {}, 'claim')).status).toBe(200); expect((await f.call('next', {}, 'claim')).status).toBe(409);
  const beat = { job: queued.id, state: 'starting' };
  expect(await (await f.call('heartbeat', beat, 'beat')).json()).toEqual({ ok: true, value: { active: true } });
  expect((await f.call('heartbeat', beat, 'beat')).status).toBe(409);
  const start = { job: queued.id, build: 'image' };
  expect((await f.call('started', start, 'start')).status).toBe(200); expect((await f.call('started', start, 'start')).status).toBe(200);
  const finish = { job: queued.id, exitCode: 0, logTail: 'one-private-output' };
  expect((await f.call('finish', finish, 'finish')).status).toBe(200);
  // Private output is intentionally discarded, so changing only those words
  // neither stores a dictionary-testable fingerprint nor changes the effect.
  const receipt = f.db.select().from(operationResults).where(eq(operationResults.operation, 'runtime.finish')).get()!;
  expect(receipt.inputHash).not.toBe(hash(JSON.stringify({ exitCode: finish.exitCode, job: finish.job, logTail: finish.logTail })));
  expect((await f.call('finish', { ...finish, logTail: 'different-private-output' }, 'finish')).status).toBe(200);
  expect(f.db.select().from(operationResults).where(eq(operationResults.operation, 'runtime.finish')).get()?.inputHash).toBe(receipt.inputHash);
  expect((await f.call('started', start, 'start')).status).toBe(403); // a terminal body cannot regain running authority
  expect(await (await f.call('heartbeat', { job: queued.id, state: 'running' }, 'new-beat')).json()).toEqual({ ok: true, value: { active: false } });
  f.root.writes.run(() => f.db.update(boxes).set({ revokedAt: f.now() }).where(eq(boxes.id, 'worker')).run());
  expect((await f.call('started', start, 'start')).status).toBe(403); expect((await f.call('finish', finish, 'finish')).status).toBe(403);
});
it('retains public output with ordinary replay conflict detection', async () => {
  const f = fixture(), queued = f.send('handoff'); await f.control.next(); await f.control.started(queued.id, 'image');
  const finish = { job: queued.id, exitCode: 0, logTail: 'public-output' };
  expect((await f.call('finish', finish, 'public')).status).toBe(200);
  expect(f.db.select().from(jobs).where(eq(jobs.id, queued.id)).get()?.logTail).toBe('public-output');
  expect((await f.call('finish', { ...finish, logTail: 'changed' }, 'public')).status).toBe(409);
});
it('rolls back the job effect with a failed receipt and emits no terminal source event', async () => {
  const f = fixture(), queued = f.send(); await f.control.next(); await f.control.started(queued.id, 'image');
  f.client.exec("CREATE TRIGGER refuse_finish_receipt BEFORE INSERT ON operation_results WHEN NEW.operation='runtime.finish' BEGIN SELECT RAISE(ABORT,'fixture'); END");
  expect((await f.call('finish', { job: queued.id, exitCode: 0, logTail: '' })).status).toBe(503);
  expect(f.db.select().from(jobs).where(eq(jobs.id, queued.id)).get()?.state).toBe('running'); expect(f.ended).not.toHaveBeenCalled();
  expect(f.db.select().from(operationResults).all().some(row => row.operation === 'runtime.finish')).toBe(false);
});
it('uses current configured roles and shuts down its runtime sweep before releasing SQLite', async () => {
  const f = fixture(), queued = f.send(); f.setRoles([]); expect(await f.control.next()).toBeUndefined();
  expect(f.db.select().from(jobs).where(eq(jobs.id, queued.id)).get()?.state).toBe('queued');
  f.setRoles([{ model: 'model', provider: 'provider', harness: 'codex', series: 'series' }]); expect((await f.control.next())?.id).toBe(queued.id);
  await f.root.close(); f.clock.advance(5 * 60_000); expect(f.errors).not.toHaveBeenCalled();
  expect((await f.call('next', {}, 'closed')).status).toBe(503);
});

it('starts silence reconciliation while open and refuses the lost body old running receipt', async () => {
  const f = fixture(), queued = f.send(); await f.control.next();
  const start = { job: queued.id, build: 'image' }; expect((await f.call('started', start, 'started-before-loss')).status).toBe(200);
  f.clock.advance(150_001);
  expect(f.db.select().from(jobs).where(eq(jobs.id, queued.id)).get()?.state).toBe('lost');
  expect(f.ended).toHaveBeenCalledWith(queued.id); expect(f.errors).not.toHaveBeenCalled();
  expect((await f.call('started', start, 'started-before-loss')).status).toBe(403);
  await f.root.close(); f.clock.advance(150_000); expect(f.errors).not.toHaveBeenCalled();
});
it('cannot restore a stopped body with its previously successful running receipt', async () => {
  const f = fixture(), queued = f.send(); await f.control.next();
  const start = { job: queued.id, build: 'image' }; expect((await f.call('started', start, 'started-before-stop')).status).toBe(200);
  f.root.services.runtime.stop(queued.id, 'owner', 'write-off');
  expect(f.db.select().from(jobs).where(eq(jobs.id, queued.id)).get()?.state).toBe('stopped');
  expect((await f.call('started', start, 'started-before-stop')).status).toBe(403);
});
it('discards dangling-conversation words and their receipt fingerprint', async () => {
  const f = fixture(), queued = f.send(); await f.control.next(); await f.control.started(queued.id, 'image');
  // Fictional corruption fixture only; production foreign keys remain enabled.
  f.client.pragma('foreign_keys = OFF');
  f.db.update(jobs).set({ conversation: 'missing-conversation' }).where(eq(jobs.id, queued.id)).run();
  f.client.pragma('foreign_keys = ON');
  const finish = { job: queued.id, exitCode: 0, logTail: 'dangling-private-output' };
  expect((await f.call('finish', finish, 'dangling')).status).toBe(200);
  expect(f.db.select().from(jobs).where(eq(jobs.id, queued.id)).get()?.logTail).toBeNull();
  const receipt = f.db.select().from(operationResults).where(eq(operationResults.operation, 'runtime.finish')).get()!;
  expect(receipt.inputHash).not.toBe(hash(JSON.stringify({ exitCode: finish.exitCode, job: finish.job, logTail: finish.logTail })));
  expect((await f.call('finish', { ...finish, logTail: 'changed-private-output' }, 'dangling')).status).toBe(200);
  expect(f.db.select().from(operationResults).where(eq(operationResults.operation, 'runtime.finish')).get()?.inputHash).toBe(receipt.inputHash);
});
it('competing real polls cannot both receive one queued job', async () => {
  const f = fixture(), queued = f.send();
  const polls = await Promise.all([f.control.next(), f.control.next()]);
  expect(polls.filter(Boolean).map(job => job!.id)).toEqual([queued.id]);
  expect(f.db.select().from(jobs).all()).toHaveLength(1);
});
it('all queued jobs respect the same current account capacity rather than a per-job copy', async () => {
  const f = fixture(); f.send('handoff', 'one'); f.send('handoff', 'two');
  expect(await f.control.next()).toBeDefined();
  // A fresh shared provider observation exhausts the account after the first
  // claim. Claims do not invent usage or predict a body's unknown future cost.
  f.root.writes.run(() => f.db.update(modelAccountWindows).set({ usage: 1 }).where(eq(modelAccountWindows.account, 'account')).run());
  expect(await f.control.next()).toBeUndefined();
  expect(f.db.select().from(jobs).all().map(job => job.state).sort()).toEqual(['queued', 'starting']);
});
