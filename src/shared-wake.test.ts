import { afterEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { bodyCredentials as keys, bodyFixture, credentialHash } from '../test/fixtures/conversation-body.js';
import * as s from './core/data/schema.js';
import { WAKE_MS, WATCH_ENDED } from './core/tempo/wake.js';
import { change } from './pieces/changes/change.fixture.js';
import type { Change } from './pieces/changes/model.js';
import { holds, tableRules } from './policy.js';
import { sharedSharing } from './shared-sharing.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(options: Parameters<typeof bodyFixture>[1] = {}) {
  const f = await bodyFixture(cleanup, options);
  const now = () => new Date(f.clock.now()).toISOString();
  f.db.insert(s.projectRepositories).values({ project: 'pond', repository: 'acme/app' }).run();
  f.db.insert(s.agentModels).values({ agent: 'art', model: 'model', position: 0 }).run();
  f.db.insert(s.agentRunSettings).values({ agent: 'art', houseRepository: 'fixture', houseFile: 'HOUSE.md', houseBranch: 'next', nestedContainers: false, gpu: false }).run();
  f.db.update(s.jobs).set({ claimedAt: now(), heardAt: now() }).where(eq(s.jobs.id, 'job')).run();
  const cv = f.thread.conversation;
  let seq = 0;
  const post = async (name: string, input: unknown, token = keys.body, id = 'call-' + ++seq, cookie?: string) => {
    const result = await f.root.http.request('/api/' + name.replace('.', '/'), {
      method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie: 'loom_ui=' + cookie } : { authorization: 'Bearer ' + token }) },
      body: JSON.stringify({ input, id }),
    });
    return await result.json() as { ok: boolean; value?: unknown; message?: string };
  };
  const ask = async (input: unknown, token?: string, id?: string) => {
    const reply = await post('tempo.wake', input, token, id);
    expect(reply.ok, reply.message).toBe(true);
    return (reply.value as { id: string }).id;
  };
  const row = (id: string) => f.db.select().from(s.wakes).where(eq(s.wakes.id, id)).get()!;
  const mail = (id: string) => f.db.select().from(s.inbox).where(eq(s.inbox.sourceId, id)).all();
  const put = (value: Partial<Change> = {}) => f.root.services.changes.put(change(value));
  const query = async (query: string, token = keys.body) => {
    const response = await f.root.http.request('/graphql', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ query }) });
    return await response.json() as { data?: Record<string, unknown>; errors?: unknown[] };
  };
  const body = (member: string, n: number, venue: 'loom' | 'discord' = 'loom') => {
    f.db.insert(s.memberAgents).values({ member, agent: 'art' }).onConflictDoNothing().run();
    f.db.insert(s.projectMembers).values({ member, project: 'pond' }).onConflictDoNothing().run();
    const place = venue === 'discord' ? '["guild","channel",null]' : 'thread-' + n;
    const conversation = f.root.services.conversations.open({ agent: 'art', member, project: 'pond', venue, label: 'Other private work', place });
    const job = { ...f.db.select().from(s.jobs).where(eq(s.jobs.id, 'job')).get()!, id: 'body-' + n, member, conversation: conversation.id };
    f.db.insert(s.jobs).values(job).run();
    const token = credentialHash('body-' + n);
    f.db.insert(s.tokens).values({ kind: 'agent', fingerprint: credentialHash(token), label: 'Body ' + n, agent: 'art', job: job.id, createdAt: now() }).run();
    return { token, conversation };
  };
  return { ...f, now, cv, post, ask, row, mail, put, query, body };
}
const passed = { state: 'passing' as const, failing: [], running: [], total: 1 };
const running = { state: 'running' as const, failing: [], running: ['test'], total: 1 };
const failed = { state: 'failing' as const, failing: ['test'], running: [], total: 1 };
const head = (letter: string) => ({ ref: 'topic', id: letter.repeat(40) });

