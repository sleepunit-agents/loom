/** Wake me when, through the real shared root: each source and condition from real rows, each step of the
 * delivery rule, who may ask, the bounds, and cancelling. */
import { afterEach, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { bodyCredentials, bodyFixture } from '../test/fixtures/conversation-body.js';
import { agentAccounts, agentModels, agentRunSettings, approvals, changes, conversations, inbox, inboxRefs, jobs, projectMembers, projectRepositories, threads, triggerLog, triggers } from './core/data/schema.js';
import { terminalSilenceMs } from './core/conversations/terminal-sessions.js';
import { WAKES_MAX, WAKE_MS, WATCH_ENDED } from './core/tempo/wake.js';
import { change } from './pieces/changes/change.fixture.js';
import type { Change } from './pieces/changes/model.js';

const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });

async function fixture(options: Parameters<typeof bodyFixture>[1] = {}) {
  const f = await bodyFixture(clean, options), now = () => new Date(f.clock.now()).toISOString();
  f.db.insert(agentModels).values({ agent: 'art', model: 'model', position: 0 }).run();
  f.db.insert(agentRunSettings).values({ agent: 'art', houseRepository: 'fixture', houseFile: 'HOUSE.md', houseBranch: 'next', nestedContainers: false, gpu: false }).run();
  f.db.insert(agentAccounts).values({ agent: 'art', service: 'github', login: 'art-bot' }).run();
  let n = 0;
  const post = async (name: string, input: unknown, token = bodyCredentials.body, id = `call-${++n}`) => {
    const response = await f.root.http.request('/api/' + name.replace('.', '/'), { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ input, id }) });
    return { status: response.status, body: await response.json() as { ok: boolean; code?: string; message?: string; value?: { id: string; says: string } & Record<string, unknown> } };
  };
  const wake = (input: unknown, token?: string) => post('tempo.wake', input, token);
  /** The body's job stays heard from, so the runtime's own sweep does not end it while a test waits. */
  const beat = () => f.db.update(jobs).set({ heardAt: now(), claimedAt: now() }).where(eq(jobs.id, 'job')).run();
  beat();
  const put = (values: Partial<Change> = {}) => f.root.services.changes.put(change(values));
  const mail = (conversation?: string) => f.db.select().from(inbox).where(and(eq(inbox.toKind, 'agent'), eq(inbox.source, 'trigger'), conversation ? eq(inbox.conversation, conversation) : undefined)).all();
  const trigger = (id: string) => f.db.select().from(triggers).where(eq(triggers.id, id)).get()!;
  const endBody = () => { f.root.writes.run(() => f.db.update(jobs).set({ state: 'done', endedAt: now() }).where(eq(jobs.id, 'job')).run()); };
  return { ...f, now, post, wake, put, mail, trigger, beat, endBody, cv: f.thread.conversation };
}
const running = (names: string[]) => ({ state: 'running' as const, failing: [], running: names, total: names.length });
const failing = (names: string[]) => ({ state: 'failing' as const, failing: names, running: [], total: 3 });
const passing = { state: 'passing' as const, failing: [], running: [], total: 3 }, none = { state: 'none' as const, failing: [], running: [], total: 0 };
const head = (letter: string) => ({ id: letter.repeat(40), ref: 'art/fix' });

