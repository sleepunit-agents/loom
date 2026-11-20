import { Jobs } from './runtime/jobs.js';
import { ConversationMail } from './core/conversations/mail.js';
import { afterEach, expect, it, vi } from 'vitest';
import { eq, like } from 'drizzle-orm';
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
  let upstream = change();
  const f = await bodyFixture(cleanup, { changes: { read: async () => [upstream] }, ...options });
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
  const mail = (id: string) => f.db.select().from(s.inbox).where(like(s.inbox.sourceId, id + '%')).all();
  const put = (value: Partial<Change> = {}) => {
    upstream = change(value);
    return f.root.services.changes.put(upstream);
  };
  const query = async (query: string, token = keys.body) => {
    const response = await f.root.http.request('/graphql', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ query }) });
    return await response.json() as { data?: Record<string, unknown>; errors?: unknown[] };
  };
  const body = (member: string | null, n: number, venue = 'loom') => {
    if (member) {
      f.db.insert(s.memberAgents).values({ member, agent: 'art' }).onConflictDoNothing().run();
      f.db.insert(s.projectMembers).values({ member, project: 'pond' }).onConflictDoNothing().run();
    }
    const place = 'thread-' + n;
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
  const otherVenues = ['discord', 'slack', 'wake', 'handoff', 'terminal'].map((venue, i) => f.body('alice', i + 3, venue).token);
  for (const token of [keys.member, terminal, ...otherVenues]) expect(await f.post('tempo.wake', input, token)).toEqual(denied);
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
  expect(f.row(id)).toMatchObject({ state: 'delivering', onWord: { kind: 'member', id: 'alice' } });
  expect(f.mail(id)).toMatchObject([{ conversation: f.cv, thread: f.thread.id, job: null, onWordKind: 'member', onWord: 'alice', state: 'waiting' }]);
  expect(f.mail(id)[0].words).toContain('Resume fixture work.');
  const item = f.mail(id)[0].id;
  expect((await f.query(`{ inboxItem(id:"${item}"){id} }`, other.token)).data).toEqual({ inboxItem: null });
  expect(await f.post('runtime.finish', { job: 'job', exitCode: 0, logTail: '' }, keys.runner)).toMatchObject({ ok: true });
  f.clock.advance(10_000);
  const successor = f.db.select().from(s.jobs).where(eq(s.jobs.conversation, f.cv)).all().find(j => j.id !== 'job');
  expect(successor).toMatchObject({ member: 'alice', conversation: f.cv, state: 'queued' });
  expect(f.mail(id)[0].job).toBe(successor?.id);
  const jobs = new Jobs(f.db, f.now);
  expect(jobs.claim(successor!.id, 'box')).toBeTruthy();
  expect(f.row(id).state).toBe('delivering');
  jobs.started(successor!.id, 'box', 'fixture');
  expect(f.row(id).state).toBe('delivering');
  const bodyMail = new ConversationMail(f.root.services.comms!);
  expect((await bodyMail.prepareTake(f.cv, successor!.id))()[0]?.words).toContain('Resume fixture work.');
  expect(f.row(id).state).toBe('fired');
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

it('remembers a finished head even after a rerun and rejects an older observation', async () => {
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
  expect(f.mail(id)).toEqual([]);
  f.put({ checks: passed, updated: next, head: head('c') });
  expect(f.mail(id)[0]?.words).toContain('finished on ccccccc');
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
  read.mockResolvedValueOnce([]);
  expect(await f.post('tempo.wake', { what: 'acme/app#404' })).toEqual(out);
  expect(read).toHaveBeenCalledTimes(2);
  expect(await f.post('tempo.wake', { what: 'elsewhere/app#404' })).toEqual(out);
  expect(read).toHaveBeenCalledTimes(2);
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
  f.db.$client.exec(`create temp trigger wake_test_failure before insert on inbox when new.source_id like '${crash}%' begin select raise(abort, 'simulated interruption'); end`);
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

it('enforces a cap per conversation without counting other conversations', async () => {
  const f = await fixture(), b = f.body('alice', 2), c = f.body('bob', 3);
  const ids = [];
  for (let i = 0; i < 20; i++) ids.push(await f.ask({ what: 'in:1' }));
  expect(await f.post('tempo.wake', { what: 'in:1' })).toMatchObject({ ok: false, message: 'Too many waiting wakes.' });
  for (let i = 0; i < 20; i++) await f.ask({ what: 'in:1' }, b.token);
  for (let i = 0; i < 20; i++) await f.ask({ what: 'in:1' }, c.token);
  expect(await f.post('tempo.wake', { what: 'in:1' }, c.token)).toMatchObject({ ok: false, message: 'Too many waiting wakes.' });
  expect(await f.post('tempo.wakeCancel', { id: ids[0] })).toMatchObject({ ok: true });
  await f.ask({ what: 'in:1' });
});

it.each(['archived', 'deleted'] as const)('settles already-written wake mail when a thread is %s', async state => {
  const f = await fixture();
  const id = await f.ask({ what: 'in:1' });
  f.clock.advance(60_000);
  expect(f.mail(id)).toMatchObject([{ job: null, state: 'waiting' }]);
  f.root.writes.run(() => {
    if (state === 'archived') f.root.services.comms!.threads.archive(f.thread.id, true);
    else f.root.services.comms!.delete(f.thread.id);
  });
  expect(f.mail(id)[0]).toMatchObject({ job: null, state: 'resolved', words: null });
  expect(f.row(id)).toMatchObject({ state: 'ended', why: `The wake could not be delivered because its conversation was ${state}.` });
  expect(await f.post('runtime.finish', { job: 'job', exitCode: 0, logTail: '' }, keys.runner)).toMatchObject({ ok: true });
  f.clock.advance(10_000);
  expect(f.mail(id)[0]).toMatchObject({ job: null, state: 'resolved', words: null });
  expect(f.row(id)).toMatchObject({ state: 'ended', why: `The wake could not be delivered because its conversation was ${state}.` });
});

it('ignores a slow poll that began before the untracked baseline even when timestamps tie', async () => {
  let release!: (rows: Change[]) => void;
  const slow = new Promise<Change[]>(resolve => { release = resolve; });
  const read = vi.fn(async () => [change({ head: head('b'), checks: running })]).mockReturnValueOnce(slow);
  const f = await fixture({ changes: { read } });
  const poll = f.root.refreshChanges!();
  try {
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    const id = await f.ask({ what: 'acme/app#3', when: 'checks-finished' });
    release([change({ head: head('a'), checks: passed })]);
    await poll;
    expect(f.row(id).state).toBe('waiting');
    const second = await f.ask({ what: 'acme/app#3' });
    f.put({ head: head('b'), checks: running });
    expect(f.row(second)).toMatchObject({ state: 'waiting', reading: null });
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
  expect(f.row(id)).toMatchObject({ state: 'ended', why: WATCH_ENDED, key: '', condition: null, baseline: null, reading: null, note: null });
  expect(f.mail(id)).toEqual([]);
});

it('keeps the transactional observer attached while shutdown drains an in-flight poll', async () => {
  let release!: (rows: Change[]) => void;
  const read = vi.fn(() => new Promise<Change[]>(resolve => { release = resolve; })).mockResolvedValueOnce([change()]);
  const f = await fixture({ changes: { read } });
  const id = await f.ask({ what: 'acme/app#3' });
  const poll = f.root.refreshChanges!();
  try {
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    const closing = f.root.close();
    release([change({ title: 'Changed during shutdown' })]);
    await Promise.all([closing, poll]);
    expect(f.row(id).state).toBe('delivering');
    expect(f.mail(id)).toHaveLength(1);
  } finally { release?.([]); }
});


it('lets a successor body see and cancel its predecessor’s wait and shows the recent outcome', async () => {
  const f = await fixture();
  const id = await f.ask({ what: 'in:1' });
  expect(await f.post('runtime.finish', { job: 'job', exitCode: 0, logTail: '' }, keys.runner)).toMatchObject({ ok: true });
  const job = { ...f.db.select().from(s.jobs).where(eq(s.jobs.id, 'job')).get()!, id: 'successor', state: 'running' as const, endedAt: null };
  f.db.insert(s.jobs).values(job).run();
  const token = credentialHash('successor');
  f.db.insert(s.tokens).values({ kind: 'agent', fingerprint: credentialHash(token), label: 'Successor', agent: 'art', job: job.id, createdAt: f.now() }).run();
  expect(await f.post('tempo.waits', {}, token)).toMatchObject({ ok: true, value: [{ id, state: 'waiting' }] });
  expect(await f.post('tempo.wakeCancel', { id }, token)).toMatchObject({ ok: true });
  const pending = await f.ask({ what: 'in:1' }, token);
  expect(await f.post('tempo.waits', {}, token)).toMatchObject({ ok: true, value: [
    { id: pending, state: 'waiting' }, { id, state: 'ended', why: 'The watch was cancelled.' },
  ] });
  f.db.update(s.wakes).set({ endedAt: new Date(f.clock.now() - 86_400_001).toISOString() }).where(eq(s.wakes.id, id)).run();
  expect(await f.post('tempo.waits', {}, token)).toMatchObject({ ok: true, value: [{ id: pending }] });
});

it('waits for a usable model and retains an intervening pull request event for the sweep', async () => {
  const f = await fixture();
  const timed = await f.ask({ what: 'in:1' }), pull = await f.ask({ what: 'acme/app#3' });
  f.db.delete(s.agentModels).run();
  f.put({ title: 'Changed while unavailable' });
  f.clock.advance(60_000);
  for (const id of [timed, pull]) {
    expect(f.row(id).state).toBe('waiting');
    expect(f.mail(id)).toEqual([]);
  }
  f.db.insert(s.agentModels).values({ agent: 'art', model: 'model', position: 0 }).run();
  f.clock.advance(30_000);
  for (const id of [timed, pull]) expect(f.mail(id)).toHaveLength(1);
});

it.each(['agent access', 'project access', 'model', 'pause'] as const)('settles already-written wake mail after losing %s before admission', async loss => {
  const f = await fixture();
  const id = await f.ask({ what: 'in:1' });
  f.clock.advance(60_000);
  expect(f.mail(id)[0]?.state).toBe('waiting');
  if (loss === 'agent access') f.db.delete(s.memberAgents).run();
  if (loss === 'project access') f.db.delete(s.projectMembers).run();
  if (loss === 'model') f.db.delete(s.agentModels).run();
  if (loss === 'pause') f.root.services.tempo.triggers.pause('art');
  expect(await f.post('runtime.finish', { job: 'job', exitCode: 0, logTail: '' }, keys.runner)).toMatchObject({ ok: true });
  f.clock.advance(30_000);
  if (loss === 'pause') {
    f.root.services.tempo.triggers.resume('art');
    f.clock.advance(30_000);
  }
  expect(f.row(id).state).toBe(loss === 'pause' ? 'delivering' : loss === 'model' ? 'waiting' : 'ended');
  expect(f.mail(id)[0]).toMatchObject({ job: null, state: 'resolved', words: null });
});

it('fires a due time first seen after day 14', async () => {
  const f = await fixture();
  const id = await f.ask({ what: 'in:1' });
  f.db.update(s.wakes).set({ askedAt: new Date(f.clock.now() - WAKE_MS).toISOString(), key: f.now() }).where(eq(s.wakes.id, id)).run();
  f.clock.advance(60_000);
  expect(f.row(id).state).toBe('delivering');
  expect(f.mail(id)).toHaveLength(1);
});

it('uses the same full check reading at registration and on polls, including overlapping names', async () => {
  const f = await fixture();
  const contexts = [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }, { name: 'test', status: 'IN_PROGRESS', conclusion: null }];
  const checks = { ...failed, running: ['test'], total: 2, contexts };
  f.put({ checks });
  const finish = await f.ask({ what: 'acme/app#3', when: 'checks-finished' });
  const review = await f.ask({ what: 'acme/app#3', when: 'review' });
  expect(JSON.parse(f.row(finish).baseline!).checks).toEqual(contexts);
  f.put({ checks: { ...checks, contexts: [...contexts].reverse() } });
  expect(f.row(finish).reading).toBeNull();
  expect(f.row(review).reading).toBeNull();
  f.put({ checks: { ...failed, total: 2, contexts: [contexts[0], contexts[0]] } });
  expect(f.mail(finish)[0]?.words).toContain('finished');
});


it('fences wake words in MCP inbox and waits', async () => {
  const f = await fixture();
  const { token } = f.body(null, 2);
  const note = '# Wake note\n\n[link](https://example.com)\r\n~~~';
  const id = await f.ask({ what: 'in:1', note }, token);
  f.clock.advance(60_000);
  for (const name of ['inbox', 'waits', 'loom_query', 'loom_command']) {
    const response = await f.root.http.request('/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments:
        name === 'loom_query' ? { query: '{inboxItems{body{words}}}' }
          : name === 'loom_command' ? { operation: 'tempo.waits', input: {}, id: 'read-waits' } : {} } }),
    });
    expect(response.status).toBe(200);
    const { result } = await response.json() as { result: { isError?: boolean; content: { text: string }[] } };
    expect(result.isError).not.toBe(true);
    const { text } = result.content[0];
    if (name === 'inbox' || name === 'waits') expect(text).toContain('    # Wake note\n    \n    [link](https://example.com)\n    ~~~');
    else {
      expect(text).not.toContain('[link]');
      expect(JSON.stringify(JSON.parse(text))).toContain(JSON.stringify(note).slice(1, -1));
    }
    if (name === 'waits') expect(text).toContain(id + ' · delivering');
  }
});

