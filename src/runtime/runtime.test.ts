import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { FakeClock } from '../core/clock.js';
import { createDataSchema } from '../core/data/database.js';
import { Conversations } from '../core/conversations/index.js';
import { createTempo } from '../core/tempo/tempo.js';
import { agents, members, boxes, agentModels, agentBoxes, agentRunSettings, memberAgents, modelAccounts, modelAccountWindows, modelAccountBoxes, modelAccountLogins, jobs, inbox } from '../core/data/schema.js';
import { createRuntime } from './runtime.js';
import { Dispatcher } from './dispatcher.js';
import { harnessCannotRun } from './body-harnesses.js';
import { Jobs } from './jobs.js';
import { Machines } from './machines.js';

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
  db.insert(modelAccountWindows).values({ account: 'account', window: 'week', usage: 0.2,
    usageReadAt: now(), resetsAt: new Date(clock.now() + 7 * 86400_000).toISOString(), durationMs: 7 * 86400_000 }).run();
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
  const runtime = createRuntime(db, clock, { changed, jobEnded, error });
  // The worker's side, as shared-runtime.ts registers it: the runtime itself only admits, stops and sweeps.
  const worker = new Dispatcher(db, now, () => [{ model: 'model', provider: 'provider', harness: 'codex', series: 'series' }], harnessCannotRun);
  tempo = createTempo(db, clock, { conversations: comms, admit: runtime.admit, operation: () => {} });
  tempo.volume.setTimings({ kind: 'agent', id: 'art' }, { settleSeconds: 0 });
  cleanups.push(() => { runtime.close(); tempo!.close(); });
  function send(place = 'thread') {
    const conversation = comms.open({ agent: 'art', venue: 'loom', place, label: place });
    const mail = comms.send({ toKind: 'agent', to: 'art', conversation: conversation.id, source: 'thread', fromKind: 'person', fromId: 'owner', words: 'Work' });
    return { conversation, mail };
  }
  return { db, clock, now, comms, tempo, runtime, worker, changed, jobEnded, error, send };
}

it('queues separate conversations from settled inbox mail, once', () => {
  const f = fixture(), a = f.send('one'), b = f.send('two');
  f.tempo.changed();
  expect(f.db.select().from(jobs).all().map(job => job.conversation).sort()).toEqual([a.conversation.id, b.conversation.id].sort());
  f.tempo.changed();
  expect(f.db.select().from(jobs).all()).toHaveLength(2);
  // Mail for a person is not work, and mail addressed to another agent is not this agent's.
  expect(f.runtime.admit({ kind: 'person', id: 'owner' }, [a.mail])).toBe(false);
  expect(f.runtime.admit({ kind: 'agent', id: 'other' }, [a.mail])).toBe(false);
  expect(f.error).not.toHaveBeenCalled();
});

it('recovers silent jobs and alerts for always-on workers, then cancels its timer on close', () => {
  const f = fixture(); f.send(); f.tempo.changed();
  const first = f.worker.next('worker')!;
  f.worker.started('worker', first.id, 'image');
  f.clock.advance(120_001);
  f.runtime.start();
  // Time when the server could not receive a report cannot establish worker silence.
  expect(f.db.select().from(jobs).where(eq(jobs.id, first.id)).get()?.state).toBe('running');
  f.clock.advance(120_000);
  expect(f.db.select().from(jobs).where(eq(jobs.id, first.id)).get()?.state).toBe('running');
  f.clock.advance(30_000);
  expect(f.db.select().from(jobs).where(eq(jobs.id, first.id)).get()?.state).toBe('lost');
  expect(f.jobEnded).toHaveBeenCalledExactlyOnceWith(first.id);
  // The body had not confirmed its mail, so the lost work is queued again as the next attempt.
  expect(f.db.select().from(jobs).where(eq(jobs.retryOf, first.id)).get()?.state).toBe('queued');
  const notices = () => f.db.select().from(inbox).all().filter(row => row.source === 'notice');
  expect(notices()).toHaveLength(1);
  f.clock.advance(60_000);
  expect(notices()).toHaveLength(1);
  f.worker.machines.heartbeat('worker');
  expect(notices()[0].state).toBe('resolved');
  f.runtime.close();
  f.changed.mockClear();
  f.clock.advance(300_000);
  expect(f.changed).not.toHaveBeenCalled();
  expect(() => f.runtime.sweep()).toThrow('Runtime is closed');
});

