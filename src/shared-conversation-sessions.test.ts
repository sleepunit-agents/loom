/** A member's own thread with an agent over several bodies: the kept harness session its bodies continue, who may
 * take and save it, and that it goes with the thread's words, with the thread, and when the thread is archived.
 * Real doors, the real body program; the harness is stood in for, and the keeper here stands in only for the
 * place a harness keeps its files: it asks loom's two doors as runtime/body-session.ts does. */
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { afterEach, expect, it, vi } from 'vitest';
import * as s from './core/data/schema.js';
import { unendedJobStates } from './core/data/job-states.js';
import { DAY_MS } from './core/day.js';
import { bodyProgram } from './runtime/body-program.js';
import { HarnessResumeUnavailable, type HarnessRun, type HarnessSession } from './runtime/body-harness.js';
import type { BodySessions } from './runtime/body-session.js';
import type { WorkerAssignment } from './runtime/worker.js';
import { bodyFixture, bodyCredentials, credentialHash } from '../test/fixtures/conversation-body.js';

const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });
const OWNERS = { people: [{ kind: 'person' as const, person: 'alice', tier: null }], deniedTools: [], word: 'owners' as const };
const files = (words: string) => Buffer.from(words).toString('base64');

async function fixture() {
  const f = await bodyFixture(clean), now = () => new Date(f.clock.now()).toISOString();
  // The fixture's own job is over: each run below is a job of its own, as one message is.
  f.root.writes.run(() => { f.db.update(s.jobs).set({ state: 'done' }).run(); });
  const door = async (token: string, name: 'session' | 'sessionSave', input: unknown) => {
    const response = await f.call(name, input, randomUUID(), token);
    return { status: response.status, body: await response.json() as { ok: boolean; code?: string; value?: { saved?: boolean; session?: { session: string; files: string; covered?: string[] } | null } } };
  };
  /** The body's keeper over loom's real doors. What it packs is a record of every session id it continued. */
  const keeper = (token: string, calls: string[]) => {
    let covered: string[] | undefined, refused = false, held = '';
    const sessions: BodySessions = {
      get covered() { return covered; }, get refused() { return refused; },
      async take() {
        const reply = await door(token, 'session', { historyKeys: true }); calls.push('take:' + reply.status);
        if (!reply.body.ok) { refused = reply.body.code === 'denied'; return undefined; }
        const kept = reply.body.value!.session; if (!kept) return undefined;
        covered = kept.covered; held = Buffer.from(kept.files, 'base64').toString(); return kept.session;
      },
      async save(session, since, keys, until) {
        const reply = await door(token, 'sessionSave', { session, files: files(held + '|' + session), ...(keys ? { covered: keys } : {}), ...(since ? { since } : {}), ...(until ? { until } : {}) });
        calls.push('save:' + reply.status); return reply.body.value?.saved === true;
      },
      discard() { calls.push('discard'); },
    };
    return sessions;
  };
  /** One body's whole run for the mail waiting in a thread's conversation. */
  const run = async (id: string, native: HarnessRun, more: { conversation?: string; thread?: string; harness?: string; sessions?: (token: string, calls: string[]) => BodySessions; policy?: NonNullable<WorkerAssignment['run']>['policy'] } = {}) => {
    const conversation = more.conversation ?? f.thread.conversation, thread = more.thread ?? f.thread.id, harness = more.harness ?? 'claude';
    const token = 'body_' + createHash('sha256').update(id).digest('hex'), calls: string[] = [];
    const job: WorkerAssignment = { id, agent: 'art', box: 'box', conversation, venue: 'loom', thread, model: 'claude-opus-5-5', account: 'account', harness, brief: '', house: { repository: 'r', file: 'f', branch: 'next' }, run: { nestedContainers: false, gpu: false, ports: [], policy: more.policy ?? OWNERS } };
    f.root.writes.run(() => {
      // The message's own job, if loom queued one, is this one.
      f.db.delete(s.jobs).where(and(eq(s.jobs.conversation, conversation), inArray(s.jobs.state, unendedJobStates))).run();
      f.db.insert(s.jobs).values({ id, agent: 'art', box: 'box', member: 'alice', project: conversation === f.thread.conversation ? 'pond' : null, conversation, title: '', brief: '', model: job.model, harness, state: 'running', startedByKind: 'member', startedBy: 'alice', houseRepository: 'r', houseFile: 'f', houseBranch: 'next', queuedAt: now() }).run();
      f.db.insert(s.tokens).values({ fingerprint: credentialHash(token), label: 'Synthetic body ' + id, kind: 'agent', agent: 'art', job: id, createdAt: now() }).run();
    });
    const exit = await bodyProgram({ args: ['config'], read: async () => JSON.stringify({ command: '/fake/claude', cwd: '/house' }), stdin: async () => Buffer.from(JSON.stringify({ job, build: 'image', bootstrap: { origin: 'https://loom.example', job: id, token } })),
      env: {}, signal: new AbortController().signal, clock: f.clock, fetch: async (url, options) => f.root.http.request(String(url), options), schedule: { every: () => () => {} }, error: vi.fn(), startup: async () => {}, loadMemory: async () => 'IDENTITY', native, sessions: (more.sessions ?? keeper)(token, calls) });
    f.clock.advance(1000);
    f.root.writes.run(() => { f.db.update(s.jobs).set({ state: 'done' }).where(eq(s.jobs.id, id)).run(); });
    return { exit, calls, token };
  };
  const seen: { words: string; session?: HarnessSession }[] = [];
  /** A harness that keeps one session and continues the one it is handed. */
  const native: HarnessRun = async (_job, words, _signal, session) => { seen.push({ words, session }); return { text: 'Answer ' + seen.length, model: 'claude-opus-5-5', actions: [], session: session?.resume ?? 'session-of-run-' + seen.length }; };
  const say = async (words: string) => { expect((await f.send(words, randomUUID())).status).toBe(200); f.clock.advance(1000); };
  const kept = () => f.db.select({ conversation: s.conversationSessions.conversation, harness: s.conversationSessions.harness, session: s.conversationSessions.session, startedAt: s.conversationSessions.startedAt }).from(s.conversationSessions).all();
  const cards = () => f.db.select({ tool: s.messages.tool, run: s.messages.run }).from(s.messages).where(eq(s.messages.kind, 'card')).all();
  return { ...f, now, door, keeper, run, native, seen, say, kept, cards };
}
/** The last thing a body was told: its mail, after the standing blocks. */
const mail = (words: string) => words.split('\n\n').at(-1)!;