async function queueWake(f: Awaited<ReturnType<typeof fixture>>, note = 'Wake input') {
  const id = await f.ask({ what: 'in:1', note });
  expect(await f.post('runtime.finish', { job: 'job', exitCode: 0, logTail: '' }, keys.runner)).toMatchObject({ ok: true });
  f.clock.advance(70_000);
  const job = f.mail(id)[0].job!;
  const jobs = new Jobs(f.db, f.now);
  expect(jobs.get(job).state).toBe('queued');
  return { id, job, jobs };
}

it('replaces a queue-deadline occurrence and commits firing with the running job’s take', async () => {
  const f = await fixture();
  const { id, job, jobs } = await queueWake(f);
  const first = f.mail(id)[0];
  expect(f.row(id).state).toBe('delivering');
  expect(jobs.sweep(undefined, 1).map(row => row.id)).toContain(job);
  f.clock.advance(20_000);
  expect(f.row(id).state).toBe('waiting');
  expect(f.mail(id)).toMatchObject([{ id: first.id, state: 'resolved', words: null }]);
  f.clock.advance(40_000);
  const second = f.mail(id)[1];
  expect(second.sourceId).not.toBe(first.sourceId);
  expect(second.job).toBeTruthy();
  expect(jobs.claim(second.job!, 'box')).toBeTruthy();
  jobs.started(second.job!, 'box', 'fixture');
  const take = await new ConversationMail(f.root.services.comms!).prepareTake(f.cv, second.job!);
  f.db.$client.exec("create temp trigger fail_wake_take before update of state on wakes when new.state = 'fired' begin select raise(abort, 'simulated interruption'); end");
  expect(take).toThrow('simulated interruption');
  expect(f.mail(id)[1].state).toBe('waiting');
  expect(f.row(id).state).toBe('delivering');
  f.db.$client.exec('drop trigger fail_wake_take');
  expect(take().map(item => item.words)).toEqual([expect.stringContaining('Wake input')]);
  expect(f.row(id).state).toBe('fired');
  expect(jobs.finish(second.job!, 'box', 1).retry).toBeUndefined();
  f.clock.advance(120_000);
  expect(f.mail(id)).toHaveLength(2);
});

