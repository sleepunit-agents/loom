/** Wake me when, through the real shared root: each source and condition from real rows, each step of the
 * delivery rule, who may ask, the bounds, and cancelling. */
import { afterEach, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { bodyCredentials, bodyFixture } from '../test/fixtures/conversation-body.js';
import { agentAccounts, agentModels, agentRunSettings, approvals, boxes, changes, conversations, inbox, inboxRefs, jobs, memberAgents, members, projectMembers, projectRepositories, threads, tokens, triggerLog, triggers } from './core/data/schema.js';
import { terminalSilenceMs } from './core/conversations/terminal-sessions.js';
import { TIME_EXPIRED, WAIT_ENDED_BARE, WAKES_MAX, WAKE_EDIT_REFUSAL, WAKE_MS, WAKE_TIME_MOST_MS, WAKE_TOO_OLD, WATCH_ENDED, wakesFull } from './core/tempo/wake.js';
import { readsRepository } from './apps/changes.js';
import { canReadSharedConversation } from './shared-sharing.js';
import { NO_CONVERSATION_REFUSAL, PULL_REFUSAL, SESSION_NEEDED, SESSION_REFUSAL, WATCH_REFUSAL, rehome } from './shared-wake.js';
import { workPrincipal } from './policy.js';
import { secretRequests, secrets } from './core/data/schema.js';
import { credentialHash } from '../test/fixtures/conversation-body.js';
import type { Viewer } from './policy.js';
import { change } from './pieces/changes/change.fixture.js';
import type { Change } from './pieces/changes/model.js';

/** Every place a wake can be asked in: who reads it (of Otto and Olive, who run the household; Pam, on the project;
 * Hal and Alice, who have Art; and Art's own plain credential), whose account work there is on, and what step four
 * does when the place can no longer take the wake. */
const TABLE: string[][] = [
  ['Comms thread, private to a household owner', 'olive', 'olive', 're-homed'],
  ['Comms thread, private to a member who is no owner', 'alice', 'alice', 're-homed'],
  ['terminal session of a household owner', 'olive', 'olive', 're-homed'],
  ['terminal session of a member who is no owner', 'alice', 'alice', 're-homed'],
  ['bridge direct conversation with a member', 'alice', 'alice', 're-homed'],
  ['bridge direct conversation with nobody\'s label', 'alice hal olive', 'unknown', 'ended (would be agent:art)'],
  ['bridge group conversation', 'alice hal olive', 'unknown', 'ended (would be agent:art)'],
  ['bridge channel', 'alice art hal olive otto', 'unknown', 'ended (would be agent:art)'],
  ['bridge channel of a project', 'alice art hal olive otto pam', 'unknown', 'ended (would be agent:art)'],
  ['a lane\'s wake conversation', 'alice art hal olive otto', 'agent:art', 're-homed'],
  ['a member\'s lane', 'alice', 'alice', 're-homed'],
  ['hand-off for nobody', 'alice art hal olive otto pam', 'unknown', 'ended (would be agent:art)'],
  ['hand-off for a member', 'alice', 'alice', 're-homed'],
];
const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });

async function fixture(options: Parameters<typeof bodyFixture>[1] = {}) {
  const f = await bodyFixture(clean, options), now = () => new Date(f.clock.now()).toISOString();
  f.db.insert(agentModels).values({ agent: 'art', model: 'model', position: 0 }).run();
  f.db.insert(agentRunSettings).values({ agent: 'art', houseRepository: 'fixture', houseFile: 'HOUSE.md', houseBranch: 'next', nestedContainers: false, gpu: false }).run();
  f.db.insert(agentAccounts).values({ agent: 'art', service: 'github', login: 'art-bot' }).run();
  // loom reads acme/app for the pond project, which Alice and Art are in.
  f.db.insert(projectRepositories).values({ project: 'pond', repository: 'acme/app' }).run();
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
  const mail = (conversation?: string) => f.db.select().from(inbox).where(and(eq(inbox.toKind, 'agent'), eq(inbox.source, 'trigger'), eq(inbox.fromKind, 'schedule'), conversation ? eq(inbox.conversation, conversation) : undefined)).all();
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
    conversation: f.cv, askedByKind: 'member', askedBy: 'alice', note: `Wake Art at ${at}`, enabled: true, state: 'standing', project: 'pond', instructions: null });
  // The note is kept with the conversation, where only who reads the conversation reads it: nothing of it is on the
  // trigger, which household owners, the project and everybody who has the agent can read.
  expect(JSON.stringify(f.trigger(asked.body.value!.id))).not.toContain('migration');
  expect(f.db.select().from(inbox).where(eq(inbox.sourceId, `wake-note:${asked.body.value!.id}`)).all()).toMatchObject([{ conversation: f.cv, member: 'alice', state: 'resolved', words: 'I was halfway through the migration; run the tests next.' }]);
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
  const old = f.db.select().from(conversations).where(eq(conversations.id, f.cv)).get()!, w = widen(f);
  expect(w.readers(fresh.id)).toEqual(w.readers(f.cv)); expect(w.readers(fresh.id)).toEqual(['alice']);
  expect(workPrincipal('art', fresh)).toBe(workPrincipal('art', old)); expect(workPrincipal('art', fresh)).toBe('alice');
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
  expect(f.trigger(ids.review).note).toBe('Wake Art when the review of acme/app#3 changes');
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

