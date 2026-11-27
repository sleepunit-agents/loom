/** A ticket and the sessions that worked it, over the real doors (docs/specs/boards.md, "Sessions"): a body names
 * the tickets its handoff is for, loom records the link, and only the member of that conversation reads it from
 * the ticket. All people and words are fictional. */
import { afterEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as s from './core/data/schema.js';
import { reviewPlace } from './core/conversations/review-place.js';
import { HANDOFF_TICKETS_MAX } from './core/conversations/handoff.js';
import { bodyFixture, bodyCredentials, credentialHash } from '../test/fixtures/conversation-body.js';

const clean: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });
const bobToken = 'n'.repeat(64);
const brief = { agent: 'mark', clientId: 'brief', label: 'Compare fictional pumps', words: 'PRIVATE HANDOFF WORDS' };

async function fixture() {
  const f = await bodyFixture(clean), at = () => new Date(f.clock.now()).toISOString();
  f.root.writes.run(() => {
    f.db.insert(s.memberAgents).values([{ member: 'alice', agent: 'mark' }, { member: 'bob', agent: 'art' }, { member: 'bob', agent: 'mark' }]).run();
    f.db.insert(s.projectAgents).values({ project: 'pond', agent: 'mark' }).run();
    f.db.insert(s.projectMembers).values({ project: 'pond', member: 'bob' }).run();
    f.db.insert(s.agentModels).values({ agent: 'mark', model: 'fixture', position: 0 }).run();
    f.db.insert(s.agentRunSettings).values({ agent: 'mark', houseRepository: 'fixture', houseFile: 'Housefile', houseBranch: 'next', nestedContainers: false, gpu: false }).run();
    const task = { ownerKind: 'household' as const, createdByKind: 'member' as const, createdBy: 'alice', createdAt: at(), changedAt: at() };
    f.db.insert(s.tasks).values([
      { ...task, id: 't-1', title: 'Fix the fictional pump', project: 'pond' },
      { ...task, id: 't-2', title: 'Paint the fictional shed', project: 'pond' },
      // In a project neither the member nor the agent is in: it exists, and this body may not read it.
      { ...task, id: 't-9', title: 'Elsewhere', project: 'other', ownerKind: 'member' as const, owner: 'bob' },
    ]).run();
    f.db.insert(s.tokens).values({ fingerprint: credentialHash(bobToken), label: 'Bob', kind: 'owner', member: 'bob', createdAt: at() }).run();
  });
  const handoff = async (input: Record<string, unknown>, id: string) => {
    const response = await f.call('handoff', { ...brief, ...input }, id);
    return { status: response.status, body: await response.json() as { value?: { conversation: string } } };
  };
  const sessions = async (ticket: string, token: string) => {
    const response = await f.root.http.request('/graphql', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ query: `{ticketSessions(ticket:${JSON.stringify(ticket)}){conversation agent job title state at}}` }) });
    return await response.json() as { data?: { ticketSessions: Record<string, string | null>[] }; errors?: unknown[] };
  };
  return { ...f, handoff, sessions };
}

it('records the tickets a handoff is said to be for, and refuses one the body cannot read', async () => {
  const f = await fixture();
  // An id that is no ticket, and a ticket outside what this body may read, refuse the handoff: nothing is written.
  for (const tickets of [['t-404'], ['t-1', 't-9']]) {
    const refused = await f.handoff({ tickets }, 'bad-' + tickets.length);
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('Unknown ticket: ' + tickets.at(-1));
  }
  expect((await f.handoff({ tickets: [] }, 'none')).status).toBe(400);
  expect((await f.handoff({ tickets: Array.from({ length: HANDOFF_TICKETS_MAX + 1 }, (_, n) => 't-' + n) }, 'many')).status).toBe(400);
  // A note to its own body in another conversation opens no session, so it takes no tickets.
  expect((await f.handoff({ agent: undefined, to: { conversation: f.thread.conversation }, tickets: ['t-1'] }, 'self')).status).toBe(400);
  expect(f.db.select().from(s.conversationTasks).all()).toEqual([]);
  expect(f.db.select().from(s.conversations).where(eq(s.conversations.venue, 'handoff')).all()).toEqual([]);
  // A repeated id is one link. A retry of the same brief returns the same conversation and writes nothing more.
  const made = await f.handoff({ tickets: ['t-1', 't-2', 't-1'] }, 'good');
  expect(made.status).toBe(200);
  const child = made.body.value!.conversation;
  expect(f.db.select().from(s.conversationTasks).all().sort((a, b) => a.task.localeCompare(b.task))).toEqual([{ conversation: child, task: 't-1' }, { conversation: child, task: 't-2' }]);
  expect((await f.handoff({ tickets: ['t-1', 't-2', 't-1'] }, 'good-again')).body.value).toMatchObject({ conversation: child });
  expect(f.db.select().from(s.conversationTasks).all()).toHaveLength(2);
  // A brief to a peer agent from the same job joins the one conversation that agent has for it, so a later
  // brief there that names no ticket, or one already linked, changes nothing.
  const plain = await f.handoff({ clientId: 'plain' }, 'plain');
  expect(plain.body.value).toMatchObject({ conversation: child });
  expect((await f.handoff({ clientId: 'again', tickets: ['t-2'] }, 'again')).status).toBe(200);
  expect(f.db.select().from(s.conversationTasks).all()).toHaveLength(2);
});

