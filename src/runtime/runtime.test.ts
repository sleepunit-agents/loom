import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { FakeClock } from '../core/clock.js';
import { createDataSchema } from '../core/data/database.js';
import { Conversations } from '../core/conversations/index.js';
import { createTempo } from '../core/tempo/tempo.js';
import { agents, members, boxes, agentModels, agentBoxes, agentRunSettings, memberAgents, modelAccounts, modelAccountBoxes, jobs, inbox } from '../core/data/schema.js';
import { createRuntime } from './runtime.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
function fixture() {
  const client = new Database(':memory:'); cleanups.push(() => client.close());
  const clock = new FakeClock(), now = () => new Date(clock.now()).toISOString();
  const db = createDataSchema(client, now);
  db.insert(members).values({ id: 'owner', role: 'owner', joinedAt: now() }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(memberAgents).values({ member: 'owner', agent: 'art' }).run();
  db.insert(boxes).values({ id: 'worker', name: 'Workshop', owner: 'owner', hostsAny: true, sameMachineAsLoom: false, reportOnly: false, alwaysOn: true, enrolledAt: now(), lastSeenAt: now() }).run();
  db.insert(agentBoxes).values({ agent: 'art', box: 'worker', position: 0 }).run();
  db.insert(agentModels).values({ agent: 'art', model: 'model', position: 0 }).run();
  db.insert(agentRunSettings).values({ agent: 'art', houseRepository: 'repo', houseFile: 'Housefile', houseBranch: 'next', nestedContainers: false, gpu: false }).run();
  db.insert(modelAccounts).values({ id: 'account', owner: 'owner', provider: 'provider', label: 'Subscription', hasRoom: true }).run();
  db.insert(modelAccountBoxes).values({ account: 'account', box: 'worker' }).run();
  const comms = new Conversations(db, now);
  let tempo: ReturnType<typeof createTempo> | undefined;
  const changed = vi.fn(() => { expect(client.inTransaction).toBe(false); tempo?.changed(); });
  const jobEnded = vi.fn((id: string) => {
    expect(client.inTransaction).toBe(false);
    expect(db.select().from(jobs).where(eq(jobs.id, id)).get()?.endedAt).toBe(now());
    tempo?.sources.job(id);
  });
  const error = vi.fn();
  const runtime = createRuntime(db, clock, {
    roles: () => [{ model: 'model', provider: 'provider', harness: 'codex', series: 'series' }], changed, jobEnded, error,
  });
  tempo = createTempo(db, clock, { conversations: comms, admit: runtime.admit, operation: () => {} });
  tempo.volume.setTimings({ kind: 'agent', id: 'art' }, { settleSeconds: 0 });
  cleanups.push(() => { runtime.close(); tempo!.close(); });
  function send(place = 'thread') {
    const conversation = comms.open({ agent: 'art', venue: 'loom', place, label: place });
    const mail = comms.send({ toKind: 'agent', to: 'art', conversation: conversation.id, source: 'thread', fromKind: 'person', fromId: 'owner', words: 'Work' });
    return { conversation, mail };
  }
  return { db, clock, now, comms, tempo, runtime, changed, jobEnded, error, send };
}

it('queues separate conversations from settled inbox mail and reports completion after commit', () => {
  const f = fixture(), a = f.send('one'), b = f.send('two');
  f.tempo.changed();
  expect(f.db.select().from(jobs).all()).toHaveLength(2);
  f.tempo.changed();
  expect(f.db.select().from(jobs).all()).toHaveLength(2);
  const assigned = f.runtime.next('worker')!;
  expect([a.conversation.id, b.conversation.id]).toContain(assigned.conversation);
  f.runtime.started('worker', assigned.id, 'image');
  f.tempo.triggers.set({ ownerKind: 'household', sourceKind: 'job', watches: `job:${assigned.id}`,
    targetKind: 'inbox', toKind: 'person', to: 'owner', lifespan: 'once', note: 'Report completion', instructions: 'The work ended' });
  for (const mail of f.comms.take(assigned.conversation!, assigned.id)) f.comms.confirm(mail.id, assigned.id);
  f.runtime.finish('worker', assigned.id, 0, 'done');
  expect(f.jobEnded).toHaveBeenCalledExactlyOnceWith(assigned.id);
  expect(f.db.select().from(inbox).all().filter(row => row.source === 'trigger')).toMatchObject([{ to: 'owner', words: 'The work ended' }]);
  expect(f.db.select().from(jobs).where(eq(jobs.id, assigned.id)).get()?.state).toBe('done');
  expect(f.error).not.toHaveBeenCalled();
});

it('keeps the retry successor and backoff when a worker fails to start', () => {
  const f = fixture(); f.send(); f.tempo.changed();
  const first = f.runtime.next('worker')!;
  const retry = f.runtime.finish('worker', first.id, 1, 'launch failure').retry!;
  expect(f.jobEnded).toHaveBeenCalledExactlyOnceWith(first.id);
  expect(f.db.select().from(jobs).all()).toHaveLength(2);
  expect(f.runtime.next('worker')).toBeUndefined();
  f.clock.advance(1000);
  expect(f.runtime.next('worker')?.id).toBe(retry.id);
});

it('recovers silent jobs and alerts for always-on workers, then cancels its timer on close', () => {
  const f = fixture(); f.send(); f.tempo.changed();
  const first = f.runtime.next('worker')!;
  f.runtime.started('worker', first.id, 'image');
  f.clock.advance(120_001);
  f.runtime.start();
  expect(f.db.select().from(jobs).where(eq(jobs.id, first.id)).get()?.state).toBe('lost');
  expect(f.jobEnded).toHaveBeenCalledExactlyOnceWith(first.id);
  const notices = () => f.db.select().from(inbox).all().filter(row => row.source === 'notice');
  expect(notices()).toHaveLength(1);
  f.clock.advance(60_000);
  expect(notices()).toHaveLength(1);
  f.runtime.next('worker');
  expect(notices()[0].state).toBe('resolved');
  f.runtime.close();
  f.changed.mockClear();
  f.clock.advance(300_000);
  expect(f.changed).not.toHaveBeenCalled();
  expect(() => f.runtime.next('worker')).toThrow('Runtime is closed');
});

it('publishes manual stops and does not revive stopped mail', () => {
  const f = fixture(); f.send(); f.tempo.changed();
  const job = f.db.select().from(jobs).get()!;
  f.runtime.stop(job.id, 'owner', 'write-off');
  expect(f.jobEnded).toHaveBeenCalledExactlyOnceWith(job.id);
  f.tempo.changed();
  expect(f.db.select().from(jobs).all()).toHaveLength(1);
  expect(f.runtime.next('worker')).toBeUndefined();
});

it('keeps polling after a callback fails and start is idempotent', () => {
  const f = fixture();
  f.changed.mockImplementationOnce(() => { throw new Error('Subscription unavailable'); });
  f.runtime.start();
  expect(f.error).toHaveBeenCalledOnce();
  f.changed.mockClear();
  f.runtime.start();
  f.clock.advance(30_000);
  expect(f.changed).toHaveBeenCalledOnce();
  f.runtime.close();
  f.clock.advance(30_000);
  expect(f.changed).toHaveBeenCalledOnce();
});
