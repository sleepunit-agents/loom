import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema } from '../core/data/database.js';
import { Conversations } from '../core/conversations/index.js';
import { agents, members, boxes, agentModels, agentRunSettings, conversations, inbox, jobNeeds, jobs } from '../core/data/schema.js';
import { Jobs } from './jobs.js';

const opened: Database.Database[] = [];
afterEach(() => opened.splice(0).forEach(db => db.close()));
function fixture() {
  const client = new Database(':memory:'); opened.push(client);
  let at = '2026-11-14T20:00:00.000Z';
  const now = () => at, db = createDataSchema(client, now);
  db.insert(members).values({ id: 'owner', role: 'owner', joinedAt: at }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(boxes).values({ id: 'worker', name: 'Worker', owner: 'owner', sameMachineAsLoom: true, hostsAny: true, reportOnly: false, alwaysOn: false, enrolledAt: at, lastSeenAt: at }).run();
  db.insert(agentModels).values({ agent: 'art', model: 'primary', position: 0 }).run();
  db.insert(agentRunSettings).values({ agent: 'art', houseRepository: 'https://example.org/house', houseFile: 'Housefile', houseBranch: 'main', nestedContainers: false, gpu: true }).run();
  const comms = new Conversations(db, now), runtime = new Jobs(db, now);
  const conversation = comms.open({ agent: 'art', venue: 'loom', place: 'thread', label: 'Reply' });
  const send = () => comms.send({ toKind: 'agent', to: 'art', conversation: conversation.id, source: 'thread', fromKind: 'person', fromId: 'owner', words: 'Hello' });
  const tick = (ms: number) => { at = new Date(Date.parse(at) + ms).toISOString(); };
  return { db, comms, runtime, conversation, send, tick, now };
}
it('admits nonempty inbox once and snapshots house, model, labels and needs', () => {
  const f = fixture();
  expect(f.runtime.admit(f.conversation.id)).toBeUndefined();
  f.send();
  const job = f.runtime.admit(f.conversation.id)!;
  expect(job).toMatchObject({ agent: 'art', conversation: f.conversation.id, model: 'primary', state: 'queued', houseFile: 'Housefile', startedBy: 'owner' });
  expect(f.runtime.admit(f.conversation.id)?.id).toBe(job.id);
  expect(f.db.select().from(jobNeeds).all()).toEqual([{ job: job.id, need: 'gpu' }]);
  f.db.update(agentRunSettings).set({ houseFile: 'changed' }).run();
  expect(f.runtime.get(job.id).houseFile).toBe('Housefile');
  expect(f.db.select().from(conversations).get()?.job).toBe(job.id);
});
it('claims once, rejects other workers, takes mail only when running and preserves confirmed receipts', () => {
  const f = fixture(), mail = f.send(), job = f.runtime.admit(f.conversation.id)!;
  expect(f.runtime.claim(job.id, 'worker')?.state).toBe('starting');
  expect(f.runtime.claim(job.id, 'worker')).toBeUndefined();
  expect(() => f.comms.take(f.conversation.id, job.id)).toThrow();
  expect(() => f.runtime.started(job.id, 'foreign', 'image')).toThrow();
  f.runtime.started(job.id, 'worker', 'image');
  expect(f.comms.take(f.conversation.id, job.id).map(row => row.id)).toEqual([mail.id]);
  f.comms.confirm(mail.id, job.id);
  f.runtime.heartbeat(job.id, 'worker', 'waiting');
  f.runtime.heartbeat(job.id, 'worker', 'running');
  expect(f.runtime.finish(job.id, 'worker', 0).job.state).toBe('done');
  expect(f.db.select().from(inbox).get()?.state).toBe('done');
  expect(f.db.select().from(conversations).get()?.job).toBeNull();
  expect(() => f.runtime.heartbeat(job.id, 'worker', 'running')).toThrow();
});
it('retries a failed start three times as new linked jobs, without retrying the exhausted chain on old mail', () => {
  const f = fixture(); f.send();
  let job = f.runtime.admit(f.conversation.id)!;
  for (let n = 0; n < 4; n++) {
    expect(f.runtime.claim(job.id, 'worker')?.state).toBe('starting');
    const result = f.runtime.finish(job.id, 'worker', 1, 'start failed');
    expect(result.job.state).toBe('failed');
    if (n === 3) { expect(result.retry).toBeUndefined(); break; }
    expect(result.retry).toMatchObject({ retryOf: job.id, houseFile: 'Housefile', model: 'primary', box: null, state: 'queued' });
    expect(f.runtime.admit(f.conversation.id)?.id).toBe(result.retry!.id);
    expect(f.runtime.claim(result.retry!.id, 'worker')).toBeUndefined();
    job = result.retry!; f.tick(10_000);
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
  expect(f.runtime.finish(job.id, 'worker', 2).retry).toBeUndefined();
  expect(f.db.select().from(inbox).get()).toMatchObject({ state: 'waiting', job: null, takenAt: null });
  expect(f.runtime.admit(f.conversation.id)).toBeUndefined();
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
});
it('stops queued work and records who reset it without accepting a later claim', () => {
  const f = fixture(); f.send(); const job = f.runtime.admit(f.conversation.id)!;
  expect(f.runtime.stop(job.id, 'owner', 'reset')).toMatchObject({ state: 'stopped', endedBy: 'owner', endedReason: 'reset' });
  expect(f.runtime.claim(job.id, 'worker')).toBeUndefined();
  expect(f.runtime.admit(f.conversation.id)).toBeUndefined();
  expect(f.db.select().from(jobs).where(eq(jobs.id, job.id)).get()?.endedAt).toBe(f.now());
});