it.each(['volume', 'dismissWake'])('ends delivery deliberately when the thread member uses inbox.%s', async action => {
  const f = await fixture();
  const { id, job, jobs } = await queueWake(f);
  const { id: item } = f.mail(id)[0];
  const input = action === 'volume' ? { item, volume: 'mute' } : { item };
  expect(await f.post('inbox.' + action, input, keys.member, 'set-aside', keys.memberCookie)).toMatchObject({ ok: true });
  expect(f.row(id)).toMatchObject({ state: 'ended', why: 'The wake was set aside by alice.' });
  expect(jobs.get(job).state).toBe('stopped');
  f.clock.advance(120_000);
  expect(f.mail(id)).toMatchObject([{ state: 'resolved', words: null }]);
});

it.each(['archive', 'delete'])('stops a queued wake-only job when members %s the thread', async action => {
  const f = await fixture();
  const { id, job, jobs } = await queueWake(f);
  f.root.writes.run(() => action === 'archive' ? f.root.services.comms!.threads.archive(f.thread.id, true) : f.root.services.comms!.delete(f.thread.id));
  expect(jobs.get(job).state).toBe('stopped');
  expect(jobs.claim(job, 'box')).toBeUndefined();
  expect(f.row(id)).toMatchObject({ state: 'ended', why: `The wake could not be delivered because its conversation was ${action}d.` });
  expect(f.mail(id)).toMatchObject([{ state: 'resolved', words: null }]);
});