it('keeps a thread\'s session for its next body, which is told only the new message, and counts the session from the thread\'s oldest word in it', async () => {
  const f = await fixture(), first = f.now();
  await f.say('What is the plan?');
  const one = await f.run('one', f.native);
  expect(one).toMatchObject({ exit: 0, calls: ['take:200', 'save:200'] });
  // Fresh: asked to keep a session and to continue none, told who it is and its mail.
  expect(f.seen[0].session).toEqual({}); expect(f.seen[0].words).toContain('IDENTITY'); expect(mail(f.seen[0].words)).toBe('What is the plan?');
  // loom keeps it, counted from the message and not from the save: the session holds that word and goes when it does.
  expect(f.kept()).toEqual([{ conversation: f.thread.conversation, harness: 'claude', session: 'session-of-run-1', startedAt: first }]);
  await f.say('Do the second one');
  const two = await f.run('two', f.native);
  expect(two).toMatchObject({ exit: 0, calls: ['take:200', 'save:200'] });
  // Continued: the session holds the first message and its answer, so neither is said again, nor who the agent is.
  expect(f.seen[1].session).toEqual({ resume: 'session-of-run-1' }); expect(mail(f.seen[1].words)).toBe('Do the second one');
  expect(f.seen[1].words).not.toContain('What is the plan?'); expect(f.seen[1].words).not.toContain('Answer 1'); expect(f.seen[1].words).not.toContain('IDENTITY');
  // Who the job works for, and how to post and delegate, are said each time.
  expect(f.seen[1].words).toContain('This job works for the member alice'); expect(f.seen[1].words).toContain('conversation.handoff');
  expect(f.kept()).toEqual([{ conversation: f.thread.conversation, harness: 'claude', session: 'session-of-run-1', startedAt: first }]);
  expect(f.cards()).toEqual([]);
  // Sealed: the session's bytes are not in the database file.
  expect(f.db.$client.serialize().includes(Buffer.from('session-of-run-1|'))).toBe(false);
  // A body of another harness is handed nothing of it and keeps its own beside it: one for a conversation and harness.
  await f.say('And you?');
  expect((await f.run('three', f.native, { harness: 'codex' })).exit).toBe(0);
  expect(f.seen[2].session).toEqual({}); expect(JSON.parse(mail(f.seen[2].words))).toMatchObject({ input: 'And you?', history: [{ words: 'What is the plan?' }, { words: 'Answer 1' }, { words: 'Do the second one' }, { words: 'Answer 2' }] });
  // The first harness's session is now behind the thread's last answer: its next body starts fresh, and the thread is told.
  await f.say('Back to you');
  expect((await f.run('four', f.native)).exit).toBe(0);
  expect(f.seen[3].session).toEqual({}); expect(JSON.parse(mail(f.seen[3].words)).history).toHaveLength(6);
  // So was the other harness's first body there, which had none to continue in a thread already answered.
  expect(f.cards()).toEqual([{ tool: 'Session', run: 'three' }, { tool: 'Session', run: 'four' }]);
  // A step is not history: the next body, continuing, is told its message alone.
  await f.say('Go on');
  expect((await f.run('five', f.native)).exit).toBe(0);
  expect(f.seen[4].session).toEqual({ resume: 'session-of-run-4' }); expect(mail(f.seen[4].words)).toBe('Go on');
});

