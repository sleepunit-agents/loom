import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { eq, notInArray } from 'drizzle-orm';
import { createDataSchema } from '../core/data/database.js';
import { Conversations } from '../core/conversations/index.js';
import { agents, members, projects, boxes, agentModels, agentRunSettings, conversations, inbox, jobNeeds, jobs, threads as threadRows } from '../core/data/schema.js';
import { Jobs } from './jobs.js';
import { BODY_EXIT } from './job-exit.js';

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
  expect(f.runtime.heartbeat(job.id, 'worker', 'waiting')).toMatchObject({ state: 'waiting', heardAt: f.now() });
  f.tick(100);
  expect(f.runtime.heartbeat(job.id, 'worker', 'running')).toMatchObject({ state: 'running', heardAt: f.now() });
  expect(f.runtime.finish(job.id, 'worker', 0, 'complete').job).toMatchObject({ state: 'done', exitCode: 0, logTail: 'complete', build: 'image' });
  expect(f.db.select().from(inbox).get()).toMatchObject({ state: 'done', job: job.id, doneAt: receipt.doneAt });
  expect(working(f)).toEqual([]);
  expect(() => f.runtime.heartbeat(job.id, 'worker', 'running')).toThrow();
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
  expect(f.runtime.get(job.id)).toMatchObject({ state: 'lost', logTail: 'Lost while starting: its worker stopped reporting' });
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
    expect(f.runtime.get(job.id)).toMatchObject({ state: 'stopped', endedBy: 'owner', endedReason: 'write-off', endedAt: f.now() });
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
for (const exitCode of [0, 2]) it(`does not retain private body output after exit ${exitCode}`, () => {
  const f = fixture('loom'); f.send(); const job = f.runtime.admit(f.conversation.id)!;
  f.runtime.claim(job.id, 'worker'); f.runtime.started(job.id, 'worker', 'image');
  const result = f.runtime.finish(job.id, 'worker', exitCode, 'PRIVATE_REPLY_MARKER');
  expect(result.job).toMatchObject({ state: exitCode === 0 ? 'done' : 'failed', exitCode, logTail: null, build: 'image' });
  expect(f.runtime.get(job.id).logTail).toBeNull();
  // The failed body left its mail unconfirmed, so it is tried again; the successor carries no words either.
  if (exitCode === 0) expect(result.retry).toBeUndefined(); else expect(result.retry).toMatchObject({ brief: '', logTail: null });
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