it.each(['taken', 'done'])('erases %s wake words on thread deletion', async finalState => {
  const f = await fixture();
  const { id, job, jobs } = await queueWake(f, 'Delete these words');
  expect(jobs.claim(job, 'box')).toBeTruthy();
  jobs.started(job, 'box', 'fixture');
  expect(f.root.services.conversations.take(f.cv, job)).toHaveLength(1);
  if (finalState === 'done') f.root.services.conversations.confirm(f.mail(id)[0].id, job);
  expect(f.mail(id)[0]).toMatchObject({ state: finalState, words: expect.stringContaining('Delete these words') });
  f.root.services.comms!.delete(f.thread.id);
  expect(f.mail(id)[0]).toMatchObject({ words: null, thread: null });
});

it('uses a newer registration head to reject a slow poll for every watch', async () => {
  let release!: (rows: Change[]) => void;
  const slow = new Promise<Change[]>(resolve => { release = resolve; });
  const read = vi.fn(async () => [change({ head: head('c'), checks: running })])
    .mockResolvedValueOnce([change({ head: head('a'), checks: running })]).mockReturnValueOnce(slow);
  const f = await fixture({ changes: { read } });
  const first = await f.ask({ what: 'acme/app#3', when: 'checks-finished' });
  const poll = f.root.refreshChanges!();
  try {
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    const second = await f.ask({ what: 'acme/app#3', when: 'checks-finished' });
    release([change({ head: head('b'), checks: passed })]);
    await poll;
    for (const id of [first, second]) expect(f.mail(id)).toEqual([]);
    f.put({ head: head('c'), checks: passed });
    for (const id of [first, second]) expect(f.mail(id)[0]?.words).toContain('finished on ccccccc');
  } finally { release([]); }
});