it('reads GitHub only for a pull request in a repository the asker may read, and gives one refusal for every other cause', async () => {
  const pull = (repository: string, number: number, values: Partial<Change> = {}) => change({ id: `github:${repository}#${number}`, repo: `github:${repository}`, number, url: `https://github.com/${repository}/pull/${number}`, ...values });
  const reads: string[] = [];
  const f = await fixture({ changes: { read: async repository => { reads.push(repository);
    if (/secret\/repo/.test(repository)) throw new Error('no');
    return /else\/where/.test(repository) ? [pull('else/where', 8, { author: { login: 'stranger' } })] : [pull('acme/app', 5, { checks: running(['build']) })]; } } });
  // The poller's own first read is over before anything is asked.
  await new Promise(resolve => setImmediate(resolve)); f.db.delete(changes).run(); reads.length = 0;
  // loom reads else/where for a project neither Alice nor Art is in, and holds one of its pull requests.
  f.db.insert(projectRepositories).values({ project: 'other', repository: 'else/where' }).run();
  f.root.services.changes.put(pull('else/where', 9, { author: { login: 'stranger' } }));
  expect(f.db.select().from(changes).get()).toMatchObject({ id: 'github:else/where#9', project: 'other', agent: null });
  const refused = [];
  for (const what of ['github:secret/repo#1',     // a repository loom knows nothing of, which the sign-in cannot reach
    'github:nobody/knows#7',                     // one it could reach
    'github:else/where#8',                       // a pull request that exists, in a repository of a project the asker is not in
    'github:else/where#404',                     // one that does not exist there
    'github:else/where#9'])                      // one loom holds, which the asker does not read
    refused.push(await f.wake({ what, when: 'checks-finished' }));
  for (const answer of refused) expect(answer).toEqual({ status: 403, body: { ok: false, code: 'denied', message: PULL_REFUSAL } });
  // Not one of them caused a read, kept a row or set a trigger, and no repository came to count as read by it.
  expect(reads).toEqual([]);
  expect(f.db.select({ id: changes.id }).from(changes).all()).toEqual([{ id: 'github:else/where#9' }]);
  expect(f.db.select().from(triggers).all()).toEqual([]);
  expect(readsRepository(f.db, 'secret/repo')).toBe(false); expect(readsRepository(f.db, 'nobody/knows')).toBe(false);
  // A caller that is refused for any reason loom can see without the network causes no read either: a person, a
  // body in another conversation, and an agent whose waits are full.
  expect((await f.wake({ what: 'acme/app#5' }, bodyCredentials.member)).status).toBe(403);
  expect((await f.wake({ what: 'acme/app#5', conversation: 'somewhere-else' })).body).toMatchObject({ ok: false, code: 'denied' });
  for (let n = 0; n < WAKES_MAX; n++) f.db.insert(triggers).values({ id: `filler-${n}`, ownerKind: 'agent', owner: 'art', sourceKind: 'job', watches: 'job:none', lifespan: 'once', targetKind: 'inbox', target: 'wake',
    toKind: 'agent', to: 'art', note: 'Filler', enabled: true, state: 'standing', createdAt: f.now(), changedAt: f.now() }).run();
  expect((await f.wake({ what: 'acme/app#5' })).body).toMatchObject({ ok: false, code: 'conflict', message: wakesFull('art') });
  f.db.delete(triggers).run();
  expect(reads).toEqual([]);
  // In a repository loom reads for a project the asker is in, a pull request the cache does not hold yet (opened a
  // moment ago) is read once and tracked by the asking; and there the asker may be told how the read went.
  expect((await f.wake({ what: 'acme/app#6' })).body).toMatchObject({ ok: false, code: 'not-found', message: 'There is no pull request acme/app#6 that is open or was closed in the last week.' });
  expect(reads).toHaveLength(1); expect(f.db.select().from(triggers).all()).toEqual([]);
  const asked = await f.wake({ what: 'https://github.com/acme/app/pull/5', when: 'checks-finished' });
  expect(asked.body).toMatchObject({ ok: true });
  expect(reads).toHaveLength(2);
  expect(f.db.select().from(changes).where(eq(changes.id, 'github:acme/app#5')).get()).toMatchObject({ project: 'pond', checks: 'running' });
  expect(f.trigger(asked.body.value!.id)).toMatchObject({ watches: 'change:github:acme/app#5', enabled: true });
  // Held now: asking again reads nothing.
  expect((await f.wake({ what: 'acme/app#5', when: 'merged-or-closed' })).body).toMatchObject({ ok: true });
  expect(reads).toHaveLength(2);
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
  const asked = await f.wake({ what: 'in:1', note: 'Check the review.', session: 's' }, token);
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
  const again = (await f.post('terminal.session', { ...key, sessionId: 's2', action: 'open', model: null, cwd: '/work' }, token)).body.value as unknown as { conversation: string };
  const later = await f.wake({ what: 'in:1', conversation: again.conversation }, token);
  expect(later.status).toBe(200);
  expect((await f.post('terminal.session', { ...key, sessionId: 's2', action: 'end' }, token)).status).toBe(200);
  f.clock.advance(60_000);
  const second = f.mail().filter(item => item.conversation !== opened.conversation && item.conversation !== again.conversation && item.id !== moved[0].id);
  expect(second).toHaveLength(1);
  expect(second[0].words).toContain('the terminal session it was asked from has ended, and loom cannot start a terminal');
});