it('accepts only a runtime body and scopes replay, listing, cancelling and reads to its conversation', async () => {
  const f = await fixture(), other = f.body('bob', 2);
  const terminal = 't'.repeat(64), bob = 'p'.repeat(64);
  f.db.insert(s.tokens).values([
    { fingerprint: credentialHash(terminal), label: 'Terminal', kind: 'agent', agent: 'art', createdAt: f.now() },
    { fingerprint: credentialHash(bob), label: 'Bob', kind: 'owner', member: 'bob', createdAt: f.now() },
  ]).run();
  f.db.insert(s.terminalCredentials).values({ fingerprint: credentialHash(terminal), machine: 'box', member: 'alice', issuedBy: 'alice' }).run();
  const input = { what: 'in:1', note: 'Fictional self-note' };
  const denied = await f.post('tempo.wake', input, keys.agent);
  expect(denied).toMatchObject({ ok: false, message: 'Only a runtime body in its own conversation can use wakes.' });
  for (const token of [keys.member, terminal]) expect(await f.post('tempo.wake', input, token)).toEqual(denied);
  const first = await f.ask(input, keys.body, 'shared-id');
  expect(await f.ask(input, keys.body, 'shared-id')).toBe(first);
  expect(await f.post('tempo.waits', {}, other.token)).toMatchObject({ ok: true, value: [] });
  const second = await f.ask(input, other.token, 'shared-id');
  expect(second).not.toBe(first);
  expect(await f.post('tempo.waits', {})).toMatchObject({ ok: true, value: [{ id: first, note: input.note }] });
  const listing = '{ wakes { id state why } agentDoing(agent:"art"){ items {id kind} } triggers {id} triggerLog {seq} inboxItems {id} }';
  for (const token of [other.token, bob]) {
    const data = await f.query(listing, token);
    expect(data.errors).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain(first);
    expect(data.data).toMatchObject({ wakes: [{ id: second }], triggers: [], triggerLog: [], inboxItems: [] });
  }
  expect((await f.query(listing)).data?.wakes).toEqual([{ id: first, state: 'waiting', why: null }]);
  const parent = () => f.db.select().from(s.conversations).where(eq(s.conversations.id, f.cv)).get();
  expect(holds(tableRules.wakes, { kind: 'member', id: 'alice' }, f.row(first), sharedSharing(f.db), parent)).toBe(true);
  expect(holds(tableRules.wakes, { kind: 'member', id: 'bob' }, f.row(first), sharedSharing(f.db), parent)).toBe(false);
  expect((await f.query('{ wakes { note } }')).errors).toBeDefined();
  const cancel = (token: string, id: string, receipt: string) => f.post('tempo.wakeCancel', { id }, token, receipt);
  expect(await cancel(other.token, first, 'other-cancel')).toEqual(await cancel(other.token, 'missing', 'missing-cancel'));
  expect(await cancel(keys.body, first, 'cancel')).toMatchObject({ ok: true });
  expect(await cancel(other.token, first, 'cancel')).toMatchObject({ ok: false });
  expect(f.row(first)).toMatchObject({ state: 'ended', why: 'The watch was cancelled.' });
});

it('delivers due mail once on the original word and waits behind the body', async () => {
  const f = await fixture();
  const id = await f.ask({ what: 'in:1', note: 'Resume fixture work.' });
  const other = f.body('bob', 2);
  f.clock.advance(59_999);
  expect(f.mail(id)).toEqual([]);
  f.clock.advance(1);
  expect(f.row(id)).toMatchObject({ state: 'fired', onWord: { kind: 'member', id: 'alice' } });
  expect(f.mail(id)).toMatchObject([{ conversation: f.cv, job: null, onWordKind: 'member', onWord: 'alice', state: 'waiting' }]);
  expect(f.mail(id)[0].words).toContain('Resume fixture work.');
  const item = f.mail(id)[0].id;
  expect((await f.query(`{ inboxItem(id:"${item}"){id} }`, other.token)).data).toEqual({ inboxItem: null });
  expect(await f.post('runtime.finish', { job: 'job', exitCode: 0, logTail: '' }, keys.runner)).toMatchObject({ ok: true });
  f.clock.advance(10_000);
  const successor = f.db.select().from(s.jobs).where(eq(s.jobs.conversation, f.cv)).all().find(j => j.id !== 'job');
  expect(successor).toMatchObject({ member: 'alice', conversation: f.cv, state: 'queued' });
  expect(f.mail(id)[0].job).toBe(successor?.id);
  f.clock.advance(120_000);
  expect(f.mail(id)).toHaveLength(1);
});