it('gives both doors to the thread\'s own body alone: not its member, not another thread\'s body, not a job on anybody else\'s word', async () => {
  const f = await fixture(), session = '0f0e0d0c-1111-4222-8333-444455556666';
  await f.say('What is the plan?');
  const one = await f.run('one', f.native); expect(f.kept()).toHaveLength(1);
  // Its job has ended: that body has neither door any more. Nor has the member, in whose thread it is.
  for (const token of [one.token, bodyCredentials.member]) {
    expect((await f.door(token, 'session', {})).status).not.toBe(200);
    expect((await f.door(token, 'sessionSave', { session, files: files('x') })).status).not.toBe(200);
  }
  // Another thread of the same member and agent: its body is handed its own conversation's session, which is none,
  // and what it saves is its own conversation's.
  const elsewhere = 'body_' + createHash('sha256').update('elsewhere').digest('hex');
  let other!: { id: string; conversation: string };
  f.root.writes.run(() => {
    const thread = other = f.root.services.comms!.threads.open({ member: 'alice', agent: 'art', title: 'Another' });
    f.db.insert(s.jobs).values({ id: 'elsewhere', agent: 'art', box: 'box', member: 'alice', conversation: thread.conversation, title: '', brief: '', model: 'claude-opus-5-5', harness: 'claude', state: 'running', startedByKind: 'member', startedBy: 'alice', houseRepository: 'r', houseFile: 'f', houseBranch: 'next', queuedAt: f.now() }).run();
    f.db.insert(s.tokens).values({ fingerprint: credentialHash(elsewhere), label: 'Synthetic body elsewhere', kind: 'agent', agent: 'art', job: 'elsewhere', createdAt: f.now() }).run();
  });
  expect(await f.door(elsewhere, 'session', {})).toMatchObject({ status: 200, body: { value: { session: null } } });
  expect(await f.door(elsewhere, 'sessionSave', { session, files: files('x') })).toMatchObject({ status: 200, body: { value: { saved: true } } });
  expect(f.kept().map(row => [row.conversation, row.session]).sort()).toEqual([[f.thread.conversation, 'session-of-run-1'], [other.conversation, session]].sort());
  f.root.writes.run(() => { f.db.update(s.jobs).set({ state: 'done' }).where(eq(s.jobs.id, 'elsewhere')).run(); f.db.delete(s.conversationSessions).where(eq(s.conversationSessions.conversation, other.conversation)).run(); });
  // The member no longer has the agent, with a message of theirs still waiting: the thread's next job is not one on
  // its owners' word, and loom gives its body neither door, whatever that body was told. What the owners' job left
  // is neither read nor replaced nor removed.
  await f.say('What did you just do?');
  const guest = 'body_' + createHash('sha256').update('guest').digest('hex');
  f.root.writes.run(() => {
    f.db.delete(s.memberAgents).run();
    f.db.delete(s.jobs).where(inArray(s.jobs.state, unendedJobStates)).run();
    f.db.insert(s.jobs).values({ id: 'guest', agent: 'art', box: 'box', member: 'alice', project: 'pond', conversation: f.thread.conversation, title: '', brief: '', model: 'claude-opus-5-5', harness: 'claude', state: 'running', startedByKind: 'member', startedBy: 'alice', houseRepository: 'r', houseFile: 'f', houseBranch: 'next', queuedAt: f.now() }).run();
    f.db.insert(s.tokens).values({ fingerprint: credentialHash(guest), label: 'Synthetic body guest', kind: 'agent', agent: 'art', job: 'guest', createdAt: f.now() }).run();
  });
  expect((await f.door(guest, 'session', {})).status).toBe(403);
  for (const input of [{ session, files: files('x') }, { session: null }]) expect((await f.door(guest, 'sessionSave', input)).status).toBe(403);
  expect(f.kept()).toMatchObject([{ conversation: f.thread.conversation, session: 'session-of-run-1' }]);
});

