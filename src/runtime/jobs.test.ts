import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema } from '../core/data/database.js';
import { Conversations } from '../core/conversations/index.js';
import { agents, members, projects, boxes, agentModels, agentRunSettings, conversations, inbox, jobNeeds, jobs } from '../core/data/schema.js';
import { Jobs } from './jobs.js';

const opened: Database.Database[] = [];
afterEach(() => opened.splice(0).forEach(db => db.close()));
function fixture() {
  const client = new Database(':memory:'); opened.push(client);
  let at = '2026-11-14T20:00:00.000Z';
  const now = () => at, db = createDataSchema(client, now);
  db.insert(members).values({ id: 'owner', role: 'owner', joinedAt: at }).run();
  db.insert(projects).values({ id: 'pond', name: 'Pond', createdAt: at }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(boxes).values({ id: 'worker', name: 'Worker', owner: 'owner', sameMachineAsLoom: true, hostsAny: true, reportOnly: false, alwaysOn: false, enrolledAt: at, lastSeenAt: at }).run();
  db.insert(agentModels).values({ agent: 'art', model: 'primary', position: 0 }).run();
  db.insert(agentRunSettings).values({ agent: 'art', houseRepository: 'https://example.org/house', houseFile: 'Housefile', houseBranch: 'main', nestedContainers: false, gpu: true }).run();
  const comms = new Conversations(db, now), runtime = new Jobs(db, now);
  const conversation = comms.open({ agent: 'art', venue: 'loom', place: 'thread', label: 'Reply', project: 'pond', member: 'owner' });
  const send = () => comms.send({ toKind: 'agent', to: 'art', conversation: conversation.id, source: 'thread', fromKind: 'person', fromId: 'owner', words: 'Hello' });
  const tick = (ms: number) => { at = new Date(Date.parse(at) + ms).toISOString(); };
  return { db, comms, runtime, conversation, send, tick, now };
}
it('admits nonempty inbox once and snapshots house, model, labels and needs', () => {
  const f = fixture();
  expect(f.runtime.admit(f.conversation.id)).toBeUndefined();
  f.send();
  const job = f.runtime.admit(f.conversation.id)!;
  expect(job).toMatchObject({ agent: 'art', conversation: f.conversation.id, title: 'Reply', model: 'primary', state: 'queued', houseFile: 'Housefile', startedByKind: 'agent', startedBy: 'art', project: 'pond', member: 'owner', brief: 'Hello' });
  expect(f.runtime.admit(f.conversation.id)?.id).toBe(job.id);
  expect(f.db.select().from(jobNeeds).all()).toEqual([{ job: job.id, need: 'gpu' }]);
  f.db.update(agentRunSettings).set({ houseFile: 'changed' }).run();
  expect(f.runtime.get(job.id).houseFile).toBe('Housefile');
  expect(f.db.select().from(conversations).get()?.job).toBe(job.id);
});
it('claims once, rejects other workers, takes mail only when running and preserves confirmed receipts', () => {
  const f = fixture(), mail = f.send(), job = f.runtime.admit(f.conversation.id)!;
  f.tick(100);
  expect(f.runtime.claim(job.id, 'worker')).toMatchObject({ state: 'starting', claimedAt: f.now(), heardAt: f.now() });
  expect(f.runtime.claim(job.id, 'worker')).toBeUndefined();
  expect(() => f.comms.take(f.conversation.id, job.id)).toThrow();
  expect(() => f.runtime.started(job.id, 'foreign', 'image')).toThrow();
  expect(f.runtime.started(job.id, 'worker', 'image').build).toBe('image');
  expect(f.comms.take(f.conversation.id, job.id).map(row => row.id)).toEqual([mail.id]);
  const receipt = f.comms.confirm(mail.id, job.id);
  f.tick(100);
  expect(f.runtime.heartbeat(job.id, 'worker', 'waiting')).toMatchObject({ state: 'waiting', heardAt: f.now() });
  f.tick(100);
  expect(f.runtime.heartbeat(job.id, 'worker', 'running')).toMatchObject({ state: 'running', heardAt: f.now() });
  expect(f.runtime.finish(job.id, 'worker', 0, 'complete').job).toMatchObject({ state: 'done', exitCode: 0, logTail: 'complete', build: 'image' });
  expect(f.db.select().from(inbox).get()).toMatchObject({ state: 'done', job: job.id, doneAt: receipt.doneAt });
  expect(f.db.select().from(conversations).get()?.job).toBeNull();
  expect(() => f.runtime.heartbeat(job.id, 'worker', 'running')).toThrow();
});
it('retries a failed start three times as new linked jobs, without retrying the exhausted chain on old mail', () => {
  const f = fixture(); f.send();
  let job = f.runtime.admit(f.conversation.id)!;
  const original = job.id;
  for (let n = 0; n < 4; n++) {
    // Recreate the service between attempts: the budget lives in the database.
    const runtime = new Jobs(f.db, f.now);
    expect(f.runtime.claim(job.id, 'worker')?.state).toBe('starting');
    const result = runtime.finish(job.id, 'worker', 1, 'start failed');
    expect(result.job.state).toBe('failed');
    if (n === 3) { expect(result.retry).toBeUndefined(); break; }
    expect(result.retry).toMatchObject({ retryOf: original, houseFile: 'Housefile', model: 'primary', box: null, state: 'queued' });
    expect(f.db.select().from(conversations).get()?.job).toBe(result.retry!.id);
    expect(f.db.select().from(inbox).get()).toMatchObject({ state: 'waiting', job: result.retry!.id });
    expect(f.runtime.admit(f.conversation.id)?.id).toBe(result.retry!.id);
    expect(f.runtime.claim(result.retry!.id, 'worker')).toBeUndefined();
    const backoff = 1000 * 2 ** n;
    expect(result.retry!.retryAt).toBe(new Date(Date.parse(f.now()) + backoff).toISOString());
    f.tick(backoff - 1);
    expect(runtime.claim(result.retry!.id, 'worker')).toBeUndefined();
    f.tick(1); job = result.retry!;
  }
  expect(f.db.select().from(jobs).all()).toHaveLength(4);
  expect(f.runtime.admit(f.conversation.id)).toBeUndefined();
  f.tick(1); f.send();
  expect(f.runtime.admit(f.conversation.id)?.state).toBe('queued');
});
it('does not retry process failures after starting and returns unconfirmed mail to waiting', () => {
  const f = fixture(); f.send();
  const job = f.runtime.admit(f.conversation.id)!;
  f.runtime.claim(job.id, 'worker'); f.runtime.started(job.id, 'worker', 'image');
  f.comms.take(f.conversation.id, job.id);
  const result = f.runtime.finish(job.id, 'worker', 2, 'x'.repeat(20_000));
  expect(result.retry).toBeUndefined();
  expect(result.job).toMatchObject({ state: 'failed', exitCode: 2, logTail: 'x'.repeat(16_384) });
  expect(f.db.select().from(inbox).get()).toMatchObject({ state: 'waiting', job: null, takenAt: null });
  expect(f.runtime.admit(f.conversation.id)?.state).toBe('queued');
});
it('admits new mail during failure and in the same clock tick after termination', () => {
  const f = fixture(); f.send(); const job = f.runtime.admit(f.conversation.id)!;
  f.runtime.claim(job.id, 'worker'); f.runtime.started(job.id, 'worker', 'image');
  f.comms.take(f.conversation.id, job.id);
  f.send(); // Untaken mail arriving during the body, with the same timestamp.
  f.runtime.finish(job.id, 'worker', 1);
  const next = f.runtime.admit(f.conversation.id)!;
  expect(next.id).not.toBe(job.id);
  f.runtime.stop(next.id, 'owner', 'reset');
  f.send();
  expect(f.runtime.admit(f.conversation.id)?.state).toBe('queued');
});
it('attributes automatic schedule/unknown admission to the receiving agent', () => {
  const f = fixture();
  f.comms.send({ toKind: 'agent', to: 'art', conversation: f.conversation.id, source: 'trigger', fromKind: 'schedule', words: 'Scheduled work' });
  f.comms.send({ toKind: 'agent', to: 'art', conversation: f.conversation.id, source: 'notice', fromKind: 'unknown', words: 'Notice' });
  expect(f.runtime.admit(f.conversation.id)).toMatchObject({ startedByKind: 'agent', startedBy: 'art', brief: 'Scheduled work\n\nNotice' });
});
it('marks silent jobs lost after the boundary and rejects late worker events', () => {
  const f = fixture(); f.send(); const job = f.runtime.admit(f.conversation.id)!;
  f.runtime.claim(job.id, 'worker'); f.runtime.started(job.id, 'worker', 'image');
  f.comms.take(f.conversation.id, job.id);
  f.tick(120_000); expect(f.runtime.sweep()).toEqual([]);
  f.tick(1); expect(f.runtime.sweep().map(row => row.id)).toEqual([job.id]);
  expect(f.runtime.get(job.id).state).toBe('lost');
  expect(() => f.runtime.finish(job.id, 'worker', 0)).toThrow();
  expect(f.db.select().from(inbox).get()?.state).toBe('waiting');
  expect(f.runtime.admit(f.conversation.id)?.state).toBe('queued');
});
it('keeps a building worker alive without allowing heartbeat to skip or reverse startup', () => {
  const f = fixture(); f.send(); const job = f.runtime.admit(f.conversation.id)!;
  f.runtime.claim(job.id, 'worker');
  expect(() => f.runtime.heartbeat(job.id, 'worker', 'running')).toThrow();
  f.tick(120_000); f.runtime.heartbeat(job.id, 'worker', 'starting');
  f.tick(120_000); expect(f.runtime.sweep()).toEqual([]);
  f.runtime.started(job.id, 'worker', 'image');
  expect(() => f.runtime.heartbeat(job.id, 'worker', 'starting')).toThrow();
});
it('stops queued work and records who reset it without accepting a later claim', () => {
  const f = fixture(); f.send(); const job = f.runtime.admit(f.conversation.id)!;
  expect(f.runtime.stop(job.id, 'owner', 'reset')).toMatchObject({ state: 'stopped', endedBy: 'owner', endedReason: 'reset' });
  expect(f.runtime.claim(job.id, 'worker')).toBeUndefined();
  expect(f.runtime.admit(f.conversation.id)).toBeUndefined();
  expect(f.db.select().from(jobs).where(eq(jobs.id, job.id)).get()?.endedAt).toBe(f.now());
});

it('excludes muted mail from admission, snapshots and retry attribution', () => {
  const f = fixture(), muted = f.send();
  f.db.update(inbox).set({ volume: 'mute', words: 'Muted words' }).where(eq(inbox.id, muted.id)).run();
  expect(f.runtime.admit(f.conversation.id)).toBeUndefined();
  f.send();
  const job = f.runtime.admit(f.conversation.id)!;
  expect(job.brief).toBe('Hello');
  expect(f.db.select().from(inbox).where(eq(inbox.id, muted.id)).get()).toMatchObject({ state: 'waiting', job: null });
  f.runtime.claim(job.id, 'worker');
  const retry = f.runtime.finish(job.id, 'worker', 1).retry!;
  expect(retry.brief).toBe('Hello');
  expect(f.db.select().from(inbox).where(eq(inbox.id, muted.id)).get()).toMatchObject({ state: 'waiting', job: null });
  f.runtime.stop(retry.id, 'owner', 'reset');
  expect(f.runtime.admit(f.conversation.id)).toBeUndefined();
});