it('makes one once-only trigger for a time, aimed at the asking conversation, and relays the wake to the body awake there', async () => {
  const f = await fixture();
  const asked = await f.wake({ what: 'in:1', note: 'I was halfway through the migration; run the tests next.' });
  expect(asked.status).toBe(200);
  const at = new Date(f.clock.now() + 60_000).toISOString();
  expect(asked.body.value!.says).toBe(`I'll wake you in this conversation at ${at}. To cancel: tempo.stop ${asked.body.value!.id}.`);
  expect(f.db.select().from(triggers).all()).toHaveLength(1);
  // Recorded as any trigger a body sets for a member who is not a household owner: that member's, on her word.
  expect(f.trigger(asked.body.value!.id)).toMatchObject({ lifespan: 'once', sourceKind: 'time', times: at, targetKind: 'inbox', target: 'wake', toKind: 'agent', to: 'art', ownerKind: 'member', owner: 'alice',
    conversation: f.cv, askedByKind: 'member', askedBy: 'alice', note: `Wake Art at ${at}`, enabled: true, state: 'standing', project: 'pond' });
  f.clock.advance(59_000); f.beat(); expect(f.mail()).toEqual([]);
  f.clock.advance(1_000);
  const sent = f.mail();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ conversation: f.cv, fromKind: 'schedule', state: 'waiting', onWordKind: 'member', onWord: 'alice' });
  expect(sent[0].words).toContain('[A wake from loom, not a person speaking now. You, on the word of the member alice, asked at');
  expect(sent[0].words).toContain('the time you asked to be woken at');
  expect(sent[0].words).toContain('"I was halfway through the migration; run the tests next."');
  expect(f.trigger(asked.body.value!.id)).toMatchObject({ enabled: false, state: 'fired' });
  // The body awake there took its mail when its turn began; the wake is the conversation's next turn, started when this one ends.
  f.clock.advance(10_000);
  expect(f.db.select().from(jobs).where(eq(jobs.conversation, f.cv)).all()).toHaveLength(1);
  f.endBody(); f.clock.advance(10_000);
  const all = f.db.select().from(jobs).where(eq(jobs.conversation, f.cv)).all();
  expect(all).toHaveLength(2);
  expect(f.mail()[0].job).toBe(all.find(job => job.id !== 'job')!.id);
  // It fired once: nothing more is said.
  f.clock.advance(120_000); expect(f.mail()).toHaveLength(1);
});

it('brings up a conversation nothing is awake in: the wake is its input and starts a job there', async () => {
  const f = await fixture();
  const asked = await f.wake({ what: `at:${new Date(f.clock.now() + 60_000).toISOString()}` });
  expect(asked.status).toBe(200);
  f.endBody();
  f.clock.advance(60_000 + 10_000);
  const started = f.db.select().from(jobs).where(and(eq(jobs.conversation, f.cv), eq(jobs.state, 'queued'))).all();
  expect(started).toHaveLength(1);
  expect(f.mail(f.cv)).toMatchObject([{ job: started[0].id }]);
});

it('starts a new conversation with the right information when the one it was asked from is gone', async () => {
  const f = await fixture();
  const asked = await f.wake({ what: 'in:1', note: 'Look at the deploy log.' });
  f.endBody();
  f.root.writes.run(() => f.db.update(threads).set({ archivedAt: f.now() }).where(eq(threads.id, f.thread.id)).run());
  f.clock.advance(60_000);
  expect(f.mail(f.cv)).toEqual([]);
  const sent = f.mail();
  expect(sent).toHaveLength(1);
  const fresh = f.db.select().from(conversations).where(eq(conversations.id, sent[0].conversation!)).get()!;
  // A member's private work stays that member's: the new conversation is private to her, as the old one was.
  expect(fresh).toMatchObject({ agent: 'art', venue: 'wake', member: 'alice', label: f.trigger(asked.body.value!.id).note });
  expect(sent[0].words).toContain('"Look at the deploy log."');
  expect(sent[0].words).toContain(`This is a new conversation: the thread it was asked from was archived. It continues conversation ${f.cv}.`);
  expect(f.db.select().from(inboxRefs).where(eq(inboxRefs.item, sent[0].id)).all().map(row => row.ref).sort()).toEqual([asked.body.value!.id, f.cv].sort());
  f.clock.advance(10_000);
  expect(f.db.select().from(jobs).where(eq(jobs.conversation, fresh.id)).all()).toMatchObject([{ state: 'queued', member: 'alice' }]);
});