it('erases a thread\'s kept session with the words it holds, when the thread is archived, and when the thread is deleted', async () => {
  const f = await fixture(), first = f.now();
  f.root.writes.run(() => { f.root.services.setup.settings({ commsDays: 1 }); });
  await f.say('What is the plan?');
  expect((await f.run('one', f.native)).exit).toBe(0);
  // Saved again later, it is still counted from its oldest word.
  f.clock.advance(3_600_000); await f.say('Do the second one'); expect((await f.run('two', f.native)).exit).toBe(0);
  expect(f.seen[1].session).toEqual({ resume: 'session-of-run-1' }); expect(f.kept()).toMatchObject([{ startedAt: first }]);
  // The keep time passes for the first message: the sweep that erases its words erases the session that holds them.
  f.clock.advance(Date.parse(first) + DAY_MS - f.clock.now());
  f.root.writes.run(() => { f.root.services.comms!.expire(); });
  expect(f.db.select({ words: s.messages.words }).from(s.messages).where(and(eq(s.messages.thread, f.thread.id), eq(s.messages.seq, 1))).get()).toEqual({ words: null });
  expect(f.kept()).toEqual([]);
  // The next body starts fresh, told what is still kept, and its session is counted from the oldest of that.
  await f.say('Go on'); expect((await f.run('three', f.native)).exit).toBe(0);
  expect(f.seen[2].session).toEqual({}); const told = JSON.parse(mail(f.seen[2].words)) as { history: { words: string; at: string }[] };
  expect(told.history.map(line => line.words)).toEqual(['Do the second one', 'Answer 2']);
  expect(f.kept()).toMatchObject([{ session: 'session-of-run-3', startedAt: told.history[0].at }]);
  // Archived: the session goes at once, and the thread's body has neither door while it stays archived.
  expect(f.kept()).toHaveLength(1);
  f.root.writes.run(() => { f.root.services.comms!.threads.archive(f.thread.id, true); });
  expect(f.kept()).toEqual([]);
  f.root.writes.run(() => { f.root.services.comms!.threads.archive(f.thread.id, false); });
  await f.say('Opened again'); expect((await f.run('four', f.native)).exit).toBe(0);
  expect(f.seen[3].session).toEqual({}); expect(f.kept()).toMatchObject([{ session: 'session-of-run-4' }]);
  // Deleted by its member: the session goes with the thread.
  f.root.writes.run(() => { f.root.services.comms!.delete(f.thread.id); });
  expect(f.kept()).toEqual([]);
});