it('fires on a real job ending, approval decision and conversation question answer', async () => {
  const f = await fixture();
  f.db.insert(s.approvals).values({ id: 'approval', kind: 'command', what: 'Fixture', why: 'Test', ask: 'Proceed?', ifYes: 'Yes', ifNo: 'No',
    agent: 'art', actingFor: 'alice', member: 'alice', project: 'pond', conversation: f.cv, askedFrom: f.cv, target: 'fixture',
    state: 'pending', minutes: 5, details: '', askedAt: f.now() }).run();
  expect((await f.call('digest', { summary: 'Fixture question', question: { to: 'alice', answers: 'yes-no', words: 'Continue?' } }, 'question')).status).toBe(200);
  const question = f.db.select().from(s.digests).get()!.inboxItem!;
  const jobWake = await f.ask({ what: 'job:job' }), approvalWake = await f.ask({ what: 'approval:approval' }), questionWake = await f.ask({ what: `question:${question}` });
  f.root.writes.run(() => f.root.services.approvals.deny('approval', 'alice'));
  expect(f.mail(approvalWake)[0]?.words).toContain('was denied');
  const answered = await f.post('inbox.answer', { item: question, answer: 'yes' }, keys.member, 'answer', keys.memberCookie);
  expect(answered.ok, answered.message).toBe(true);
  expect(f.mail(questionWake)[0]?.words).toContain('was answered');
  expect(await f.post('runtime.finish', { job: 'job', exitCode: 0, logTail: '' }, keys.runner)).toMatchObject({ ok: true });
  expect(f.mail(jobWake)[0]?.words).toContain('state done');
});

it('evaluates all pull request conditions and ignores an unchanged poll', async () => {
  const f = await fixture();
  const baseline = { checks: running, review: { state: 'required' as const, by: [] } };
  f.put(baseline);
  const a = await f.ask({ what: 'acme/app#3' });
  const b = await f.ask({ what: 'acme/app#3', when: 'checks-failed' });
  const c = await f.ask({ what: 'acme/app#3', when: 'review' });
  const d = await f.ask({ what: 'acme/app#3', when: 'merged-or-closed' });
  f.put(baseline);
  for (const id of [a, b, c, d]) expect(f.row(id)).toMatchObject({ state: 'waiting', reading: null });
  f.put({ ...baseline, checks: failed });
  expect(f.mail(a)[0]?.words).toContain('before: 1 still running');
  expect(f.mail(b)[0]?.words).toContain('A check failed');
  f.put({ checks: failed });
  expect(f.mail(c)[0]?.words).toContain('approved');
  f.put({ state: 'merged' });
  expect(f.mail(d)[0]?.words).toContain('was merged');
});

it('requires a new run for an already finished head and rejects an older head', async () => {
  const f = await fixture();
  const old = '2026-11-12T00:00:00Z', next = '2026-11-13T00:00:00Z';
  f.put({ checks: passed, updated: next, head: head('b') });
  const id = await f.ask({ what: 'acme/app#3', when: 'checks-finished' });
  f.put({ checks: passed, updated: next, head: head('b'), title: 'Renamed' });
  f.put({ checks: passed, updated: old, head: head('a') });
  f.put({ checks: { ...failed, running: ['test'], total: 2 }, updated: next, head: head('b') });
  expect(f.row(id).state).toBe('waiting');
  expect(f.mail(id)).toEqual([]);
  f.put({ checks: failed, updated: next, head: head('b') });
  expect(f.mail(id)[0]?.words).toContain('finished on bbbbbbb');
});

it('authorizes untracked repository reads up front and refuses a rename without storing the return', async () => {
  const read = vi.fn(async (_repo: string) => [change()]);
  const f = await fixture({ changes: { read } });
  const out = await f.post('tempo.wake', { what: 'elsewhere/app#3' });
  expect(out).toMatchObject({ ok: false, message: 'That is not something you can watch.' });
  expect(read).not.toHaveBeenCalled();
  f.db.insert(s.projectRepositories).values({ project: 'other', repository: 'github:acme/app' }).run();
  expect(await f.post('tempo.wake', { what: 'acme/app#3' })).toEqual(out);
  expect(read).not.toHaveBeenCalled();
  f.db.delete(s.projectRepositories).where(eq(s.projectRepositories.project, 'other')).run();
  const id = await f.ask({ what: 'acme/app#3' });
  expect(read).toHaveBeenCalledTimes(1);
  expect(f.db.select().from(s.changes).all()).toEqual([]);
  read.mockResolvedValueOnce([change({ id: 'github:renamed/app#3', repo: 'github:renamed/app' })]);
  expect(await f.post('tempo.wake', { what: 'acme/app#3' })).toEqual(out);
  expect(f.db.select().from(s.wakes).all().map(row => row.id)).toEqual([id]);
  f.put({ title: 'Changed after asking' });
  expect(f.mail(id)).toHaveLength(1);
});