it('never delivers for a return to the finished registration head', async () => {
  const f = await fixture();
  f.put({ head: head('a'), checks: passed });
  const id = await f.ask({ what: 'acme/app#3', when: 'checks-finished' });
  f.put({ head: head('b'), checks: running });
  f.put({ head: head('a'), checks: passed });
  expect(f.mail(id)).toEqual([]);
  f.put({ head: head('b'), checks: passed });
  expect(f.mail(id)[0]?.words).toContain('finished on bbbbbbb');
});

it.each(['starting', 'running'])('retries with fresh mail if a %s worker dies before taking input', async phase => {
  const f = await fixture();
  const { id, job, jobs } = await queueWake(f);
  expect(jobs.claim(job, 'box')).toBeTruthy();
  if (phase === 'running') jobs.started(job, 'box', 'fixture');
  expect(jobs.finish(job, 'box', 1).retry).toBeUndefined();
  f.clock.advance(60_000);
  const [first, next] = f.mail(id);
  expect(first).toMatchObject({ state: 'resolved', words: null });
  expect(next).toMatchObject({ state: 'waiting', words: expect.stringContaining('Wake input') });
  expect(next.sourceId).not.toBe(first.sourceId);
  expect(f.row(id).state).toBe('delivering');
});

it('blocks a prepared take when the thread closes before input is released', async () => {
  const f = await fixture();
  const { id, job, jobs } = await queueWake(f);
  expect(jobs.claim(job, 'box')).toBeTruthy();
  jobs.started(job, 'box', 'fixture');
  const take = await new ConversationMail(f.root.services.comms!).prepareTake(f.cv, job);
  f.root.services.comms!.threads.archive(f.thread.id, true);
  expect(take).toThrow('Mail changed');
  expect(f.root.services.conversations.take(f.cv, job)).toEqual([]);
  expect(f.row(id)).toMatchObject({ state: 'ended', why: 'The wake could not be delivered because its conversation was archived.' });
});

