import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { eq, notInArray } from 'drizzle-orm';
import { createDataSchema } from '../core/data/database.js';
import { Conversations } from '../core/conversations/index.js';
import { agents, members, projects, boxes, agentModels, agentRunSettings, conversations, inbox, jobNeeds, jobs, threads as threadRows } from '../core/data/schema.js';
import { Jobs, QUEUE_DEADLINE_MS, agentMailAdmission } from './jobs.js';
import { BODY_EXIT, LOOM_EXIT, exitStage } from './job-exit.js';
import { FakeClock } from '../core/clock.js';
import { SettledInbox } from '../core/tempo/settle.js';
import { defaultTimings } from '../core/tempo/volume.js';

const opened: Database.Database[] = [];
afterEach(() => opened.splice(0).forEach(db => db.close()));
/** The job working in the conversation: its one job that has not ended. */
const working = (f: { db: ReturnType<typeof createDataSchema> }) => f.db.select().from(jobs).where(notInArray(jobs.state, ['done', 'failed', 'lost', 'stopped'])).all().map(job => job.id);
function fixture(venue: 'loom' | 'handoff' | 'wake' = 'wake') {
  const client = new Database(':memory:'); opened.push(client);
  let at = '2026-11-14T20:00:00.000Z';
  const now = () => at, db = createDataSchema(client, now);
  db.insert(members).values({ id: 'owner', role: 'owner', joinedAt: at }).run();
  db.insert(projects).values({ id: 'pond', name: 'Pond' }).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(boxes).values({ id: 'worker', name: 'Worker', owner: 'owner', sameMachineAsLoom: true, hostsAny: true, reportOnly: false, alwaysOn: false, enrolledAt: at, lastSeenAt: at }).run();
  db.insert(agentModels).values({ agent: 'art', model: 'primary', position: 0 }).run();
  db.insert(agentRunSettings).values({ agent: 'art', houseRepository: 'https://example.org/house', houseFile: 'Housefile', houseBranch: 'main', nestedContainers: false, gpu: true }).run();
  const comms = new Conversations(db, now), runtime = new Jobs(db, now);
  const conversation = comms.open({ agent: 'art', venue, place: 'thread', label: 'Reply', project: 'pond', member: venue === 'wake' ? null : 'owner' });
  const send = () => comms.send({ toKind: 'agent', to: 'art', conversation: conversation.id, source: venue === 'loom' ? 'thread' : venue === 'wake' ? 'trigger' : 'handoff', fromKind: venue === 'loom' ? 'person' : 'agent', fromId: venue === 'loom' ? 'owner' : 'art', words: venue === 'handoff' ? null : 'Hello' });
  const tick = (ms: number) => { at = new Date(Date.parse(at) + ms).toISOString(); };
  return { db, comms, runtime, conversation, send, tick, now };
}
it('admits nonempty inbox once and snapshots house, model, labels and needs', () => {
  const f = fixture();
  expect(f.runtime.admit(f.conversation.id)).toBeUndefined();
  f.send();
  const job = f.runtime.admit(f.conversation.id)!;
  expect(job).toMatchObject({ agent: 'art', conversation: f.conversation.id, title: 'Reply', model: 'primary', state: 'queued', houseFile: 'Housefile', startedByKind: 'agent', startedBy: 'art', project: 'pond', member: null, brief: 'Hello' });
  expect(f.runtime.admit(f.conversation.id)?.id).toBe(job.id);
  expect(f.db.select().from(jobNeeds).all()).toEqual([{ job: job.id, need: 'gpu' }]);
  f.db.update(agentRunSettings).set({ houseFile: 'changed' }).run();
  expect(f.runtime.get(job.id).houseFile).toBe('Housefile');
  expect(working(f)).toEqual([job.id]);
});
it('claims once, rejects other workers, takes mail only when running and preserves confirmed receipts', () => {
  const f = fixture(), mail = f.send(), job = f.runtime.admit(f.conversation.id)!;
  f.tick(100);
  expect(f.runtime.claim(job.id, 'worker')).toMatchObject({ state: 'starting', claimedAt: f.now(), heardAt: f.now() });
  expect(f.runtime.claim(job.id, 'worker')).toBeUndefined();
  expect(() => f.comms.take(f.conversation.id, job.id)).toThrow();
  expect(() => f.runtime.started(job.id, 'foreign', 'image')).toThrow();
  expect(f.runtime.started(job.id, 'worker', 'image').build).toBe('image');
  // A late or repeated report changes nothing once the job is running.
  expect(f.runtime.started(job.id, 'worker', 'other-image')).toMatchObject({ state: 'running', build: 'image' });
  expect(f.comms.take(f.conversation.id, job.id).map(row => row.id)).toEqual([mail.id]);
  const receipt = f.comms.confirm(mail.id, job.id);
  f.tick(100);
  expect(f.runtime.heartbeat(job.id, 'worker', 'running')).toMatchObject({ state: 'running', heardAt: f.now() });
  expect(f.runtime.finish(job.id, 'worker', 0, 'complete').job).toMatchObject({ state: 'done', exitCode: 0, logTail: 'complete', build: 'image' });
  expect(f.db.select().from(inbox).get()).toMatchObject({ state: 'done', job: job.id, doneAt: receipt.doneAt });
  expect(working(f)).toEqual([]);
  expect(() => f.runtime.heartbeat(job.id, 'worker', 'running')).toThrow();
});
it('runs a job that finished without settling its own mail again only under the bounded retry chain', () => {
  // A body that leaves with exit 0 and never took or confirmed the mail it was admitted for (a machine's own
  // runner has no credential to do either), and one that took it and left it unconfirmed.
  for (const take of [false, true]) {
    const f = fixture(), mail = f.send();
    let job = f.runtime.admit(f.conversation.id)!;
    for (let n = 0; n < 4; n++) {
      f.runtime.claim(job.id, 'worker'); f.runtime.started(job.id, 'worker', 'image');
      if (take) f.comms.take(f.conversation.id, job.id);
      const result = f.runtime.finish(job.id, 'worker', 0);
      expect(result.job).toMatchObject({ state: 'done', exitCode: 0, endedNote: 'Finished without settling its mail' });
      if (n === 3) { expect(result.retry).toBeUndefined(); break; }
      expect(result.retry).toMatchObject({ retryOf: job.id, state: 'queued' });
      expect(f.db.select().from(inbox).where(eq(inbox.id, mail.id)).get()).toMatchObject({ state: 'waiting', job: result.retry!.id });
      // Asking admission again starts nothing new: the retry is the conversation's job.
      expect(f.runtime.admit(f.conversation.id)?.id).toBe(result.retry!.id);
      job = result.retry!; f.tick(120_000);
    }
    // The chain is spent. The mail stays with the last attempt and is not admitted again until fresh mail arrives.
    expect(f.db.select().from(inbox).where(eq(inbox.id, mail.id)).get()).toMatchObject({ state: 'waiting', job: job.id });
    expect(f.runtime.admit(f.conversation.id)).toBeUndefined();
    expect(f.db.select().from(jobs).all()).toHaveLength(4);
    f.send();
    expect(f.runtime.admit(f.conversation.id)).toMatchObject({ state: 'queued', retryOf: null });
  }
});
it('hands what a finished body left as fresh mail only when that body confirmed part of its mail', () => {
  const f = fixture(), first = f.send(), second = f.send(), job = f.runtime.admit(f.conversation.id)!;
  f.runtime.claim(job.id, 'worker'); f.runtime.started(job.id, 'worker', 'image');
  f.comms.take(f.conversation.id, job.id); f.comms.confirm(first.id, job.id);
  const result = f.runtime.finish(job.id, 'worker', 0);
  expect(result.job).toMatchObject({ state: 'done', endedNote: null }); expect(result.retry).toBeUndefined();
  expect(f.db.select().from(inbox).where(eq(inbox.id, second.id)).get()).toMatchObject({ state: 'waiting', job: null });
  expect(f.runtime.admit(f.conversation.id)).toMatchObject({ state: 'queued', retryOf: null });
});
it('retries a failed start three times as new linked jobs, without retrying the exhausted chain on old mail', () => {
  const f = fixture(); f.send();
  let job = f.runtime.admit(f.conversation.id)!;
  for (let n = 0; n < 4; n++) {
    // Recreate the service between attempts: the budget lives in the database.
    const runtime = new Jobs(f.db, f.now);
    expect(f.runtime.claim(job.id, 'worker')?.state).toBe('starting');
    const result = runtime.finish(job.id, 'worker', 1, 'start failed');
    expect(result.job.state).toBe('failed');
    if (n === 3) { expect(result.retry).toBeUndefined(); break; }
    expect(result.retry).toMatchObject({ retryOf: job.id, houseFile: 'Housefile', model: 'primary', box: null, state: 'queued' });
    expect(working(f)).toEqual([result.retry!.id]);
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
it('tries a body that failed after starting again only for mail it left unconfirmed, and no more than the same three times', () => {
  const f = fixture(); f.send();
  let job = f.runtime.admit(f.conversation.id)!;
  for (let n = 0; n < 4; n++) {
    f.runtime.claim(job.id, 'worker'); f.runtime.started(job.id, 'worker', 'image');
    f.comms.take(f.conversation.id, job.id);
    const result = f.runtime.finish(job.id, 'worker', 2, 'ignored-prefix:' + 'x'.repeat(20_000) + ':TAIL');
    expect(result.job).toMatchObject({ state: 'failed', exitCode: 2, logTail: 'x'.repeat(16_379) + ':TAIL' });
    if (n === 3) { expect(result.retry).toBeUndefined(); break; }
    // After a body has started, the three retries wait 5 s, 30 s and 120 s: long enough in all to outlast a loom restart.
    const wait = [5_000, 30_000, 120_000][n];
    expect(result.retry).toMatchObject({ retryOf: job.id, state: 'queued', retryAt: new Date(Date.parse(f.now()) + wait).toISOString() });
    expect(f.db.select().from(inbox).get()).toMatchObject({ state: 'waiting', job: result.retry!.id, takenAt: null });
    f.tick(wait - 1); expect(f.runtime.claim(result.retry!.id, 'worker')).toBeUndefined();
    f.tick(1); job = result.retry!;
  }
  // Out of attempts: the mail stays with the last one and no settle period admits it again.
  expect(f.db.select().from(jobs).all()).toHaveLength(4);
  expect(f.db.select().from(inbox).get()).toMatchObject({ state: 'waiting', job: job.id });
  expect(f.runtime.admit(f.conversation.id)).toBeUndefined();
  f.send();
  expect(f.runtime.admit(f.conversation.id)).toMatchObject({ state: 'queued', retryOf: null });
});
it('does not run a body again when it failed after confirming its mail', () => {
  const f = fixture(), mail = f.send(), job = f.runtime.admit(f.conversation.id)!;
  f.runtime.claim(job.id, 'worker'); f.runtime.started(job.id, 'worker', 'image');
  f.comms.take(f.conversation.id, job.id); f.comms.confirm(mail.id, job.id);
  expect(f.runtime.finish(job.id, 'worker', 14).retry).toBeUndefined();
  expect(f.runtime.admit(f.conversation.id)).toBeUndefined();
});
it('tries a job lost while starting again, with its mail, and says in which state it went silent', () => {
  const f = fixture(); f.send(); const job = f.runtime.admit(f.conversation.id)!;
  f.runtime.claim(job.id, 'worker');
  f.tick(120_001); expect(f.runtime.sweep().map(row => row.id)).toEqual([job.id]);
  // loom's own line on the ending is not in the column that holds a runner's output.
  expect(f.runtime.get(job.id)).toMatchObject({ state: 'lost', endedNote: 'Lost while starting: its worker stopped reporting', logTail: null });
  const retry = f.db.select().from(jobs).where(eq(jobs.retryOf, job.id)).get()!;
  expect(retry).toMatchObject({ state: 'queued', box: null });
  expect(f.db.select().from(inbox).get()).toMatchObject({ state: 'waiting', job: retry.id });
  expect(working(f)).toEqual([retry.id]);
  expect(f.runtime.admit(f.conversation.id)?.id).toBe(retry.id);
});
it('records a Comms Stop the same way whether the worker\'s heartbeat or the body\'s own exit brings the news', () => {
  for (const how of ['heartbeat while starting', 'body exit'] as const) {
    const f = fixture('loom'); f.send(); const job = f.runtime.admit(f.conversation.id)!;
    f.runtime.claim(job.id, 'worker');
    if (how === 'body exit') { f.runtime.started(job.id, 'worker', 'image'); f.comms.take(f.conversation.id, job.id); }
    f.db.insert(threadRows).values({ id: 'th', conversation: f.conversation.id, title: 'Reply', titledBy: 'member', pinned: false, openedAt: f.now(), lastAt: f.now(), readSeq: 0, working: true, workingSince: f.now(), workingBeat: f.now(), stopRequested: true }).run();
    if (how === 'heartbeat while starting') expect(f.runtime.takeStop(job.id)?.state).toBe('stopped');
    else {
      // A running body is the one to notice the Stop: the worker's heartbeat leaves it alone.
      expect(f.runtime.takeStop(job.id)).toBeUndefined();
      // The body saw the Stop on its own report and left before confirming its mail.
      expect(f.runtime.finish(job.id, 'worker', BODY_EXIT.stopped)).toMatchObject({ job: { state: 'stopped', exitCode: BODY_EXIT.stopped } });
    }
    // A Stop pressed in the conversation is its own reason, told apart from an owner giving the work up.
    expect(f.runtime.get(job.id)).toMatchObject({ state: 'stopped', endedBy: 'owner', endedReason: 'stop', endedAt: f.now() });
    expect(f.db.select().from(threadRows).get()).toMatchObject({ stopRequested: false, working: false });
    // The stopped work is not run again: its mail stays with the stopped job until fresh mail arrives.
    expect(f.db.select().from(inbox).get()).toMatchObject({ state: 'waiting', job: job.id });
    expect(f.runtime.admit(f.conversation.id)).toBeUndefined();
    expect(f.db.select().from(jobs).all()).toHaveLength(1);
  }
});
it('believes a body that says it left for a Stop only while that Stop is waiting, and leaves an unnoticed Stop on the thread', () => {
  const start = (stopRequested: boolean) => {
    const f = fixture('loom'), mail = f.send(), job = f.runtime.admit(f.conversation.id)!;
    f.runtime.claim(job.id, 'worker'); f.runtime.started(job.id, 'worker', 'image');
    f.db.insert(threadRows).values({ id: 'th', conversation: f.conversation.id, title: 'Reply', titledBy: 'member', pinned: false, openedAt: f.now(), lastAt: f.now(), readSeq: 0, working: true, workingSince: f.now(), workingBeat: f.now(), stopRequested }).run();
    return { ...f, mail, job };
  };
  // No Stop is waiting, so the exit is an ordinary failure, tried again like any other.
  const claimed = start(false);
  expect(claimed.runtime.finish(claimed.job.id, 'worker', BODY_EXIT.stopped)).toMatchObject({ job: { state: 'failed', endedBy: null }, retry: { state: 'queued' } });
  // The body finished its work without noticing the Stop: the work is done, and the Stop is still the thread's.
  const unnoticed = start(true);
  unnoticed.comms.take(unnoticed.conversation.id, unnoticed.job.id); unnoticed.comms.confirm(unnoticed.mail.id, unnoticed.job.id);
  expect(unnoticed.runtime.finish(unnoticed.job.id, 'worker', 0).job).toMatchObject({ state: 'done', endedBy: null });
  expect(unnoticed.db.select().from(threadRows).get()).toMatchObject({ stopRequested: true, working: false });
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

it('keeps private Comms words out of the durable job brief and retry snapshots', () => {
  const f = fixture('loom'); const mail = f.send();
  f.db.update(inbox).set({ words: 'PRIVATE_PROMPT_MARKER' }).where(eq(inbox.id, mail.id)).run();
  const job = f.runtime.admit(f.conversation.id)!;
  expect(job.brief).toBe('');
  f.runtime.claim(job.id, 'worker');
  const result = f.runtime.finish(job.id, 'worker', 1, 'PRIVATE_LAUNCH_DIAGNOSTIC');
  expect(result.job.logTail).toBeNull(); expect(result.retry?.brief).toBe('');
  expect(JSON.stringify(f.db.select().from(jobs).all())).not.toContain('PRIVATE_');
  expect(result.retry?.retryOf).toBe(job.id);
});
it('copies no words of a direct message into a job, whoever sent it', () => {
  // A direct message from someone outside the household has no member to be private to; its words still
  // belong in the conversation's mail and nowhere a job row can show them.
  const f = fixture(); f.db.update(conversations).set({ direct: true }).run(); f.send();
  const job = f.runtime.admit(f.conversation.id)!;
  expect(job.brief).toBe('');
  f.runtime.claim(job.id, 'worker'); f.runtime.started(job.id, 'worker', 'image');
  expect(f.runtime.finish(job.id, 'worker', 2, 'DIRECT_REPLY_MARKER')).toMatchObject({ job: { logTail: null }, retry: { brief: '' } });
});
for (const exitCode of [0, 2]) it(`does not retain private body output after exit ${exitCode}`, () => {
  const f = fixture('loom'); f.send(); const job = f.runtime.admit(f.conversation.id)!;
  f.runtime.claim(job.id, 'worker'); f.runtime.started(job.id, 'worker', 'image');
  const result = f.runtime.finish(job.id, 'worker', exitCode, 'PRIVATE_REPLY_MARKER');
  expect(result.job).toMatchObject({ state: exitCode === 0 ? 'done' : 'failed', exitCode, logTail: null, build: 'image' });
  expect(f.runtime.get(job.id).logTail).toBeNull();
  // Either body left its mail unconfirmed, so it is tried again; the successor carries no words either.
  expect(result.retry).toMatchObject({ brief: '', logTail: null });
  expect(JSON.stringify(f.db.select().from(jobs).all())).not.toContain('PRIVATE_');
});

it('withholds output if a non-null conversation reference cannot be resolved', () => {
  const f = fixture('loom'); f.send(); const job = f.runtime.admit(f.conversation.id)!;
  f.runtime.claim(job.id, 'worker'); f.runtime.started(job.id, 'worker', 'image');
  // Corrupt only this in-memory fixture, never a home or installed database.
  f.db.$client.pragma('foreign_keys = OFF');
  f.db.delete(conversations).where(eq(conversations.id, f.conversation.id)).run();
  expect(f.runtime.finish(job.id, 'worker', 0, 'PRIVATE_MISSING_CONTEXT').job.logTail).toBeNull();
  expect(f.runtime.get(job.id).logTail).toBeNull();
});
it('keeps an unbound job brief and the final log lines', () => {
  const f = fixture(); f.send(); const snapshot = f.runtime.admit(f.conversation.id)!;
  f.db.insert(jobs).values({ ...snapshot, id: 'unbound', conversation: null, box: 'worker', state: 'running', brief: 'unbound instructions', build: 'image' }).run();
  const tail = 'n'.repeat(16_374) + 'last-16384';
  const result = f.runtime.finish('unbound', 'worker', 0, 'OLD '.repeat(5000) + tail);
  expect(result.job).toMatchObject({ state: 'done', brief: 'unbound instructions', logTail: tail });
  expect(f.runtime.get('unbound').logTail).toBe(tail); expect(result.retry).toBeUndefined();
});

it('does not copy a legacy private brief into a new failed-start retry', () => {
  const f = fixture('loom'); f.send(); const job = f.runtime.admit(f.conversation.id)!;
  f.db.update(jobs).set({ brief: 'LEGACY_PRIVATE_WORDS' }).where(eq(jobs.id, job.id)).run();
  expect(f.runtime.workerBrief(job.id)).toBe('');
  f.runtime.claim(job.id, 'worker');
  const result = f.runtime.finish(job.id, 'worker', 1, 'PRIVATE_DIAGNOSTIC');
  expect(result.retry?.brief).toBe(''); expect(result.job.logTail).toBeNull();
  expect(f.runtime.get(result.retry!.id).brief).toBe('');
  expect(f.runtime.get(job.id).brief).toBe('LEGACY_PRIVATE_WORDS');
});

for (const venue of ['wake', 'handoff', 'loom'] as const) it(`keeps dim admission and retry briefs to one line for ${venue}`, () => {
  const f = fixture(venue); f.send(); const dim = f.send();
  f.db.update(inbox).set({ volume: 'dim', words: '\n  First dim line  \nDETAILS_MUST_NOT_REACH_THE_BODY' }).where(eq(inbox.id, dim.id)).run();
  const job = f.runtime.admit(f.conversation.id)!;
  expect(job.brief).toBe(venue === 'wake' ? 'Hello\n\nFirst dim line' : '');
  expect(f.runtime.workerBrief(job.id)).toBe(job.brief); f.runtime.claim(job.id, 'worker');
  const retry = f.runtime.finish(job.id, 'worker', 1).retry!;
  expect(retry.brief).toBe(job.brief); expect(f.runtime.workerBrief(retry.id)).toBe(job.brief);
  expect(JSON.stringify(f.db.select().from(jobs).all())).not.toContain('DETAILS_MUST_NOT_REACH_THE_BODY');
  expect(f.db.select().from(inbox).where(eq(inbox.id, dim.id)).get()).toMatchObject({ state: 'waiting', job: retry.id, volume: 'dim' });
});

for (const separator of ['\r\n', '\v', '\f', '\u0085', '\u2028', '\u2029']) it('keeps dim paragraphs out of worker briefs across supported line separators', () => {
  const f = fixture(), item = f.send(); f.db.update(inbox).set({ volume: 'dim', words: ' Summary '+separator+'Details' }).where(eq(inbox.id, item.id)).run();
  expect(f.runtime.admit(f.conversation.id)?.brief).toBe('Summary');
});
it('preserves full multiline public mail in the same admission with a dim item', () => {
  const f = fixture(), full = f.send(), dim = f.send();
  f.db.update(inbox).set({ words: 'Full first\nFull second' }).where(eq(inbox.id, full.id)).run();
  f.db.update(inbox).set({ volume: 'dim', words: 'Dim first\nDim second' }).where(eq(inbox.id, dim.id)).run();
  expect(f.runtime.admit(f.conversation.id)?.brief).toBe('Full first\nFull second\n\nDim first');
});

it('ends a job no machine took within the queue deadline, with a record of why, and lets fresh mail start again', () => {
  const f = fixture(), mail = f.send(), job = f.runtime.admit(f.conversation.id)!;
  f.tick(QUEUE_DEADLINE_MS); expect(f.runtime.sweep()).toEqual([]);
  f.tick(1);
  const [ended] = f.runtime.sweep();
  expect(ended).toMatchObject({ id: job.id, state: 'failed', exitCode: LOOM_EXIT.unplaced, endedAt: f.now(), box: null });
  expect(ended.endedNote).toMatch(/^Never started: no machine took it within 24 hours/); expect(ended.logTail).toBeNull();
  expect(exitStage(ended.exitCode)).toBe('loom unplaced');
  expect(working(f)).toEqual([]);
  // No next attempt: it would only wait as long again. The mail stays with the ended job until fresh mail arrives.
  expect(f.db.select().from(jobs).all()).toHaveLength(1);
  expect(f.db.select().from(inbox).where(eq(inbox.id, mail.id)).get()).toMatchObject({ state: 'waiting', job: job.id });
  expect(f.runtime.admit(f.conversation.id)).toBeUndefined();
  f.send();
  expect(f.runtime.admit(f.conversation.id)).toMatchObject({ state: 'queued', retryOf: null });
});
it('counts the queue deadline of a retry from when it could first be claimed', () => {
  const f = fixture(); f.send(); const job = f.runtime.admit(f.conversation.id)!;
  f.runtime.claim(job.id, 'worker');
  const retry = f.runtime.finish(job.id, 'worker', 1).retry!;
  f.tick(Date.parse(retry.retryAt!) - Date.parse(f.now()) + QUEUE_DEADLINE_MS); expect(f.runtime.sweep()).toEqual([]);
  f.tick(1); expect(f.runtime.sweep()).toMatchObject([{ id: retry.id, state: 'failed', exitCode: LOOM_EXIT.unplaced }]);
});
it('counts silence from now for a job stamped later than now, as after the server clock is set back', () => {
  const f = fixture(); f.send(); const job = f.runtime.admit(f.conversation.id)!;
  f.runtime.claim(job.id, 'worker'); f.runtime.started(job.id, 'worker', 'image');
  f.tick(-600_000);
  expect(f.runtime.sweep()).toEqual([]);
  expect(f.runtime.get(job.id)).toMatchObject({ state: 'running', heardAt: f.now() });
  f.tick(120_000); expect(f.runtime.sweep()).toEqual([]);
  f.tick(1); expect(f.runtime.sweep()).toMatchObject([{ id: job.id, state: 'lost' }]);
});
it.each([
  ['no model to run on', (f: ReturnType<typeof fixture>) => { f.db.delete(agentModels).run(); }, (f: ReturnType<typeof fixture>) => { f.db.insert(agentModels).values({ agent: 'art', model: 'primary', position: 0 }).run(); }],
  ['no run settings', (f: ReturnType<typeof fixture>) => { f.db.delete(agentRunSettings).run(); }, (f: ReturnType<typeof fixture>) => { f.db.insert(agentRunSettings).values({ agent: 'art', houseRepository: 'r', houseFile: 'Housefile', houseBranch: 'main', nestedContainers: false, gpu: false }).run(); }],
  ['been removed', (f: ReturnType<typeof fixture>) => { f.db.update(agents).set({ removedAt: f.now() }).run(); }, (f: ReturnType<typeof fixture>) => { f.db.update(agents).set({ removedAt: null }).run(); }],
] as const)('tells the owner once why mail did not become a job when the agent has %s, and closes the notice when it does', (why, breakIt, mend) => {
  const f = fixture(); breakIt(f); f.send();
  const notices = () => f.db.select().from(inbox).where(eq(inbox.source, 'notice')).all();
  expect(f.runtime.admission(f.conversation.id)).toEqual({ declined: expect.stringContaining(why), noticed: true });
  expect(notices()).toMatchObject([{ toKind: 'person', to: 'owner', state: 'waiting' }]);
  expect(notices()[0].words).toContain(why); expect(notices()[0].words).toContain('art');
  // Asked again, as every later settling does, and with more mail: still the one notice, and nothing new to announce.
  f.send();
  expect(f.runtime.admission(f.conversation.id)).toEqual({ declined: expect.stringContaining(why), noticed: false });
  expect(f.runtime.admit(f.conversation.id)).toBeUndefined();
  expect(notices()).toHaveLength(1);
  mend(f);
  expect(f.runtime.admit(f.conversation.id)).toMatchObject({ state: 'queued' });
  expect(notices()).toMatchObject([{ state: 'resolved' }]);
});
it('records an admission that threw as a notice, and offers the rest of the batch', () => {
  const f = fixture(), mail = f.send(), changed = vi.fn();
  const broken = new Jobs(f.db, f.now);
  vi.spyOn(broken, 'admission').mockImplementationOnce(() => { throw new Error('disk I/O error\nwith private detail'); });
  expect(agentMailAdmission(broken, changed)({ kind: 'agent', id: 'art' }, [mail])).toBe(false);
  const notice = f.db.select().from(inbox).where(eq(inbox.source, 'notice')).get();
  expect(notice).toMatchObject({ to: 'owner', state: 'waiting' });
  expect(notice?.words).toContain('disk I/O error'); expect(notice?.words).not.toContain('private detail');
  expect(changed).toHaveBeenCalledOnce();
  expect(agentMailAdmission(broken, changed)({ kind: 'agent', id: 'art' }, [mail])).toBe(true);
  expect(f.db.select().from(inbox).where(eq(inbox.source, 'notice')).get()?.state).toBe('resolved');
});
/** Mail and jobs as the program joins them: Tempo's settled inbox offering each batch to agentMailAdmission,
 * and told again (as the root tells it) whenever a job ends. */
function settledFixture() {
  const f = fixture(), clock = new FakeClock(Date.parse(f.now()));
  const settled = new SettledInbox(f.db, clock, agentMailAdmission(f.runtime, () => {}));
  const settle = () => { settled.changed(); clock.advance(defaultTimings.settleSeconds * 1000); };
  const unended = (conversation = f.conversation.id) => f.db.select().from(jobs).where(eq(jobs.conversation, conversation)).all().filter(job => !['done', 'failed', 'lost', 'stopped'].includes(job.state));
  /** A running body that has taken its batch, with a second message arriving behind it. */
  const busy = () => {
    const first = f.send(); settle();
    const [job] = unended();
    f.runtime.claim(job.id, 'worker'); f.runtime.started(job.id, 'worker', 'image');
    f.comms.take(f.conversation.id, job.id);
    const late = f.send(); settle();
    expect(unended().map(row => row.id)).toEqual([job.id]);
    expect(f.db.select().from(inbox).where(eq(inbox.id, late.id)).get()).toMatchObject({ state: 'waiting', job: null });
    return { first, late, job };
  };
  return { ...f, clock, settled, settle, unended, busy };
}
it.each([
  ['finishes', (f: ReturnType<typeof settledFixture>, job: string) => { f.runtime.finish(job, 'worker', 0); }],
  ['fails', (f: ReturnType<typeof settledFixture>, job: string) => { f.runtime.finish(job, 'worker', 1); }],
  ['is stopped', (f: ReturnType<typeof settledFixture>, job: string) => { f.runtime.stop(job, 'owner', 'reset'); }],
  ['is lost', (f: ReturnType<typeof settledFixture>, job: string) => { f.tick(600_000); expect(f.runtime.sweep().map(row => row.state)).toEqual(['lost']); }],
])('starts work for mail that arrived behind a running body once that job %s', (_, end) => {
  const f = settledFixture(), { first, late, job } = f.busy();
  // The body answered what it took, so nothing of its own is left to try again.
  f.comms.confirm(first.id, job.id);
  end(f, job.id);
  // What the root does when a job ends: tell Tempo that capacity changed. No other mail arrives.
  f.settled.changed();
  const next = f.unended();
  expect(next).toHaveLength(1);
  expect(next[0].id).not.toBe(job.id);
  expect(f.db.select().from(inbox).where(eq(inbox.id, late.id)).get()).toMatchObject({ state: 'waiting', job: next[0].id });
  f.settled.close();
});
it('starts work for late mail after the last attempt of a failed job, and not while a retry is queued', () => {
  const f = settledFixture(), { late, job } = f.busy();
  // The body died with its batch unconfirmed: the batch is tried again, and the late mail waits behind the retry.
  const { retry } = f.runtime.finish(job.id, 'worker', 1);
  // The returned batch is a change to the agent's waiting mail, so it settles again before it is offered.
  f.settle();
  expect(f.unended().map(row => row.id)).toEqual([retry!.id]);
  expect(f.db.select().from(inbox).where(eq(inbox.id, late.id)).get()).toMatchObject({ job: null });
  f.runtime.stop(retry!.id, 'owner', 'write-off');
  f.settled.changed();
  const next = f.unended();
  expect(next).toHaveLength(1);
  expect(f.db.select().from(inbox).where(eq(inbox.id, late.id)).get()).toMatchObject({ job: next[0].id });
  f.settled.close();
});
it('starts work for late mail in one conversation when the same batch held new mail for another', () => {
  const f = settledFixture(), { first, late, job } = f.busy();
  const other = f.comms.open({ agent: 'art', venue: 'wake', place: 'elsewhere', label: 'Other', project: 'pond', member: null });
  f.comms.send({ toKind: 'agent', to: 'art', conversation: other.id, source: 'trigger', fromKind: 'agent', fromId: 'art', words: 'Elsewhere' });
  f.settle();
  // The other conversation was free, so its mail became a job; the busy one keeps its late mail waiting.
  expect(f.unended(other.id)).toHaveLength(1);
  expect(f.unended().map(row => row.id)).toEqual([job.id]);
  // Admitting the other conversation's mail changed it, so the batch settles once more while the body works.
  f.settle();
  f.comms.confirm(first.id, job.id);
  f.runtime.finish(job.id, 'worker', 0);
  f.settled.changed();
  const next = f.unended();
  expect(next).toHaveLength(1);
  expect(f.db.select().from(inbox).where(eq(inbox.id, late.id)).get()).toMatchObject({ job: next[0].id });
  expect(f.unended(other.id)).toHaveLength(1);
  f.settled.close();
});
it('tells listeners of an admission only when it started a job or wrote a notice', () => {
  const f = fixture(); let changes = 0;
  const admit = agentMailAdmission(f.runtime, () => { changes++; });
  const mail = f.send(), items = f.db.select().from(inbox).all();
  expect(admit({ kind: 'agent', id: 'art' }, items)).toBe(true);
  expect(changes).toBe(1);
  // Offered again with the job still there: everything waiting is held by it, and nothing changed.
  expect(admit({ kind: 'agent', id: 'art' }, items)).toBe(true);
  expect(changes).toBe(1);
  const job = f.runtime.admit(f.conversation.id)!;
  f.runtime.claim(job.id, 'worker'); f.runtime.started(job.id, 'worker', 'image');
  f.comms.take(f.conversation.id, job.id, [mail.id]);
  f.send();
  // Mail the job does not hold is not admitted, so the settled inbox keeps offering it.
  expect(admit({ kind: 'agent', id: 'art' }, f.db.select().from(inbox).all())).toBe(false);
  expect(changes).toBe(1);
});