it.each(['archive', 'agent access', 'project access', 'member removed', 'agent removed'] as const)('ends in place when %s prevents delivery', async why => {
  const f = await fixture();
  const id = await f.ask({ what: 'in:1', note: 'Never reach mail' });
  f.db.insert(s.members).values({ id: 'owner', role: 'owner', joinedAt: f.now() }).run();
  f.root.writes.run(() => {
    if (why === 'archive') f.root.services.comms!.threads.archive(f.thread.id, true);
    if (why === 'agent access') f.db.delete(s.memberAgents).where(eq(s.memberAgents.member, 'alice')).run();
    if (why === 'project access') f.db.delete(s.projectMembers).where(eq(s.projectMembers.member, 'alice')).run();
    if (why === 'agent removed') f.root.services.household.setRemoved('agent', 'art', true);
    if (why === 'member removed') f.root.services.household.setRemoved('member', 'alice', true);
  });
  f.clock.advance(60_000);
  expect(f.row(id)).toMatchObject({ state: 'ended', why: why === 'archive' ? 'The watch ended because its conversation closed.' : WATCH_ENDED });
  expect(f.mail(id)).toEqual([]);
  expect(f.db.select().from(s.conversations).all()).toHaveLength(1);
});

it('rolls back a source, firing and mail together and handles both expiry orders', async () => {
  const f = await fixture();
  f.put();
  const crash = await f.ask({ what: 'acme/app#3' });
  f.db.$client.exec(`create temp trigger wake_test_failure before insert on inbox when new.source_id = '${crash}' begin select raise(abort, 'simulated interruption'); end`);
  expect(() => f.put({ title: 'New PR title' })).toThrow('simulated interruption');
  expect(f.root.services.changes.get('github:acme/app#3').title).toBe('A change');
  expect(f.row(crash).state).toBe('waiting');
  f.db.$client.exec('drop trigger wake_test_failure');
  f.put({ title: 'New PR title' }); f.put({ title: 'New PR title' });
  expect(f.mail(crash)).toHaveLength(1);
  const eventFirst = await f.ask({ what: 'acme/app#3' }), sweepFirst = await f.ask({ what: 'acme/app#3' });
  const expired = new Date(f.clock.now() - WAKE_MS).toISOString();
  f.db.update(s.wakes).set({ askedAt: expired }).where(eq(s.wakes.id, eventFirst)).run();
  f.db.update(s.wakes).set({ key: 'github:acme/app#4', askedAt: expired }).where(eq(s.wakes.id, sweepFirst)).run();
  f.put({ title: 'Event before sweep' });
  f.clock.advance(30_000);
  f.put({ id: 'github:acme/app#4', number: 4, title: 'Event after sweep' });
  for (const id of [eventFirst, sweepFirst]) {
    expect(f.row(id)).toMatchObject({ state: 'ended', why: 'The watch ended after 14 days.' });
    expect(f.mail(id)).toEqual([]);
  }
});

it('holds due times while paused, then fires a live one and expires an old one', async () => {
  const f = await fixture();
  const alive = await f.ask({ what: 'in:1' }), old = await f.ask({ what: 'in:1' });
  f.root.services.tempo.triggers.pause('art');
  f.db.update(s.wakes).set({ askedAt: new Date(f.clock.now() - WAKE_MS + 30_000).toISOString() }).where(eq(s.wakes.id, old)).run();
  f.clock.advance(60_000);
  expect(f.row(alive).state).toBe('waiting');
  expect(f.row(old).state).toBe('ended');
  expect(await f.post('tempo.resume', { agent: 'art' }, keys.member, 'resume', keys.memberCookie)).toMatchObject({ ok: true });
  expect(f.mail(alive)).toHaveLength(1);
  expect(f.mail(old)).toEqual([]);
});

it('enforces both waiting caps and lets cancellation free a slot', async () => {
  const f = await fixture(), b = f.body('alice', 2), c = f.body('alice', 3);
  const ids = [];
  for (let i = 0; i < 20; i++) ids.push(await f.ask({ what: 'in:1' }));
  expect(await f.post('tempo.wake', { what: 'in:1' })).toMatchObject({ ok: false, message: 'Too many waiting wakes.' });
  for (let i = 0; i < 20; i++) await f.ask({ what: 'in:1' }, b.token);
  for (let i = 0; i < 10; i++) await f.ask({ what: 'in:1' }, c.token);
  expect(await f.post('tempo.wake', { what: 'in:1' }, c.token)).toMatchObject({ ok: false, message: 'Too many waiting wakes.' });
  expect(await f.post('tempo.wakeCancel', { id: ids[0] })).toMatchObject({ ok: true });
  await f.ask({ what: 'in:1' }, c.token);
});