it('describes review wakes as changes of decision or reviewer in waits', async () => {
  const f = await fixture();
  f.put();
  const id = await f.ask({ what: 'acme/app#3', when: 'review' });
  expect(await f.post('tempo.waits', {})).toMatchObject({ value: [{
    id, what: expect.stringContaining('the review decision changes or a new reviewer reviews'),
  }] });
});

it('refuses to release a queued wake after its asker loses the watched repository', async () => {
  const f = await fixture();
  f.put();
  const id = await f.ask({ what: 'acme/app#3', note: 'Private pull request wake' });
  f.put({ title: 'Changed title' });
  expect(await f.post('runtime.finish', { job: 'job', exitCode: 0, logTail: '' }, keys.runner)).toMatchObject({ ok: true });
  f.clock.advance(10_000);
  const job = f.mail(id)[0].job!, jobs = new Jobs(f.db, f.now);
  expect(jobs.claim(job, 'box')).toBeTruthy();
  jobs.started(job, 'box', 'fixture');
  const token = 'h'.repeat(64);
  f.db.insert(s.tokens).values({ kind: 'agent', fingerprint: credentialHash(token), label: 'Successor body', agent: 'art', job, createdAt: f.now() }).run();
  f.root.writes.run(() => f.db.delete(s.projectRepositories).run());
  const response = await f.root.http.request('/api/conversation/take', {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ input: {} }),
  });
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain('Private pull request wake');
  expect(f.row(id).state).toBe('delivering');
  f.clock.advance(30_000);
  expect(f.row(id)).toMatchObject({ state: 'ended', why: WATCH_ENDED, note: null, key: '' });
  expect(f.mail(id)[0]).toMatchObject({ state: 'resolved', words: null });
});


it('ends an expired delivery and withdraws its queued input', async () => {
  const f = await fixture();
  const { id, job, jobs } = await queueWake(f);
  f.db.update(s.wakes).set({ askedAt: new Date(f.clock.now() - WAKE_MS + 10_000).toISOString() }).where(eq(s.wakes.id, id)).run();
  f.clock.advance(120_000);
  expect(f.row(id)).toMatchObject({ state: 'ended', why: expect.stringContaining('could not be delivered') });
  expect(jobs.get(job).state).toBe('stopped');
  expect(f.mail(id)).toMatchObject([{ state: 'resolved', words: null }]);
});


it('leaves an unmailed completion waiting when a newer direct read supersedes its head', async () => {
  const read = vi.fn(async () => [change({ head: head('b'), checks: running })])
    .mockResolvedValueOnce([change({ head: head('a'), checks: running })]);
  const f = await fixture({ changes: { read } });
  const first = await f.ask({ what: 'acme/app#3', when: 'checks-finished' });
  f.root.services.tempo.triggers.pause('art');
  f.put({ head: head('a'), checks: passed });
  expect(f.mail(first)).toEqual([]);
  await f.ask({ what: 'acme/app#3', when: 'review' });
  f.root.services.tempo.triggers.resume('art');
  f.clock.advance(30_000);
  expect(f.mail(first)).toEqual([]);
  f.put({ head: head('b'), checks: passed });
  expect(f.mail(first)[0]?.words).toContain('finished on bbbbbbb');
});