it('refuses a watch on what the asker may not read, and says only that the watch ended when it can no longer read it', async () => {
  const f = await fixture();
  // Bob's own conversation with another agent: its job is not Art's to watch.
  f.db.insert(conversations).values({ id: 'cv-bob', agent: 'mark', member: 'bob', venue: 'loom', place: 'th:bob', label: 'Bob', startedAt: f.now(), lastAt: f.now(), turnCount: 0 }).run();
  f.db.insert(jobs).values({ id: 'job-bob', agent: 'mark', member: 'bob', conversation: 'cv-bob', title: 'Private', state: 'running', brief: '', model: 'model', startedByKind: 'agent', startedBy: 'mark',
    houseRepository: 'fixture', houseFile: 'HOUSE.md', houseBranch: 'next', queuedAt: f.now() }).run();
  // A job it does not read and a job that is not there are told apart by nothing.
  const unread = await f.wake({ what: 'job:job-bob' });
  expect(unread).toEqual({ status: 403, body: { ok: false, code: 'denied', message: WATCH_REFUSAL } });
  expect(await f.wake({ what: 'job:job-nowhere' })).toEqual(unread);
  // Another conversation is not one this body is in.
  expect((await f.wake({ what: 'in:5', conversation: 'cv-bob' })).body).toMatchObject({ ok: false, code: 'denied' });
  // A person does not ask to be woken.
  expect((await f.wake({ what: 'in:5' }, bodyCredentials.member)).status).toBe(403);
  expect(f.db.select().from(triggers).all()).toEqual([]);
  // A pull request read through a project: the member the body works for is in it when it asks, and has left when it fires.
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
  expect((await f.wake({ what: 'in:5' })).body).toMatchObject({ ok: false, code: 'conflict', message: wakesFull('art') });
  f.db.delete(triggers).where(eq(triggers.note, 'Filler')).run();
  // Cancelled: nothing is said when it then happens.
  const cancelled = await f.wake({ what: 'acme/app#3', when: 'changed' });
  expect((await f.post('tempo.stop', { id: cancelled.body.value!.id })).status).toBe(200);
  f.put({ checks: passing });
  expect(f.mail()).toEqual([]);
  // A wait that is 14 days old ends, and says so. A time further off than that is refused.
  expect((await f.wake({ what: `in:${WAKE_TIME_MOST_MS / 60_000 + 1}` })).body).toMatchObject({ ok: false, code: 'invalid', message: 'A time to be woken at is at most 14 days less an hour away' });
  f.db.update(triggers).set({ askedAt: new Date(f.clock.now() - WAKE_MS - 1_000).toISOString() }).where(eq(triggers.id, first.body.value!.id)).run();
  expect(f.root.services.tempo.wakes.sweep()).toBe(true);
  expect(f.mail()).toHaveLength(1);
  expect(f.mail()[0].words).toContain('The watch ended: 14 days passed and it never happened that acme/app#3 is merged or closed. Now: checks: all passed; review: approved.');
  expect(f.trigger(first.body.value!.id)).toMatchObject({ enabled: false, state: 'stopped' });
  // Nothing left to end: the sweep writes nothing.
  expect(f.root.services.tempo.wakes.sweep()).toBe(false);
  // A wake is made only at its own door.
  expect((await f.post('tempo.set', { ownerKind: 'agent', owner: 'art', sourceKind: 'time', times: new Date(f.clock.now() + 60_000).toISOString(), lifespan: 'once', targetKind: 'inbox', target: 'wake', toKind: 'agent', to: 'art', note: 'Sneaky' })).body)
    .toMatchObject({ ok: false, message: 'A wake is asked for with tempo.wake' });
});

/** More of the household, for who reads what: Olive and Otto run it, Pam is on the pond project, Hal has Art too. */
function widen(f: Awaited<ReturnType<typeof fixture>>) {
  f.db.insert(members).values([{ id: 'olive', role: 'owner', joinedAt: f.now() }, { id: 'otto', role: 'owner', joinedAt: f.now() }, { id: 'pam', role: 'member', joinedAt: f.now() }, { id: 'hal', role: 'member', joinedAt: f.now() }]).run();
  f.db.insert(memberAgents).values([{ member: 'olive', agent: 'art' }, { member: 'hal', agent: 'art' }]).run();
  f.db.insert(projectMembers).values({ project: 'pond', member: 'pam' }).run();
  f.db.insert(boxes).values({ id: 'box-olive', name: 'Olive', owner: 'olive', sameMachineAsLoom: false, hostsAny: false, reportOnly: false, alwaysOn: false, enrolledAt: f.now() }).run();
  /** A body of Art's working in a conversation, with its own credential. */
  const body = (job: string, conversation: string, labels: { member?: string; project?: string } = {}) => {
    const token = (job + '-').repeat(8).slice(0, 64);
    f.db.insert(jobs).values({ id: job, agent: 'art', box: 'box', ...labels, conversation, title: 'Body', state: 'running', brief: '', model: 'model', startedByKind: 'agent', startedBy: 'art',
      houseRepository: 'fixture', houseFile: 'HOUSE.md', houseBranch: 'next', queuedAt: f.now(), claimedAt: f.now(), heardAt: f.now() }).run();
    f.db.insert(tokens).values({ fingerprint: credentialHash(token), label: job, kind: 'agent', agent: 'art', job, createdAt: f.now() }).run();
    return { token, end: () => { f.root.writes.run(() => f.db.update(jobs).set({ state: 'done', endedAt: f.now() }).where(eq(jobs.id, job)).run()); } };
  };
  /** Everybody who must not come to read more: a second household owner, somebody on the project, another member
   * who has the agent, the agent's own plain credential, and the people the old conversation is for. */
  const viewers: Record<string, Viewer> = { otto: { kind: 'member', id: 'otto' }, pam: { kind: 'member', id: 'pam' }, hal: { kind: 'member', id: 'hal' }, alice: { kind: 'member', id: 'alice' },
    olive: { kind: 'member', id: 'olive' }, art: { kind: 'agent', id: 'art' } };
  const readers = (conversation: string) => Object.keys(viewers).filter(name => canReadSharedConversation(f.db, viewers[name], conversation)).sort();
  return { body, readers };
}

it('starts the new conversation for an owner\'s archived private thread no wider than the thread was', async () => {
  const f = await fixture(), w = widen(f);
  const thread = f.root.services.comms!.threads.open({ member: 'olive', agent: 'art', project: 'pond', title: 'Olive, privately' });
  const body = w.body('job-olive', thread.conversation, { member: 'olive', project: 'pond' });
  expect(w.readers(thread.conversation)).toEqual(['olive']);
  const asked = await f.wake({ what: 'in:1', note: 'What Olive told me in confidence.' }, body.token);
  expect(asked.body).toMatchObject({ ok: true });
  body.end();
  f.root.writes.run(() => f.db.update(threads).set({ archivedAt: f.now() }).where(eq(threads.id, thread.id)).run());
  f.clock.advance(60_000);
  const sent = f.mail().filter(item => item.conversation !== thread.conversation);
  expect(sent).toHaveLength(1);
  expect(sent[0].words).toContain('"What Olive told me in confidence."');
  const fresh = f.db.select().from(conversations).where(eq(conversations.id, sent[0].conversation!)).get()!;
  // A household owner's private conversation stays that owner's: the member label is kept, owner or not.
  expect(fresh).toMatchObject({ venue: 'wake', member: 'olive', project: 'pond', direct: false });
  expect(w.readers(fresh.id)).toEqual(w.readers(thread.conversation));
  // And the mail in it is read as the conversation is.
  expect(sent[0]).toMatchObject({ member: 'olive', project: 'pond' });
  f.clock.advance(10_000);
  expect(f.db.select().from(jobs).where(eq(jobs.conversation, fresh.id)).all()).toMatchObject([{ state: 'queued', member: 'olive' }]);
});