it('waits for checks to finish across a new head commit, and says so once with before and after', async () => {
  const f = await fixture();
  f.put({ checks: passing, head: head('a') });
  const asked = await f.wake({ what: 'github:acme/app#3', when: 'checks-finished', note: 'Merge it if green.' });
  expect(asked.status).toBe(200);
  expect(asked.body.value!.says).toBe(`I'll wake you in this conversation when checks finish on acme/app#3. Right now: checks: all passed; review: approved. If that has not happened in 14 days the wait ends and says so. To cancel: tempo.stop ${asked.body.value!.id}.`);
  expect(f.trigger(asked.body.value!.id)).toMatchObject({ sourceKind: 'pull-request', watches: 'change:github:acme/app#3', target: 'wake:checks-finished', note: 'Wake Art when checks finish on acme/app#3' });
  // Checks that were already finished when it asked are not news, whatever else about the change moves.
  f.put({ checks: passing, head: head('a'), title: 'A change, retitled' });
  expect(f.mail()).toEqual([]);
  // A push: the new head's checks have not begun, then run. Nothing is finished yet.
  f.put({ checks: none, head: head('b'), title: 'A change, retitled' });
  f.put({ checks: running(['build', 'test']), head: head('b'), title: 'A change, retitled' });
  expect(f.mail()).toEqual([]);
  expect(f.trigger(asked.body.value!.id)).toMatchObject({ enabled: true, state: 'standing' });
  f.put({ checks: failing(['build', 'DCO sign-off']), head: head('b'), title: 'A change, retitled' });
  const sent = f.mail();
  expect(sent).toHaveLength(1);
  expect(sent[0].words).toContain('Checks on acme/app#3 finished on bbbbbbb: 2 failed: DCO sign-off, build. Before: 2 still running.');
  expect(sent[0].words).toContain('See https://github.com/acme/app/pull/3');
  expect(sent[0].words).toContain('"Merge it if green."');
  // Once: a rerun that passes is no second wake, and the trigger is done.
  f.put({ checks: passing, head: head('b'), title: 'A change, retitled' });
  expect(f.mail()).toHaveLength(1);
  expect(f.trigger(asked.body.value!.id)).toMatchObject({ enabled: false, state: 'fired' });
  expect(f.db.select().from(triggerLog).where(and(eq(triggerLog.trigger, asked.body.value!.id), eq(triggerLog.event, 'fired'))).all()).toHaveLength(1);
});

it('says the right thing for each pull request condition, and only when it becomes true', async () => {
  const f = await fixture();
  f.put({ checks: running(['build']), review: { state: 'required', by: [] } });
  const ids: Record<string, string> = {};
  for (const when of ['changed', 'checks-failed', 'review', 'merged-or-closed'] as const) ids[when] = (await f.wake({ what: 'acme/app#3', when })).body.value!.id;
  const said = (when: string) => f.db.select({ words: inbox.words }).from(inbox).innerJoin(inboxRefs, eq(inboxRefs.item, inbox.id)).where(eq(inboxRefs.ref, ids[when])).all().map(row => row.words!);
  // The same snapshot again is no change, and writes nothing.
  const logged = f.db.select().from(triggerLog).all().length;
  f.put({ checks: running(['build']), review: { state: 'required', by: [] } });
  expect(f.db.select().from(triggerLog).all()).toHaveLength(logged);
  f.put({ checks: failing(['build']), review: { state: 'required', by: [] } });
  expect(said('changed')).toHaveLength(1);
  expect(said('changed')[0]).toContain('acme/app#3 changed: checks: 1 failed: build (before: 1 still running).');
  expect(said('checks-failed')[0]).toContain('A check failed on acme/app#3: build. Before: 1 still running.');
  expect(said('review')).toEqual([]); expect(said('merged-or-closed')).toEqual([]);
  f.put({ checks: failing(['build']), review: { state: 'changes_requested', by: [] }, people: [{ login: 'jonathan', role: 'reviewer' }] });
  expect(said('review')[0]).toContain('Review on acme/app#3: changes requested (before: review required, none given yet). Reviewed by jonathan.');
  f.put({ checks: failing(['build']), review: { state: 'changes_requested', by: [] }, people: [{ login: 'jonathan', role: 'reviewer' }], state: 'merged', closed: f.now() });
  expect(said('merged-or-closed')[0]).toContain('acme/app#3 was merged. Now: it is merged.');
  for (const when of Object.keys(ids)) expect(said(when)).toHaveLength(1);
});