it('ends a bridge wake when the place has closed before the due time', async () => {
  const f = await fixture(), bridge = f.body('alice', 2, 'discord');
  f.db.insert(s.secrets).values({ name: 'FIXTURE', description: '', changedAt: f.now(), changedBy: 'alice' }).run();
  f.db.insert(s.bridgeConnections).values({ id: 'bridge', agent: 'art', platform: 'discord', workspace: 'guild',
    botUser: 'bot', tokenSecret: 'FIXTURE', enabled: true, state: 'connected', stateAt: f.now() }).run();
  const id = await f.ask({ what: 'in:1' }, bridge.token);
  f.root.writes.run(() => f.db.update(s.bridgeConnections).set({ enabled: false }).where(eq(s.bridgeConnections.id, 'bridge')).run());
  f.clock.advance(60_000);
  expect(f.row(id)).toMatchObject({ state: 'ended', why: 'The watch ended because its conversation closed.' });
  expect(f.mail(id)).toEqual([]);
});


it.each(['archived', 'deleted'] as const)('leaves already-written mail to ordinary admission after a thread is %s', async state => {
  const f = await fixture();
  const id = await f.ask({ what: 'in:1' });
  f.clock.advance(60_000);
  expect(f.mail(id)).toMatchObject([{ job: null, state: 'waiting' }]);
  f.root.writes.run(() => {
    if (state === 'archived') f.root.services.comms!.threads.archive(f.thread.id, true);
    else f.root.services.comms!.delete(f.thread.id);
  });
  expect(await f.post('runtime.finish', { job: 'job', exitCode: 0, logTail: '' }, keys.runner)).toMatchObject({ ok: true });
  f.clock.advance(10_000);
  expect(f.mail(id)[0].job).toMatch(/^job-/);
  expect(f.row(id).state).toBe('fired');
});

it('ignores a slow poll that began before the untracked baseline even when timestamps tie', async () => {
  let release!: (rows: Change[]) => void;
  const slow = new Promise<Change[]>(resolve => { release = resolve; });
  const read = vi.fn(async () => [change({ head: head('b'), checks: running })]).mockReturnValueOnce(slow);
  const f = await fixture({ changes: { read } });
  const poll = f.root.refreshChanges!();
  try {
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    f.clock.advance(1000);
    const id = await f.ask({ what: 'acme/app#3', when: 'checks-finished' });
    release([change({ head: head('a'), checks: passed })]);
    await poll;
    expect(f.row(id).state).toBe('waiting');
    f.put({ head: head('b'), checks: passed });
    expect(f.mail(id)[0]?.words).toContain('finished on bbbbbbb');
  } finally { release([]); }
});

it('refuses a tracked repository redirect and ends an existing watch without the subject', async () => {
  const f = await fixture();
  f.put();
  const id = await f.ask({ what: 'acme/app#3', note: 'Keep the work private' });
  f.put({ sourceRepository: 'renamed/app', url: 'https://github.com/renamed/app/pull/3' });
  const refused = await f.post('tempo.wake', { what: 'acme/app#3' });
  expect(refused).toEqual(await f.post('tempo.wake', { what: 'missing/project#3' }));
  expect(f.row(id)).toMatchObject({ state: 'ended', why: WATCH_ENDED });
  expect(f.mail(id)).toEqual([]);
});

it('keeps the transactional observer attached while shutdown drains an in-flight poll', async () => {
  let release!: (rows: Change[]) => void;
  const read = vi.fn(() => new Promise<Change[]>(resolve => { release = resolve; }));
  const f = await fixture({ changes: { read } });
  f.put();
  const id = await f.ask({ what: 'acme/app#3' });
  const poll = f.root.refreshChanges!();
  try {
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    const closing = f.root.close();
    release([change({ title: 'Changed during shutdown' })]);
    await Promise.all([closing, poll]);
    expect(f.row(id).state).toBe('fired');
    expect(f.mail(id)).toHaveLength(1);
  } finally { release?.([]); }
});