it('starts the new conversation for an owner\'s ended terminal session no wider than the session was', async () => {
  const f = await fixture(), w = widen(f);
  const { token } = f.root.services.signin.issue({ kind: 'agent', agent: 'art', label: 'Terminal', terminalMachine: 'box-olive' }, 'olive');
  const key = { machine: 'box-olive', sessionId: 's', harness: 'claude' };
  const opened = (await f.post('terminal.session', { ...key, action: 'open', model: null, cwd: '/work' }, token)).body.value as unknown as { conversation: string };
  expect(w.readers(opened.conversation)).toEqual(['olive']);
  expect((await f.wake({ what: 'in:1', note: 'Olive\'s branch.', session: 's' }, token)).body).toMatchObject({ ok: true });
  // The session goes silent and is never heard from again: the wake waits out the silence, then moves.
  f.clock.advance(60_000 + terminalSilenceMs + 60_000);
  const moved = f.mail().filter(item => item.conversation !== opened.conversation);
  expect(moved).toHaveLength(1);
  expect(moved[0].words).toContain('"Olive\'s branch."');
  expect(f.db.select().from(conversations).where(eq(conversations.id, moved[0].conversation!)).get()).toMatchObject({ venue: 'wake', member: 'olive', direct: false });
  expect(w.readers(moved[0].conversation!)).toEqual(['olive']);
});

it('ends a wake asked in a shared place with no member when the place is closed: no job starts anywhere on another account', async () => {
  const f = await fixture(), w = widen(f);
  const places = { 'cv-channel': { place: JSON.stringify(['guild', 'C1', null, null]), direct: false, project: 'pond' }, 'cv-group': { place: JSON.stringify(['guild', 'G1', null, ['group']]), direct: true, project: null } };
  for (const [id, labels] of Object.entries(places)) {
    f.db.insert(conversations).values({ id, agent: 'art', venue: 'discord', label: id, ...labels, startedAt: f.now(), lastAt: f.now(), turnCount: 0 }).run();
    // Alice has Art and is no household owner. In the shared place her word starts the body's job.
    const body = w.body(`job-${id}`, id, labels.project ? { project: labels.project } : {});
    f.db.insert(inbox).values({ id: `in-${id}`, toKind: 'agent', to: 'art', agent: 'art', conversation: id, seq: 1, source: 'discord', fromKind: 'person', fromId: 'alice', words: 'run it later', at: f.now(), changedAt: f.now(), state: 'taken', job: `job-${id}`, project: labels.project }).run();
    const asked = await f.wake({ what: 'in:1', note: 'Then merge the release branch.' }, body.token);
    expect(asked.body, id).toMatchObject({ ok: true });
    expect(f.trigger(asked.body.value!.id)).toMatchObject({ conversation: id, askedByKind: 'member', askedBy: 'alice' });
    // Work in this place is nobody's account: no standing rule answers its cards.
    const old = f.db.select().from(conversations).where(eq(conversations.id, id)).get()!;
    expect(workPrincipal('art', old)).toBe('unknown');
    body.end();
    // Its bridge connection is gone, so nothing can be posted there when the time comes.
    f.clock.advance(60_000);
    expect(f.trigger(asked.body.value!.id), id).toMatchObject({ enabled: false, state: 'stopped' });
    expect(f.db.select().from(triggerLog).where(and(eq(triggerLog.trigger, asked.body.value!.id), eq(triggerLog.event, 'undelivered'))).all()).toMatchObject([{ note: 'the place it was asked in is closed, and work started anywhere else would not be on the same account' }]);
    // All that is said is the bare line, to Alice alone, in a conversation whose work is hers: never the agent's own.
    const said = f.mail().filter(item => f.db.select().from(inboxRefs).where(and(eq(inboxRefs.item, item.id), eq(inboxRefs.ref, asked.body.value!.id))).get());
    expect(said.map(item => item.words), id).toEqual([WAIT_ENDED_BARE]);
    const home = f.db.select().from(conversations).where(eq(conversations.id, said[0].conversation!)).get()!;
    expect(home).toMatchObject({ venue: 'wake', member: 'alice' });
    expect(workPrincipal('art', home)).toBe('alice'); expect(w.readers(home.id)).toEqual(['alice']);
  }
  // Nowhere is there a conversation of the agent's own account made by a wake, nor the note outside where it was written.
  expect(f.db.select().from(conversations).where(eq(conversations.venue, 'wake')).all().filter(cv => cv.member === null)).toEqual([]);
  expect(f.db.select().from(inbox).all().filter(item => item.words?.includes('merge the release') && !Object.keys(places).includes(item.conversation ?? ''))).toEqual([]);
});

it('re-homes a direct bridge conversation that is one member\'s to a place the same people read, on the same account', async () => {
  const f = await fixture(), w = widen(f);
  f.db.insert(conversations).values({ id: 'cv-dm', agent: 'art', venue: 'discord', place: JSON.stringify(['guild', 'D1', null, 'alice']), label: 'Alice, directly', direct: true, member: 'alice', startedAt: f.now(), lastAt: f.now(), turnCount: 0 }).run();
  const body = w.body('job-dm', 'cv-dm', { member: 'alice' });
  expect((await f.wake({ what: 'in:1', note: 'Said to Alice alone.' }, body.token)).body).toMatchObject({ ok: true });
  body.end();
  f.clock.advance(60_000);
  const sent = f.mail().filter(item => item.conversation !== 'cv-dm');
  expect(sent).toHaveLength(1);
  expect(sent[0].words).toContain('"Said to Alice alone."');
  const old = f.db.select().from(conversations).where(eq(conversations.id, 'cv-dm')).get()!, fresh = f.db.select().from(conversations).where(eq(conversations.id, sent[0].conversation!)).get()!;
  expect(fresh).toMatchObject({ venue: 'wake', member: 'alice', direct: true });
  expect(w.readers(fresh.id)).toEqual(w.readers('cv-dm')); expect(w.readers(fresh.id)).toEqual(['alice']);
  expect(workPrincipal('art', fresh)).toBe(workPrincipal('art', old));
});