it('ends a wait on checks or review when the pull request is merged first, and says so', async () => {
  const f = await fixture();
  f.put({ checks: running(['build']) });
  const asked = await f.wake({ what: 'acme/app#3', when: 'checks-finished' });
  f.put({ checks: running(['build']), state: 'closed', closed: f.now() });
  expect(f.mail()[0].words).toContain('acme/app#3 was closed without merging before its checks finished; the watch has ended.');
  expect(f.trigger(asked.body.value!.id).state).toBe('fired');
  expect((await f.wake({ what: 'acme/app#3' })).body).toMatchObject({ ok: false, code: 'invalid', message: 'acme/app#3 is already closed: there is nothing left to wait for.' });
});

it('makes an untracked pull request tracked, keeps it fresh with the one poller, and refuses what it cannot read', async () => {
  let rows: Change[] = [change({ id: 'github:else/where#7', repo: 'github:else/where', number: 7, url: 'https://github.com/else/where/pull/7', checks: running(['build']) }),
    change({ id: 'github:else/where#8', repo: 'github:else/where', number: 8, author: { login: 'stranger' } })];
  const reads: string[] = [];
  const f = await fixture({ changes: { read: async repository => { reads.push(repository); if (repository !== 'github:else/where' && repository !== 'else/where') throw new Error('no'); return rows; } } });
  await Promise.resolve();
  // A pull request the household's GitHub sign-in cannot read is refused plainly, and nothing is kept.
  expect((await f.wake({ what: 'github:secret/repo#1' })).body).toMatchObject({ ok: false, code: 'unavailable', message: 'The household\'s GitHub sign-in cannot read secret/repo, so loom cannot watch secret/repo#1.' });
  expect((await f.wake({ what: 'github:else/where#99' })).body).toMatchObject({ ok: false, code: 'not-found' });
  // One it can read but the asking agent may not (nobody's project, not its own pull request) is refused, and is not left tracked.
  expect((await f.wake({ what: 'github:else/where#8' })).body).toMatchObject({ ok: false, code: 'denied', message: 'else/where#8 is not a pull request you may read.' });
  expect(f.db.select().from(changes).all()).toEqual([]); expect(f.db.select().from(triggers).all()).toEqual([]);
  // Its own pull request in a repository no project lists: tracked by the asking.
  const asked = await f.wake({ what: 'https://github.com/else/where/pull/7', when: 'checks-finished' });
  expect(asked.status).toBe(200);
  expect(f.db.select().from(changes).all()).toMatchObject([{ id: 'github:else/where#7', agent: 'art', project: null, checks: 'running' }]);
  // The poller reads it from then on, and of that repository keeps only what is watched.
  rows = [{ ...rows[0], checks: passing }, rows[1]];
  reads.length = 0; f.clock.advance(60_000); await new Promise(resolve => setImmediate(resolve));
  expect(reads.length).toBeGreaterThan(0);
  expect(f.db.select({ id: changes.id, checks: changes.checks }).from(changes).all()).toEqual([{ id: 'github:else/where#7', checks: 'passing' }]);
  expect(f.mail()).toHaveLength(1);
  expect(f.mail()[0].words).toContain('Checks on else/where#7 finished on aaaaaaa: all passed. Before: 1 still running.');
  // The watch is over: the repository is read no more.
  reads.length = 0; f.clock.advance(60_000); await new Promise(resolve => setImmediate(resolve));
  expect(reads).toEqual([]);
});