it('lists a ticket\'s sessions newest first for the member they belong to, also once it is closed, and to nobody else', async () => {
  const f = await fixture();
  f.root.services.runtime.close();
  // Three handed-off sessions of the member's, as a work role's or a harness's handoff opens them: one conversation each.
  const open = (clientId: string, label: string, tickets: string[]) => f.root.writes.run(() => {
    const cv = f.root.services.conversations.open({ agent: 'art', member: 'alice', project: 'pond', venue: 'handoff', place: reviewPlace('job', clientId), label, direct: false });
    const parent = f.db.select().from(s.jobs).where(eq(s.jobs.id, 'job')).get()!;
    f.db.insert(s.jobs).values({ ...parent, id: 'job-' + clientId, conversation: cv.id, title: 'Job ' + label, state: 'done', queuedAt: new Date(f.clock.now()).toISOString(), endedAt: new Date(f.clock.now()).toISOString() }).run();
    if (tickets.length) f.db.insert(s.conversationTasks).values(tickets.map(task => ({ conversation: cv.id, task }))).run();
    return cv.id;
  }).value;
  const first = open('one', 'First pass', ['t-1']);
  f.clock.advance(60_000);
  const second = open('two', 'Second pass', ['t-1', 't-2']);
  f.clock.advance(60_000);
  // A session for no ticket is not this ticket's.
  open('three', 'Unrelated', []);
  const jobOf = (cv: string) => f.db.select().from(s.jobs).where(eq(s.jobs.conversation, cv)).get();
  const row = (cv: string, label: string) => { const job = jobOf(cv); const started = f.db.select().from(s.conversations).where(eq(s.conversations.id, cv)).get()!.startedAt;
    return { conversation: cv, agent: 'art', job: job?.id ?? null, title: job?.title || label, state: job?.state ?? null, at: job?.queuedAt ?? started }; };
  const mine = await f.sessions('t-1', bodyCredentials.member);
  expect(mine.errors).toBeUndefined();
  expect(mine.data!.ticketSessions).toEqual([row(second, 'Second pass'), row(first, 'First pass')]);
  expect((await f.sessions('t-2', bodyCredentials.member)).data!.ticketSessions).toEqual([row(second, 'Second pass')]);
  // The latest job is the one said: a later job in the first conversation moves it to the top.
  const old = jobOf(first);
  f.root.writes.run(() => {
    if (old) f.db.update(s.jobs).set({ state: 'done', endedAt: new Date(f.clock.now()).toISOString() }).where(eq(s.jobs.id, old.id)).run();
    const base = old ?? f.db.select().from(s.jobs).where(eq(s.jobs.id, 'job')).get()!;
    f.db.insert(s.jobs).values({ ...base, id: 'later', conversation: first, title: 'Later job', state: 'failed', box: null, queuedAt: new Date(f.clock.now()).toISOString(), claimedAt: null, heardAt: null, endedAt: new Date(f.clock.now()).toISOString() }).run();
  });
  expect((await f.sessions('t-1', bodyCredentials.member)).data!.ticketSessions.map(r => [r.conversation, r.job, r.title, r.state])).toEqual([[first, 'later', 'Later job', 'failed'], [second, jobOf(second)?.id ?? null, jobOf(second)?.title || 'Second pass', jobOf(second)?.state ?? null]]);
  // A closed ticket still has them.
  f.root.writes.run(() => f.db.update(s.tasks).set({ status: 'closed', closedAt: new Date(f.clock.now()).toISOString(), closeReason: 'Done' }).where(eq(s.tasks.id, 't-1')).run());
  expect((await f.sessions('t-1', bodyCredentials.member)).data!.ticketSessions.map(r => r.conversation)).toEqual([first, second]);
  // Another member who reads the ticket, has both agents and is in the project reads no session: the
  // conversations are the first member's. An agent, and the handing-off job's own body, read none either.
  expect((await f.sessions('t-1', bobToken)).data).toEqual({ ticketSessions: [] });
  for (const token of [bodyCredentials.agent, bodyCredentials.body]) expect((await f.sessions('t-1', token)).data).toEqual({ ticketSessions: [] });
  // A ticket the member may not read, and one that does not exist, list nothing.
  f.root.writes.run(() => f.db.insert(s.conversationTasks).values({ conversation: first, task: 't-9' }).run());
  expect((await f.sessions('t-9', bodyCredentials.member)).data).toEqual({ ticketSessions: [] });
  expect((await f.sessions('t-404', bodyCredentials.member)).data).toEqual({ ticketSessions: [] });
  // Deleting the ticket removes its links; the sessions stay.
  f.root.writes.run(() => { f.db.delete(s.taskBacklogEvents).run(); f.db.delete(s.tasks).where(eq(s.tasks.id, 't-2')).run(); });
  expect(f.db.select().from(s.conversationTasks).all().map(r => r.task).sort()).toEqual(['t-1', 't-1', 't-9']);
});