it('re-homes a wake only where the same people read the new place and its work is on the same account: every place a wake can be asked in', async () => {
  const f = await fixture(), w = widen(f);
  type Place = { venue: typeof conversations.$inferInsert.venue; member: string | null; direct: boolean; project: string | null };
  const places: [string, Place][] = [
    ['Comms thread, private to a household owner', { venue: 'loom', member: 'olive', direct: false, project: 'pond' }],
    ['Comms thread, private to a member who is no owner', { venue: 'loom', member: 'alice', direct: false, project: 'pond' }],
    ['terminal session of a household owner', { venue: 'terminal', member: 'olive', direct: false, project: null }],
    ['terminal session of a member who is no owner', { venue: 'terminal', member: 'alice', direct: false, project: null }],
    ['bridge direct conversation with a member', { venue: 'discord', member: 'alice', direct: true, project: null }],
    ['bridge direct conversation with nobody\'s label', { venue: 'discord', member: null, direct: true, project: null }],
    ['bridge group conversation', { venue: 'slack', member: null, direct: true, project: null }],
    ['bridge channel', { venue: 'discord', member: null, direct: false, project: null }],
    ['bridge channel of a project', { venue: 'slack', member: null, direct: false, project: 'pond' }],
    ['a lane\'s wake conversation', { venue: 'wake', member: null, direct: false, project: null }],
    ['a member\'s lane', { venue: 'wake', member: 'alice', direct: false, project: null }],
    ['hand-off for nobody', { venue: 'handoff', member: null, direct: false, project: 'pond' }],
    ['hand-off for a member', { venue: 'handoff', member: 'alice', direct: false, project: 'pond' }],
  ];
  const table = places.map(([name, place], n) => {
    const at = f.now(), old = `old-${n}`, fresh = `new-${n}`;
    f.db.insert(conversations).values({ id: old, agent: 'art', place: old, label: name, ...place, startedAt: at, lastAt: at, turnCount: 0 }).run();
    const answer = rehome('art', f.db.select().from(conversations).where(eq(conversations.id, old)).get()!);
    // What step four would open: the wake's own conversation with the labels the rule answers, or with the old labels to show what refusing prevents.
    const labels = 'labels' in answer ? answer.labels : { member: place.member, direct: place.direct, project: place.project };
    f.db.insert(conversations).values({ id: fresh, agent: 'art', venue: 'wake', place: fresh, label: name, ...labels, startedAt: at, lastAt: at, turnCount: 0 }).run();
    const row = (id: string) => f.db.select().from(conversations).where(eq(conversations.id, id)).get()!;
    return { name, outcome: 'labels' in answer ? 're-homed' : 'ended', readers: w.readers(old).join(' '), newReaders: w.readers(fresh).join(' '), principal: workPrincipal('art', row(old)), newPrincipal: workPrincipal('art', row(fresh)) };
  });
  // Re-homed only where both are the same; and every place that is ended is one where the account would have changed.
  for (const row of table) {
    expect(row.newReaders, row.name).toBe(row.readers);
    expect(row.outcome, row.name).toBe(row.principal === row.newPrincipal ? 're-homed' : 'ended');
  }
  expect(table.map(row => [row.name, row.readers, row.principal, row.outcome === 'ended' ? `ended (would be ${row.newPrincipal})` : 're-homed'])).toEqual(TABLE);
});
it('says one bare line, or nothing, when nowhere as private can be made, and tells the agent\'s people nothing of the wake', async () => {
  const f = await fixture(), w = widen(f);
  // Asked at Alice's terminal, as the agent's own work. Before it fires the session ends and Alice no longer has Art.
  const { token } = f.root.services.signin.issue({ kind: 'agent', agent: 'art', label: 'Terminal', terminalMachine: 'box' }, 'alice');
  const key = { machine: 'box', sessionId: 's', harness: 'claude' };
  const opened = (await f.post('terminal.session', { ...key, action: 'open', model: null, cwd: '/work' }, token)).body.value as unknown as { conversation: string };
  const asked = await f.wake({ what: 'in:1', note: 'Alice\'s secret plan.', conversation: opened.conversation }, token);
  expect(asked.body).toMatchObject({ ok: true });
  expect((await f.post('terminal.session', { ...key, action: 'end' }, token)).status).toBe(200);
  f.root.writes.run(() => { f.db.delete(memberAgents).where(eq(memberAgents.member, 'alice')).run(); f.db.delete(memberAgents).where(eq(memberAgents.member, 'hal')).run(); });
  f.clock.advance(60_000);
  // Alice's private conversation cannot be made again. Olive is now the one member who has Art, and is told one bare line.
  const said = f.mail();
  expect(said).toHaveLength(1);
  expect(said[0].words).toBe(WAIT_ENDED_BARE);
  expect(f.db.select().from(conversations).where(eq(conversations.id, said[0].conversation!)).get()).toMatchObject({ venue: 'wake', member: 'olive', label: 'A wait ended' });
  expect(w.readers(said[0].conversation!)).toEqual(['olive']);
  const everything = JSON.stringify([f.db.select().from(inbox).where(eq(inbox.conversation, said[0].conversation!)).all(), f.db.select().from(inbox).where(eq(inbox.source, 'notice')).all()]);
  expect(everything).not.toContain('secret plan'); expect(everything).not.toContain(opened.conversation);
  expect(f.trigger(asked.body.value!.id)).toMatchObject({ enabled: false, state: 'stopped' });
  expect(f.db.select().from(triggerLog).where(and(eq(triggerLog.trigger, asked.body.value!.id), eq(triggerLog.event, 'undelivered'))).all()).toMatchObject([{ note: 'the member alice, whose conversation it was, no longer has art or is not in its project' }]);
});