it('wakes when a job ends and when an ask is answered, in plain words', async () => {
  const f = await fixture();
  // A job of the agent's own in the project (no member's private thread: that job is the member's alone to read).
  f.db.insert(jobs).values({ id: 'job-other', agent: 'art', project: 'pond', title: 'Rebuild the index', state: 'running', brief: '', model: 'model', startedByKind: 'agent', startedBy: 'art',
    houseRepository: 'fixture', houseFile: 'HOUSE.md', houseBranch: 'next', queuedAt: f.now(), claimedAt: f.now(), heardAt: f.now() }).run();
  f.db.insert(approvals).values({ id: 'ap-1', kind: 'command', target: 'deploy', what: 'Deploy', why: 'It is ready', agent: 'art', askedFrom: 'thread', actingFor: 'alice', project: 'pond', state: 'pending', minutes: 30,
    ask: 'Deploy the site?', ifYes: 'It deploys', ifNo: 'Nothing happens', details: '', askedAt: f.now() }).run();
  const job = await f.wake({ what: 'job:job-other' }), approval = await f.wake({ what: 'approval:ap-1' });
  expect([job.body, approval.body]).toMatchObject([{ ok: true }, { ok: true }]);
  expect(f.trigger(job.body.value!.id)).toMatchObject({ sourceKind: 'job', watches: 'job:job-other', note: 'Wake Art when job job-other ends' });
  expect(f.mail()).toEqual([]);
  f.root.writes.run(() => f.db.update(jobs).set({ state: 'failed', endedAt: f.now(), endedNote: 'No word from it' }).where(eq(jobs.id, 'job-other')).run());
  f.root.services.tempo.sources.job('job-other');
  f.root.writes.run(() => f.db.update(approvals).set({ state: 'allowed', decidedBy: 'alice', decidedAt: f.now() }).where(eq(approvals.id, 'ap-1')).run());
  const words = f.mail().map(item => item.words!);
  expect(words).toHaveLength(2);
  expect(words.find(text => text.includes('job-other'))).toContain('Job job-other ("Rebuild the index") ended: failed. loom\'s note: No word from it');
  expect(words.find(text => text.includes('ap-1'))).toContain('Alice answered: Allow. The card asked: "Deploy the site?"');
  // A condition is a pull request's; anything else has one way to happen.
  expect((await f.wake({ what: 'job:job-other', when: 'changed' })).body).toMatchObject({ ok: false, code: 'invalid' });
  expect((await f.wake({ what: 'the build' })).body).toMatchObject({ ok: false, code: 'invalid' });
});

it('relays a wake to a live terminal session through its hook, once, and only to a hook that shows wakes', async () => {
  const f = await fixture();
  const { token } = f.root.services.signin.issue({ kind: 'agent', agent: 'art', label: 'Terminal', terminalMachine: 'box' }, 'alice');
  const key = { machine: 'box', sessionId: 's', harness: 'claude' };
  const opened = (await f.post('terminal.session', { ...key, action: 'open', model: null, cwd: '/home/alice/Code/pond' }, token)).body.value as unknown as { conversation: string; job: string };
  // It names no conversation: its one live session on this machine is where it is woken.
  const asked = await f.wake({ what: 'in:1', note: 'Check the review.' }, token);
  expect(asked.status).toBe(200);
  expect(asked.body.value!.says).toContain('in this terminal session, or in a new conversation if it has ended');
  expect(f.trigger(asked.body.value!.id)).toMatchObject({ conversation: opened.conversation, ownerKind: 'agent', owner: 'art', askedByKind: 'agent', askedBy: 'art' });
  f.clock.advance(60_000);
  expect(f.mail(opened.conversation)).toMatchObject([{ state: 'waiting' }]);
  // A hook that does not say it shows wakes is handed none, so it cannot lose one.
  const plain = await f.post('terminal.session', { ...key, action: 'heartbeat' }, token);
  expect(plain.body.value).not.toHaveProperty('wakes');
  expect(f.mail(opened.conversation)).toMatchObject([{ state: 'waiting' }]);
  const turn = await f.post('terminal.session', { ...key, action: 'turn', role: 'member', eventId: 'm1', words: 'carry on', wakes: true }, token, 'turn-1');
  const handed = (turn.body.value as unknown as { wakes: { id: string; at: string; words: string }[] }).wakes;
  expect(handed).toHaveLength(1);
  expect(handed[0].words).toContain('"Check the review."');
  expect(f.mail(opened.conversation)).toMatchObject([{ state: 'done', job: opened.job }]);
  // A retry of that report is answered with the same wakes; the next report has none. No job is ever started for a terminal.
  expect(((await f.post('terminal.session', { ...key, action: 'turn', role: 'member', eventId: 'm1', words: 'carry on', wakes: true }, token, 'turn-1')).body.value as unknown as { wakes: unknown[] }).wakes).toHaveLength(1);
  expect((await f.post('terminal.session', { ...key, action: 'heartbeat', wakes: true }, token)).body.value).not.toHaveProperty('wakes');
  f.clock.advance(10_000);
  expect(f.db.select().from(jobs).where(eq(jobs.conversation, opened.conversation)).all()).toHaveLength(1);
});