it('publishes manual stops and does not revive stopped mail', () => {
  const f = fixture(); f.send(); f.tempo.changed();
  const job = f.db.select().from(jobs).get()!;
  f.runtime.stop(job.id, 'owner', 'write-off');
  expect(f.jobEnded).toHaveBeenCalledExactlyOnceWith(job.id);
  f.tempo.changed();
  expect(f.db.select().from(jobs).all()).toHaveLength(1);
  expect(f.worker.next('worker')).toBeUndefined();
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

it('does not take a jump of the server clock for silence: after one it waits a full interval before ending anything', () => {
  const client = new Database(':memory:'); cleanups.push(() => client.close());
  // A clock that can be stepped without its timers having run in between, as a wall clock can.
  const fake = new FakeClock(); let step = 0;
  const clock = { now: () => fake.now() + step, at: (time: number, fn: () => void) => fake.at(time - step, fn) };
  const now = () => new Date(clock.now()).toISOString(), db = createDataSchema(client, now);
  db.insert(members).values({ id: 'owner', role: 'owner', joinedAt: now() }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(boxes).values({ id: 'worker', name: 'Workshop', owner: 'owner', hostsAny: true, sameMachineAsLoom: false, reportOnly: false, alwaysOn: true, enrolledAt: now(), lastSeenAt: now() }).run();
  db.insert(agentModels).values({ agent: 'art', model: 'model', position: 0 }).run();
  db.insert(agentRunSettings).values({ agent: 'art', houseRepository: 'repo', houseFile: 'Housefile', houseBranch: 'next', nestedContainers: false, gpu: false }).run();
  const comms = new Conversations(db, now), store = new Jobs(db, now), machines = new Machines(db, now);
  const conversation = comms.open({ agent: 'art', venue: 'loom', place: 'thread', label: 'thread' });
  comms.send({ toKind: 'agent', to: 'art', conversation: conversation.id, source: 'thread', fromKind: 'person', fromId: 'owner', words: 'Work' });
  const job = store.admit(conversation.id)!; store.claim(job.id, 'worker'); store.started(job.id, 'worker', 'image');
  const jobEnded = vi.fn(), runtime = createRuntime(db, clock, { changed: () => {}, jobEnded, error: vi.fn() });
  cleanups.push(() => runtime.close());
  const report = () => { store.heartbeat(job.id, 'worker', 'running'); machines.heartbeat('worker'); };
  const notices = () => db.select().from(inbox).all().filter(row => row.source === 'notice');
  runtime.start(); fake.advance(30_000); report();
  // The clock is set ten minutes ahead. The worker reported fifteen seconds ago by any watch but the server's.
  step += 600_000; fake.advance(30_000);
  expect(store.get(job.id).state).toBe('running'); expect(notices()).toEqual([]);
  // It goes on reporting, and nothing is ended while the interval after the jump runs out and after.
  for (let n = 0; n < 10; n++) { report(); fake.advance(15_000); }
  expect(store.get(job.id).state).toBe('running'); expect(notices()).toEqual([]);
  // Then it really goes silent, and is found as usual.
  fake.advance(150_000);
  expect(store.get(job.id).state).toBe('lost'); expect(jobEnded).toHaveBeenCalledExactlyOnceWith(job.id); expect(notices()).toHaveLength(1);
  // Set back an hour: the jobs and machines stamped later than now are not kept hidden for that hour.
  comms.send({ toKind: 'agent', to: 'art', conversation: conversation.id, source: 'thread', fromKind: 'person', fromId: 'owner', words: 'More' });
  const retry = db.select().from(jobs).where(eq(jobs.retryOf, job.id)).get()!;
  fake.advance(Date.parse(retry.retryAt!) - clock.now());
  expect(store.claim(retry.id, 'worker')?.state).toBe('starting');
  store.started(retry.id, 'worker', 'image'); machines.heartbeat('worker');
  step -= 3_600_000; fake.advance(30_000);
  expect(store.get(retry.id).state).toBe('running');
  fake.advance(300_000);
  expect(store.get(retry.id).state).toBe('lost');
});

it('tells the owner on its sweep about a sign-in found gone on a machine that is reporting', () => {
  const f = fixture(), at = f.now();
  f.db.update(boxes).set({ lastSeenAt: at }).where(eq(boxes.id, 'worker')).run();
  f.db.insert(modelAccountLogins).values({ account: 'account', box: 'worker', harness: 'codex', place: 'containers', state: 'signed-out', checkedAt: at, since: at, learnedFrom: 'check' }).run();
  f.runtime.start();
  const notices = f.db.select().from(inbox).where(eq(inbox.source, 'notice')).all();
  expect(notices.map(row => row.words)).toEqual([expect.stringMatching(/ is signed out on .+ \(codex in houses\)\.$/)]);
  f.clock.advance(30_000);
  expect(f.db.select().from(inbox).where(eq(inbox.source, 'notice')).all()).toHaveLength(1);
  expect(f.error).not.toHaveBeenCalled();
});