it('wakes a credential only where it is: a body in its conversation, a terminal in its own live session, any other in none', async () => {
  const f = await fixture(), w = widen(f);
  f.db.insert(conversations).values([{ id: 'cv-channel', agent: 'art', venue: 'discord', place: JSON.stringify(['guild', 'C1', null, null]), label: 'Discord channel #pond', startedAt: f.now(), lastAt: f.now(), turnCount: 0 },
    { id: 'cv-lane', agent: 'art', venue: 'wake', place: 'tr-night', label: 'Plan the night', startedAt: f.now(), lastAt: f.now(), turnCount: 0 }]).run();
  const { token } = f.root.services.signin.issue({ kind: 'agent', agent: 'art', label: 'Terminal', terminalMachine: 'box' }, 'alice');
  const olives = f.root.services.signin.issue({ kind: 'agent', agent: 'art', label: 'Olive terminal', terminalMachine: 'box-olive' }, 'olive').token;
  const open = async (bearer: string, machine: string, sessionId: string) => (await f.post('terminal.session', { machine, sessionId, harness: 'claude', action: 'open', model: null, cwd: '/work' }, bearer)).body.value as unknown as { conversation: string };
  const mine = await open(token, 'box', 's1'), ended = await open(token, 'box', 's2'), hers = await open(olives, 'box-olive', 's9');
  expect((await f.post('terminal.session', { machine: 'box', sessionId: 's2', harness: 'claude', action: 'end' }, token)).status).toBe(200);
  const elsewhere = { 'her Comms thread': f.cv, 'a bridge channel': 'cv-channel', 'a lane\'s wake conversation': 'cv-lane', 'a session that has ended': ended.conversation, 'another member\'s session': hers.conversation, 'nowhere': 'cv-none' };
  // A terminal credential: it says which session it is, and only a live session of its own machine, member and agent will do.
  expect((await f.wake({ what: 'in:5' }, token)).body).toEqual({ ok: false, code: 'invalid', message: SESSION_NEEDED });
  for (const [where, conversation] of Object.entries(elsewhere))
    expect((await f.wake({ what: 'in:5', note: 'x'.repeat(2_000), conversation }, token)).body, where).toEqual({ ok: false, code: 'denied', message: SESSION_REFUSAL });
  for (const session of ['s2', 's9', 'nope']) expect((await f.wake({ what: 'in:5', session }, token)).body, session).toEqual({ ok: false, code: 'denied', message: SESSION_REFUSAL });
  expect((await f.wake({ what: 'in:5', session: 's1', conversation: hers.conversation }, token)).body).toMatchObject({ ok: false, message: SESSION_REFUSAL });
  // A plain credential of the agent is in no conversation and names none.
  for (const [where, conversation] of Object.entries({ ...elsewhere, 'a live terminal session': mine.conversation }))
    expect((await f.wake({ what: 'in:5', conversation }, bodyCredentials.agent)).body, where).toEqual({ ok: false, code: 'denied', message: NO_CONVERSATION_REFUSAL });
  expect((await f.wake({ what: 'in:5', session: 's1' }, bodyCredentials.agent)).body).toMatchObject({ ok: false, message: NO_CONVERSATION_REFUSAL });
  // A body: its own conversation and no other.
  for (const [where, conversation] of Object.entries({ ...elsewhere, 'a live terminal session': mine.conversation }).filter(([, id]) => id !== f.cv))
    expect((await f.wake({ what: 'in:5', conversation })).body, where).toMatchObject({ ok: false, code: 'denied' });
  expect((await f.wake({ what: 'in:5', session: 's1' })).body).toMatchObject({ ok: false, code: 'denied' });
  expect(f.db.select().from(triggers).all()).toEqual([]);
  // Allowed: each in its own place.
  expect(f.trigger((await f.wake({ what: 'in:5', session: 's1' }, token)).body.value!.id).conversation).toBe(mine.conversation);
  expect(f.trigger((await f.wake({ what: 'in:5', conversation: mine.conversation }, token)).body.value!.id).conversation).toBe(mine.conversation);
  expect(f.trigger((await f.wake({ what: 'in:5', conversation: f.cv })).body.value!.id).conversation).toBe(f.cv);
  // Outside any conversation with several owners there is nobody's private conversation to go to: refused. With one, it is theirs.
  expect((await f.wake({ what: 'in:5' }, bodyCredentials.agent)).body).toMatchObject({ ok: false, code: 'invalid', message: expect.stringContaining('art has more than one owner') });
  f.root.writes.run(() => { for (const member of ['olive', 'hal']) f.db.delete(memberAgents).where(eq(memberAgents.member, member)).run(); });
  const alone = await f.wake({ what: 'in:1', note: 'Only for Alice.' }, bodyCredentials.agent);
  expect(alone.body.value!.says).toContain('in a new conversation, private to alice');
  expect(f.trigger(alone.body.value!.id)).toMatchObject({ conversation: null, member: 'alice', instructions: null });
  f.clock.advance(60_000);
  const sent = f.mail().filter(item => item.words?.includes('Only for Alice.'));
  expect(sent).toHaveLength(1);
  expect(f.db.select().from(conversations).where(eq(conversations.id, sent[0].conversation!)).get()).toMatchObject({ venue: 'wake', member: 'alice' });
  expect(w.readers(sent[0].conversation!)).toEqual(['alice']);
});