it('moves a wake a terminal session never picked up to a new conversation once the session has been silent too long', async () => {
  const f = await fixture();
  const { token } = f.root.services.signin.issue({ kind: 'agent', agent: 'art', label: 'Terminal', terminalMachine: 'box' }, 'alice');
  const key = { machine: 'box', sessionId: 's', harness: 'claude' };
  const opened = (await f.post('terminal.session', { ...key, action: 'open', model: null, cwd: '/work' }, token)).body.value as unknown as { conversation: string; job: string };
  const asked = await f.wake({ what: 'in:1', note: 'Pick the branch back up.', conversation: opened.conversation }, token);
  expect(asked.status).toBe(200);
  f.clock.advance(60_000);
  expect(f.mail(opened.conversation)).toMatchObject([{ state: 'waiting' }]);
  // Still within the silence loom allows a terminal session: the wake waits for its hook.
  f.clock.advance(terminalSilenceMs - 90_000);
  expect(f.mail(opened.conversation)).toMatchObject([{ state: 'waiting' }]);
  f.clock.advance(120_000);
  expect(f.mail(opened.conversation)).toMatchObject([{ state: 'resolved' }]);
  const moved = f.mail().filter(item => item.conversation !== opened.conversation);
  expect(moved).toHaveLength(1);
  expect(moved[0].words).toContain('"Pick the branch back up."');
  expect(moved[0].words).toContain(`It continues conversation ${opened.conversation}.`);
  expect(f.db.select().from(conversations).where(eq(conversations.id, moved[0].conversation!)).get()).toMatchObject({ venue: 'wake', agent: 'art', member: 'alice' });
  // And a session that has already ended when the wake fires gets a new conversation at once.
  const later = await f.wake({ what: 'in:1', conversation: opened.conversation }, token);
  expect(later.status).toBe(200);
  f.clock.advance(60_000);
  const second = f.mail().filter(item => item.conversation !== opened.conversation && item.id !== moved[0].id);
  expect(second).toHaveLength(1);
  expect(second[0].words).toContain('the terminal session it was asked from has ended, and loom cannot start a terminal');
});