it('refuses an archived thread\'s body both doors, and does not count a handed-off session\'s result as an answer the kept session is behind', async () => {
  const f = await fixture();
  await f.say('What is the plan?');
  expect((await f.run('one', f.native)).exit).toBe(0);
  // A session handed off from the thread ends and its result is written into the thread as that job's answer.
  f.root.writes.run(() => {
    const child = f.root.services.conversations.open({ agent: 'art', venue: 'handoff', place: 'child', label: 'Child' });
    f.db.insert(s.jobs).values({ id: 'child', agent: 'art', box: 'box', conversation: child.id, title: '', brief: '', model: 'gpt', state: 'done', startedByKind: 'agent', startedBy: 'art', houseRepository: 'r', houseFile: 'f', houseBranch: 'next', queuedAt: f.now() }).run();
    f.root.services.conversations.turn({ conversation: f.thread.conversation, kind: 'reply', fromKind: 'agent', fromId: 'art', run: 'child' });
  });
  f.clock.advance(1000); await f.say('And then?');
  expect((await f.run('two', f.native)).exit).toBe(0);
  expect(f.seen[1].session).toEqual({ resume: 'session-of-run-1' });
  // An answer nobody can place still counts: the session is behind it.
  f.root.writes.run(() => { f.root.services.conversations.turn({ conversation: f.thread.conversation, kind: 'reply', fromKind: 'agent', fromId: 'art', run: 'unknown' }); });
  f.clock.advance(1000); await f.say('Third');
  expect((await f.run('three', f.native)).exit).toBe(0); expect(f.seen[2].session).toEqual({});
  // Archived while its body works: neither door, and nothing is kept.
  await f.say('Fourth');
  const archiving: HarnessRun = async (job, words, signal, session) => { f.root.writes.run(() => { f.root.services.comms!.threads.archive(f.thread.id, true); }); return f.native(job, words, signal, session); };
  const four = await f.run('four', archiving);
  expect(four.calls).toEqual(['take:200', 'save:403']); expect(f.kept()).toEqual([]);
});

it('runs the work afresh when the harness cannot continue the thread\'s session, and tells the thread', async () => {
  const f = await fixture();
  await f.say('What is the plan?'); expect((await f.run('one', f.native)).exit).toBe(0);
  await f.say('Do the second one');
  const failing: HarnessRun = async (job, words, signal, session) => { if (session?.resume) { f.seen.push({ words, session }); throw new HarnessResumeUnavailable(); } return f.native(job, words, signal, session); };
  expect((await f.run('two', failing)).exit).toBe(0);
  expect(f.seen.slice(1).map(row => row.session)).toEqual([{ resume: 'session-of-run-1' }, {}]);
  expect(JSON.parse(mail(f.seen[2].words))).toMatchObject({ input: 'Do the second one', history: [{ words: 'What is the plan?' }, { words: 'Answer 1' }] });
  expect(f.cards()).toEqual([{ tool: 'Session', run: 'two' }]);
  expect(f.kept()).toMatchObject([{ session: 'session-of-run-3' }]);
});