it('holds the bound on waits when a stopped one is started, refuses to change a wake, and ends an old one whatever its state', async () => {
  const f = await fixture();
  const first = await f.wake({ what: 'in:60', note: 'A note.' });
  expect((await f.post('tempo.stop', { id: first.body.value!.id })).status).toBe(200);
  for (let n = 0; n < WAKES_MAX; n++) f.db.insert(triggers).values({ id: `filler-${n}`, ownerKind: 'agent', owner: 'art', sourceKind: 'job', watches: 'job:none', lifespan: 'once', targetKind: 'inbox', target: 'wake',
    toKind: 'agent', to: 'art', note: 'Filler', enabled: true, state: n % 2 ? 'held' : 'standing', createdAt: f.now(), changedAt: f.now() }).run();
  // Fifty stand (a held one stands too): the stopped one cannot be turned back on as a fifty-first.
  expect((await f.post('tempo.start', { id: first.body.value!.id }, bodyCredentials.member)).body).toMatchObject({ ok: false, message: wakesFull('art') });
  expect(f.trigger(first.body.value!.id).enabled).toBe(false);
  f.db.delete(triggers).where(eq(triggers.id, 'filler-0')).run();
  expect((await f.post('tempo.start', { id: first.body.value!.id }, bodyCredentials.member)).status).toBe(200);
  expect(f.db.select().from(triggers).where(eq(triggers.enabled, true)).all()).toHaveLength(WAKES_MAX);
  // Nothing about a wake is changed after it is asked: not its time, not its title, not its words.
  for (const change of [{ times: new Date(f.clock.now() + 400 * 86_400_000).toISOString() }, { note: 'x'.repeat(50_000) }, { instructions: 'y'.repeat(50_000) }])
    for (const bearer of [bodyCredentials.member, bodyCredentials.body])
      expect((await f.post('tempo.edit', { id: first.body.value!.id, ...change }, bearer)).body).toMatchObject({ ok: false, message: WAKE_EDIT_REFUSAL });
  expect(f.trigger(first.body.value!.id)).toMatchObject({ note: expect.stringMatching(/^Wake Art at /), instructions: null });
  // Fourteen days after it was asked a wait ends, held or not, a time or not: none is left enabled, and the sweep then has nothing to do.
  const old = new Date(f.clock.now() - WAKE_MS - 1_000).toISOString();
  f.db.delete(triggers).where(eq(triggers.note, 'Filler')).run();
  f.db.update(triggers).set({ askedAt: old, state: 'held' }).where(eq(triggers.id, first.body.value!.id)).run();
  f.db.insert(triggers).values({ id: 'old-held', ownerKind: 'agent', owner: 'art', sourceKind: 'job', watches: 'job:none', lifespan: 'once', targetKind: 'inbox', target: 'wake', toKind: 'agent', to: 'art', note: 'Old',
    enabled: true, state: 'held', createdAt: old, changedAt: old }).run();
  expect(f.root.services.tempo.wakes.sweep()).toBe(true);
  expect(f.db.select({ id: triggers.id, enabled: triggers.enabled, state: triggers.state }).from(triggers).all().sort((a, b) => a.id.localeCompare(b.id))).toEqual([
    { id: 'old-held', enabled: false, state: 'stopped' }, { id: first.body.value!.id, enabled: false, state: 'stopped' }]);
  expect(f.db.select().from(triggerLog).where(eq(triggerLog.event, 'expired')).all()).toHaveLength(2);
  // Neither ended silently: the held time wake says so where it was asked, with its note.
  const ended = f.mail(f.cv).filter(item => item.words?.includes(TIME_EXPIRED));
  expect(ended).toHaveLength(1); expect(ended[0].words).toContain('"A note."');
  expect(f.root.services.tempo.wakes.sweep()).toBe(false);
  // A wait past its life is not turned back on, by the same function that holds the bound.
  expect((await f.post('tempo.start', { id: first.body.value!.id }, bodyCredentials.member)).body).toMatchObject({ ok: false, message: WAKE_TOO_OLD });
  expect(f.trigger(first.body.value!.id).enabled).toBe(false);
  // Only the wake door writes a wake's target, in any spelling.
  for (const target of ['wake', 'Wake:x', 'WAKE', 'wake:bogus', ' wake:review'])
    expect((await f.post('tempo.set', { ownerKind: 'agent', owner: 'art', sourceKind: 'time', times: new Date(f.clock.now() + 60_000).toISOString(), lifespan: 'once', targetKind: 'inbox', target, toKind: 'agent', to: 'art', note: 'Sneaky' }, bodyCredentials.member)).body, target)
      .toMatchObject({ ok: false, message: 'A wake is asked for with tempo.wake' });
});

it('hands a terminal session\'s wakes only to a report the session took as its current instance\'s', async () => {
  const f = await fixture();
  const { token } = f.root.services.signin.issue({ kind: 'agent', agent: 'art', label: 'Terminal', terminalMachine: 'box' }, 'alice');
  const key = { machine: 'box', sessionId: 's', harness: 'claude' };
  const opened = (await f.post('terminal.session', { ...key, instanceId: 'one', action: 'open', model: null, cwd: '/work' }, token)).body.value as unknown as { conversation: string };
  expect((await f.post('terminal.session', { ...key, instanceId: 'one', action: 'turn', role: 'member', eventId: 'm1', words: 'go', wakes: true }, token)).status).toBe(200);
  expect((await f.wake({ what: 'in:1', session: 's' }, token)).body).toMatchObject({ ok: true });
  // The session is resumed as a new instance; the old process is still reporting.
  expect((await f.post('terminal.session', { ...key, instanceId: 'two', action: 'open', model: null, cwd: '/work' }, token)).status).toBe(200);
  f.clock.advance(60_000);
  const waiting = () => f.mail(opened.conversation).map(item => item.state);
  expect(waiting()).toEqual(['waiting']);
  // A report from the superseded instance, a turn the session has already recorded, and a usage report: each is
  // answered, handed nothing, and closes nothing.
  for (const report of [{ ...key, instanceId: 'one', action: 'heartbeat', wakes: true }, { ...key, instanceId: 'one', action: 'turn', role: 'agent', eventId: 'a1', words: 'late', wakes: true },
    { ...key, instanceId: 'two', action: 'turn', role: 'member', eventId: 'm1', words: 'go', wakes: true }]) {
    const answer = await f.post('terminal.session', report, token);
    expect(answer.status, JSON.stringify(report)).toBe(200); expect(answer.body.value).not.toHaveProperty('wakes'); expect(waiting()).toEqual(['waiting']);
  }
  const current = await f.post('terminal.session', { ...key, instanceId: 'two', action: 'heartbeat', wakes: true }, token);
  expect((current.body.value as unknown as { wakes: unknown[] }).wakes).toHaveLength(1);
  expect(waiting()).toEqual(['done']);
});