it('refuses a watch on what the asker may not read, and says only that the watch ended when it can no longer read it', async () => {
  const f = await fixture();
  // Bob's own conversation with another agent: its job is not Art's to watch.
  f.db.insert(conversations).values({ id: 'cv-bob', agent: 'mark', member: 'bob', venue: 'loom', place: 'th:bob', label: 'Bob', startedAt: f.now(), lastAt: f.now(), turnCount: 0 }).run();
  f.db.insert(jobs).values({ id: 'job-bob', agent: 'mark', member: 'bob', conversation: 'cv-bob', title: 'Private', state: 'running', brief: '', model: 'model', startedByKind: 'agent', startedBy: 'mark',
    houseRepository: 'fixture', houseFile: 'HOUSE.md', houseBranch: 'next', queuedAt: f.now() }).run();
  expect((await f.wake({ what: 'job:job-bob' })).status).toBe(403);
  expect((await f.wake({ what: 'job:job-nowhere' })).status).toBe(403);
  // Another conversation is not one this body is in.
  expect((await f.wake({ what: 'in:5', conversation: 'cv-bob' })).body).toMatchObject({ ok: false, code: 'denied' });
  // A person does not ask to be woken.
  expect((await f.wake({ what: 'in:5' }, bodyCredentials.member)).status).toBe(403);
  expect(f.db.select().from(triggers).all()).toEqual([]);
  // A pull request read through a project: the member the body works for is in it when it asks, and has left when it fires.
  f.db.insert(projectRepositories).values({ project: 'pond', repository: 'acme/app' }).run();
  f.put({ author: { login: 'stranger' }, checks: running(['build']) });
  expect(f.db.select().from(changes).get()).toMatchObject({ project: 'pond', agent: null });
  const asked = await f.wake({ what: 'acme/app#3', note: 'My own note.' });
  expect(asked.status).toBe(200);
  f.root.writes.run(() => f.db.delete(projectMembers).where(eq(projectMembers.member, 'alice')).run());
  f.put({ author: { login: 'stranger' }, checks: failing(['secret-check-name']), title: 'A secret title' });
  const sent = f.mail();
  expect(sent).toHaveLength(1);
  expect(sent[0].words).toContain(WATCH_ENDED);
  expect(sent[0].words).toContain('"My own note."');
  expect(sent[0].words).not.toContain('secret');
  expect(sent[0].words).not.toContain('github.com');
});

it('bounds how many waits an agent holds and how long one lives, and cancels one with tempo.stop', async () => {
  const f = await fixture();
  f.put({ checks: running(['build']) });
  const first = await f.wake({ what: 'acme/app#3', when: 'merged-or-closed' });
  expect(first.status).toBe(200);
  for (let n = 1; n < WAKES_MAX; n++) f.db.insert(triggers).values({ id: `filler-${n}`, ownerKind: 'agent', owner: 'art', sourceKind: 'job', watches: 'job:none', lifespan: 'once', targetKind: 'inbox', target: 'wake',
    toKind: 'agent', to: 'art', note: 'Filler', enabled: true, state: 'standing', createdAt: f.now(), changedAt: f.now() }).run();
  expect((await f.wake({ what: 'in:5' })).body).toMatchObject({ ok: false, code: 'conflict', message: `You already have ${WAKES_MAX} waits pending. Cancel one first (tempo.stop).` });
  f.db.delete(triggers).where(eq(triggers.note, 'Filler')).run();
  // Cancelled: nothing is said when it then happens.
  const cancelled = await f.wake({ what: 'acme/app#3', when: 'changed' });
  expect((await f.post('tempo.stop', { id: cancelled.body.value!.id })).status).toBe(200);
  f.put({ checks: passing });
  expect(f.mail()).toEqual([]);
  // A wait that is 14 days old ends, and says so. A time further off than that is refused.
  expect((await f.wake({ what: `in:${WAKE_MS / 60_000 + 1}` })).body).toMatchObject({ ok: false, code: 'invalid', message: 'A wait lives at most 14 days' });
  f.db.update(triggers).set({ createdAt: new Date(f.clock.now() - WAKE_MS - 1_000).toISOString() }).where(eq(triggers.id, first.body.value!.id)).run();
  expect(f.root.services.tempo.wakes.sweep()).toBe(true);
  expect(f.mail()).toHaveLength(1);
  expect(f.mail()[0].words).toContain('The watch ended: 14 days passed and it never happened that acme/app#3 is merged or closed. Now: checks: all passed; review: approved.');
  expect(f.trigger(first.body.value!.id)).toMatchObject({ enabled: false, state: 'fired' });
  // Nothing left to end: the sweep writes nothing.
  expect(f.root.services.tempo.wakes.sweep()).toBe(false);
  // A wake is made only at its own door.
  expect((await f.post('tempo.set', { ownerKind: 'agent', owner: 'art', sourceKind: 'time', times: new Date(f.clock.now() + 60_000).toISOString(), lifespan: 'once', targetKind: 'inbox', target: 'wake', toKind: 'agent', to: 'art', note: 'Sneaky' })).body)
    .toMatchObject({ ok: false, message: 'A wake is asked for with tempo.wake' });
});