it('says a time wake fired by hand was fired by hand', async () => {
  const f = await fixture();
  const asked = await f.wake({ what: 'in:60' });
  expect((await f.post('tempo.runNow', { id: asked.body.value!.id }, bodyCredentials.member)).status).toBe(200);
  expect(f.mail()).toHaveLength(1);
  expect(f.mail()[0].words).toContain('This wait was fired by hand before it is ');
  expect(f.mail()[0].words).not.toContain('the time you asked to be woken at');
});


it('never loses a time wake at the edge of a wait\'s life, whichever of the sweep and the engine looks first', async () => {
  // The furthest time that may be asked is an hour inside the life of a wait.
  const most = WAKE_TIME_MOST_MS / 60_000;
  for (const sweepFirst of [true, false]) {
    const f = await fixture();
    expect((await f.wake({ what: `in:${most + 1}` })).body).toMatchObject({ ok: false, code: 'invalid' });
    expect((await f.wake({ what: `at:${new Date(f.clock.now() + WAKE_MS).toISOString()}` })).body).toMatchObject({ ok: false, code: 'invalid' });
    const asked = await f.wake({ what: `in:${most}`, note: 'At the edge.' });
    expect(asked.body).toMatchObject({ ok: true });
    const id = asked.body.value!.id, due = f.trigger(id).nextDueAt!;
    expect(Date.parse(due) - f.clock.now()).toBe(WAKE_TIME_MOST_MS);
    if (sweepFirst) {
      // The worst case, made by hand: the wake is as old as a wait may be and due this instant, and the sweep meets
      // it before the engine's own timer has run.
      f.db.update(triggers).set({ askedAt: new Date(f.clock.now() - WAKE_MS).toISOString(), nextDueAt: f.now(), times: f.now() }).where(eq(triggers.id, id)).run();
      expect(f.root.services.tempo.wakes.sweep()).toBe(true);
    } else {
      f.db.update(triggers).set({ askedAt: new Date(f.clock.now() - WAKE_MS + 1_000).toISOString(), nextDueAt: new Date(f.clock.now() + 1_000).toISOString(), times: new Date(f.clock.now() + 1_000).toISOString() }).where(eq(triggers.id, id)).run();
      f.root.services.tempo.triggers.tick();
      f.beat(); f.clock.advance(1_000);
      expect(f.root.services.tempo.wakes.sweep()).toBe(false);
    }
    // Either way it fired as itself, once, and says the time came: it was not stopped unsaid.
    const sent = f.mail();
    expect(sent.map(item => item.words!.includes('the time you asked to be woken at')), String(sweepFirst)).toEqual([true]);
    expect(sent[0].words).toContain('"At the edge."');
    expect(f.trigger(id)).toMatchObject({ enabled: false, state: 'fired' });
    expect(f.db.select().from(triggerLog).where(and(eq(triggerLog.trigger, id), eq(triggerLog.event, 'expired'))).all()).toEqual([]);
    expect(f.root.services.tempo.wakes.sweep()).toBe(false); expect(f.mail()).toHaveLength(1);
  }
});

it('wakes when a question or a secret request is answered, from real rows', async () => {
  const f = await fixture();
  // A question put to the agent itself, in the conversation it works in, and a request it made for a secret.
  f.db.insert(inbox).values({ id: 'in-q1', toKind: 'agent', to: 'art', agent: 'art', member: 'alice', project: 'pond', conversation: f.cv, seq: 900, source: 'thread', fromKind: 'person', fromId: 'alice',
    words: 'Ship it?', answers: 'yes-no', at: f.now(), changedAt: f.now(), state: 'waiting' }).run();
  f.db.insert(secrets).values({ name: 'deploy-key', description: 'The deploy key', changedAt: f.now(), changedBy: 'alice' }).run();
  f.db.insert(secretRequests).values({ id: 'sr-1', secret: 'deploy-key', agent: 'art', why: 'To deploy', state: 'pending', minutes: 30, always: false, askedAt: f.now() }).run();
  const question = await f.wake({ what: 'question:in-q1' }), secret = await f.wake({ what: 'secret:sr-1', note: 'Then deploy.' });
  expect([question.body, secret.body]).toMatchObject([{ ok: true }, { ok: true }]);
  expect(f.trigger(question.body.value!.id)).toMatchObject({ sourceKind: 'answer', watches: 'question:in-q1', target: 'wake', note: 'Wake Art when question in-q1 is answered' });
  expect(f.trigger(secret.body.value!.id)).toMatchObject({ sourceKind: 'answer', watches: 'secret-request:sr-1', note: 'Wake Art when secret request sr-1 is answered' });
  f.clock.advance(30_000); f.beat();
  expect(f.mail()).toEqual([]);
  f.root.writes.run(() => f.db.update(inbox).set({ state: 'answered', answer: 'yes', answeredBy: 'alice', answeredAt: f.now(), changedAt: f.now() }).where(eq(inbox.id, 'in-q1')).run());
  const said = (id: string) => f.mail().filter(item => f.db.select().from(inboxRefs).where(and(eq(inboxRefs.item, item.id), eq(inboxRefs.ref, id))).get()).map(item => item.words!);
  expect(said(question.body.value!.id)).toHaveLength(1);
  expect(said(question.body.value!.id)[0]).toContain('Alice answered: Yes.');
  expect(said(question.body.value!.id)[0]).toContain('See question in-q1');
  expect(said(secret.body.value!.id)).toEqual([]);
  f.root.writes.run(() => f.db.update(secretRequests).set({ state: 'denied', answeredBy: 'alice', answeredAt: f.now() }).where(eq(secretRequests.id, 'sr-1')).run());
  expect(said(secret.body.value!.id)).toHaveLength(1);
  expect(said(secret.body.value!.id)[0]).toContain('Alice answered the request for the secret "deploy-key": Deny.');
  expect(said(secret.body.value!.id)[0]).toContain('"Then deploy."');
  // Once each.
  f.root.writes.run(() => f.db.update(secretRequests).set({ state: 'revoked' }).where(eq(secretRequests.id, 'sr-1')).run());
  expect(f.mail()).toHaveLength(2);
  for (const asked of [question, secret]) expect(f.trigger(asked.body.value!.id)).toMatchObject({ enabled: false, state: 'fired' });
});
