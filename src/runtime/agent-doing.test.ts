/** What an agent is doing, as Home's card reads it: each kind from real rows, and who may learn what. */
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { graphql, GraphQLObjectType, GraphQLSchema } from 'graphql/index.js';
import { createDataSchema } from '../core/data/database.js';
import type { QueryVisibility } from '../core/data/queries.js';
import { agents, boxes, conversations, jobs, members, memberAgents, projects, projectAgents, projectMembers, tasks, terminalSessions, triggers } from '../core/data/schema.js';
import { conversationPlace, discordPlace } from '../pieces/bridges/place.js';
import { wakePlace } from '../core/tempo/tempo.js';
import { sqlVisibility } from '../policy-sql.js';
import type { Viewer } from '../policy.js';
import { doingCap, JobSummaries, jobSummaryFields, taskRecentMs, type Doing } from './job-summary.js';
import { SILENCE_MS } from './silence.js';
import { QUEUE_DEADLINE_MS } from './jobs.js';

const clients: Database.Database[] = [];
afterEach(() => { for (const c of clients.splice(0)) c.close(); });
const at = '2026-11-19T18:00:00.000Z', hour = (n: number) => `2026-11-19T${String(n).padStart(2, '0')}:00:00.000Z`;
const guarded = ['jobs', 'conversations', 'boxes', 'tasks', 'triggers'] as const;
/** The household: `house` runs it, `alex` has Art on their list, `bo` is on the pond project with Art. */
function household() {
  const client = new Database(':memory:'); clients.push(client);
  const db = createDataSchema(client, () => at);
  db.insert(members).values([{ id: 'house', role: 'owner', joinedAt: at }, { id: 'alex', role: 'member', joinedAt: at }, { id: 'bo', role: 'member', joinedAt: at }]).run();
  for (const id of ['art', 'mark']) db.insert(agents).values({ id, about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(memberAgents).values({ member: 'alex', agent: 'art' }).run();
  db.insert(projects).values({ id: 'pond', name: 'Pond' }).run();
  db.insert(projectMembers).values({ project: 'pond', member: 'bo' }).run();
  db.insert(projectAgents).values({ project: 'pond', agent: 'art' }).run();
  db.insert(boxes).values({ id: 'box-one', name: 'one', owner: 'alex', enrolledAt: at, sameMachineAsLoom: true, hostsAny: true, reportOnly: false, alwaysOn: false }).run();
  const talk = (id: string, venue: typeof conversations.$inferInsert.venue, place: string, label: string, extra: Partial<typeof conversations.$inferInsert> = {}) =>
    db.insert(conversations).values({ id, agent: 'art', venue, place, label, startedAt: at, lastAt: at, turnCount: 1, ...extra }).run();
  const job = (id: string, extra: Partial<typeof jobs.$inferInsert> = {}) => db.insert(jobs).values({ id, agent: 'art', state: 'running', title: `title of ${id}`,
    brief: 'private instructions', model: 'm', startedByKind: 'agent', startedBy: 'art', houseRepository: 'repo', houseFile: 'Housefile', houseBranch: 'next',
    queuedAt: at, claimedAt: at, heardAt: at, ...extra }).run();
  const trigger = (id: string, note: string, extra: Partial<typeof triggers.$inferInsert> = {}) => db.insert(triggers).values({ id, ownerKind: 'household', sourceKind: 'time',
    lifespan: 'until-stopped', targetKind: 'inbox', toKind: 'agent', to: 'art', note, enabled: true, state: 'standing', createdAt: at, changedAt: at, ...extra }).run();
  const task = (id: string, title: string, extra: Partial<typeof tasks.$inferInsert> = {}) => db.insert(tasks).values({ id, title, status: 'in_progress', ownerKind: 'agent', owner: 'art',
    assigneeKind: 'agent', assignee: 'art', createdByKind: 'agent', createdBy: 'art', createdAt: at, startedAt: at, changedAt: at, ...extra }).run();
  let now = Date.parse(at);
  const as = (viewer: Viewer, widen: QueryVisibility = {}) => new JobSummaries(db, () => ({ ...sqlVisibility(viewer, guarded), ...widen }), () => now);
  return { db, client, talk, job, trigger, task, as, clock: (value: number) => { now = value; } };
}
const house: Viewer = { kind: 'member', id: 'house' }, alex: Viewer = { kind: 'member', id: 'alex' }, bo: Viewer = { kind: 'member', id: 'bo' };
const art: Viewer = { kind: 'agent', id: 'art' };
/** One of everything Art can be doing. */
function busy() {
  const h = household();
  // A terminal session Alex is driving: a thread of venue `terminal`, labelled machine · harness · folder (terminal-sessions.ts, open).
  h.talk('cv-term', 'terminal', 'th:term', 'one · claude · loom', { member: 'alex' });
  h.job('j-term', { conversation: 'cv-term', member: 'alex', box: 'box-one', startedByKind: 'terminal', startedBy: 'alex', title: 'one · claude · loom', queuedAt: hour(9), claimedAt: hour(9) });
  h.db.insert(terminalSessions).values({ job: 'j-term', sessionId: 's1', machine: 'box-one', member: 'alex', agent: 'art', harness: 'claude', cwd: '/home/alex/Code/loom' }).run();
  // A Discord direct message from Alex, a linked member, and one from somebody who is no member.
  const dm = { channel: 'D1', isDm: true, user: 'U1' };
  h.talk('cv-dm', 'discord', conversationPlace('guild', dm, 'alex'), discordPlace(dm, 'alex'), { member: 'alex', direct: true });
  h.job('j-dm', { conversation: 'cv-dm', member: 'alex', queuedAt: hour(10), claimedAt: hour(10) });
  h.talk('cv-guest', 'discord', conversationPlace('guild', { ...dm, channel: 'D2' }, null), discordPlace({ ...dm, user: '4711' }, null), { direct: true });
  h.job('j-guest', { conversation: 'cv-guest', queuedAt: hour(11), claimedAt: hour(11) });
  h.talk('cv-group', 'discord', conversationPlace('guild', { ...dm, channel: 'G1', groupDm: true }, null), discordPlace({ ...dm, groupDm: true }, null), { direct: true });
  h.job('j-group', { conversation: 'cv-group', queuedAt: hour(8), claimedAt: hour(8) });
  // A Discord channel on the pond project, and a Slack channel and direct message.
  const channel = { channel: 'C1', isDm: false, user: 'U1', channelName: 'pond' };
  h.talk('cv-pond', 'discord', conversationPlace('guild', channel, null), discordPlace(channel, null), { project: 'pond' });
  h.job('j-pond', { conversation: 'cv-pond', project: 'pond', state: 'starting', queuedAt: hour(12), claimedAt: null });
  h.talk('cv-slack', 'slack', conversationPlace('T1', { channel: 'C024', thread: '171.5', isDm: false }, null), '171.5');
  h.job('j-slack', { conversation: 'cv-slack', queuedAt: hour(13), claimedAt: hour(13) });
  h.talk('cv-slack-dm', 'slack', conversationPlace('T1', { channel: 'D9', isDm: true }, 'alex'), 'D9', { member: 'alex', direct: true });
  h.job('j-slack-dm', { conversation: 'cv-slack-dm', member: 'alex', queuedAt: hour(7), claimedAt: hour(7) });
  // Alex's own thread in Comms.
  h.talk('cv-loom', 'loom', 'th:garden/1', 'Repair the garden pump', { member: 'alex' });
  h.job('j-loom', { conversation: 'cv-loom', member: 'alex', title: 'Repair the garden pump', state: 'running', box: null, queuedAt: hour(14), claimedAt: null });
  // A trigger's firing in its own wake conversation; a house program's job; the sweep, which no trigger names.
  h.trigger('tr-night', 'Plan the night');
  h.talk('cv-night', 'wake', wakePlace('tr-night'), 'Plan the night');
  h.job('j-night', { conversation: 'cv-night', title: 'Plan the night', box: 'box-one', queuedAt: hour(15), claimedAt: hour(15) });
  h.trigger('tr-program', 'Tidy the logs');
  h.talk('cv-program', 'wake', wakePlace('tr-program'), 'An older label');
  h.job('j-program', { conversation: 'cv-program', startedByKind: 'program', startedBy: 'tr-program', queuedAt: hour(6), claimedAt: hour(6) });
  h.talk('cv-sweep', 'wake', 'sweep:art', 'The sweep');
  h.job('j-sweep', { conversation: 'cv-sweep', queuedAt: hour(5), claimedAt: hour(5) });
  // Work Mark handed to Art: the hand-off conversation's place is the job it came from (handoff.ts).
  h.job('j-mark', { agent: 'mark', state: 'done' });
  h.talk('cv-hand', 'handoff', 'j-mark', 'Check the pump');
  h.job('j-hand', { conversation: 'cv-hand', queuedAt: hour(4), claimedAt: hour(4) });
  // A task in progress, a job in no conversation, and what is not Art's or not current.
  h.task('t-2190', 'Order the pump', { startedAt: hour(3) });
  h.task('t-2191', 'Not started', { status: 'open' });
  h.task('t-2192', 'Mark’s task', { assignee: 'mark' });
  h.job('j-plain', { title: 'Rebuild the index', queuedAt: hour(2), claimedAt: hour(2) });
  h.job('j-done', { state: 'done' }); h.job('j-other', { agent: 'mark' });
  return h;
}
const said = (item: Doing) => Object.fromEntries(Object.entries(item).filter(([, value]) => value !== null));
const byId = (items: Doing[]) => new Map(items.map(item => [item.id, said(item)]));

it('says each thing by its kind, from the rows alone, to the person who may read all of it', () => {
  const h = busy(), first = h.as(alex).doing('art');
  // One read holds the first eight; the rest are read once those eight jobs are gone.
  expect(first.items).toHaveLength(doingCap);
  h.db.delete(terminalSessions).run();
  h.db.delete(jobs).where(sql`${jobs.id} in (${sql.join(first.items.map(item => sql`${item.id}`), sql`, `)})`).run();
  const all = byId([...first.items, ...h.as(alex).doing('art').items]);
  expect(all.get('j-term')).toEqual({ id: 'j-term', kind: 'terminal', title: 'claude · loom', machine: 'one', since: hour(9), state: 'running', href: '/p/comms-preview/thread/term' });
  expect(all.get('j-dm')).toEqual({ id: 'j-dm', kind: 'discord', title: 'Discord direct message with alex', with: 'alex', direct: 'person', since: hour(10), state: 'running', href: '/p/comms-preview/conversation/cv-dm' });
  expect(all.get('j-guest')).toEqual({ id: 'j-guest', kind: 'discord', title: 'Discord direct message with 4711', direct: 'person', since: hour(11), state: 'running', href: '/p/comms-preview/conversation/cv-guest' });
  expect(all.get('j-group')).toEqual({ id: 'j-group', kind: 'discord', title: 'Discord group direct message', direct: 'group', since: hour(8), state: 'running', href: '/p/comms-preview/conversation/cv-group' });
  expect(all.get('j-pond')).toEqual({ id: 'j-pond', kind: 'discord', title: 'Discord channel #pond', place: '#pond', since: hour(12), state: 'starting', href: '/p/comms-preview/conversation/cv-pond' });
  // Slack keeps a channel's id and no name, so there is no place to say.
  expect(all.get('j-slack')).toEqual({ id: 'j-slack', kind: 'slack', title: '171.5', since: hour(13), state: 'running', href: '/p/comms-preview/conversation/cv-slack' });
  expect(all.get('j-slack-dm')).toEqual({ id: 'j-slack-dm', kind: 'slack', title: 'D9', with: 'alex', direct: 'person', since: hour(7), state: 'running', href: '/p/comms-preview/conversation/cv-slack-dm' });
  expect(all.get('j-loom')).toEqual({ id: 'j-loom', kind: 'loom', title: 'Repair the garden pump', with: 'alex', since: hour(14), state: 'running', href: '/p/comms-preview/thread/garden%2F1' });
  expect(all.get('j-night')).toEqual({ id: 'j-night', kind: 'trigger', title: 'Plan the night', machine: 'one', since: hour(15), state: 'running', href: '/p/tempo' });
  expect(all.get('j-program')).toEqual({ id: 'j-program', kind: 'trigger', title: 'Tidy the logs', since: hour(6), state: 'running', href: '/p/tempo' });
  expect(all.get('j-sweep')).toEqual({ id: 'j-sweep', kind: 'wake', title: 'The sweep', since: hour(5), state: 'running', href: '/p/comms-preview/conversation/cv-sweep' });
  expect(all.get('j-hand')).toEqual({ id: 'j-hand', kind: 'handoff', title: 'Check the pump', since: hour(4), state: 'running', href: '/p/comms-preview/conversation/cv-hand' });
  expect(all.get('t-2190')).toEqual({ id: 't-2190', kind: 'task', title: 'Order the pump', ref: 't-2190', since: at, state: 'in_progress', href: '/p/tasks-preview/task/t-2190' });
  expect(all.get('j-plain')).toEqual({ id: 'j-plain', kind: 'job', title: 'Rebuild the index', since: hour(2), state: 'running' });
  expect([...all.keys()].sort()).toEqual(['j-dm', 'j-group', 'j-guest', 'j-hand', 'j-loom', 'j-night', 'j-plain', 'j-pond', 'j-program', 'j-slack', 'j-slack-dm', 'j-sweep', 'j-term', 't-2190']);
});

it('names the agent a hand-off came from only to someone who may read the job it was handed from', () => {
  const h = busy(), hand = (viewer: Viewer) => h.as(viewer).doing('art').items.find(item => item.id === 'j-hand');
  h.db.delete(terminalSessions).run();
  h.db.delete(jobs).where(sql`${jobs.id} not in ('j-hand','j-mark')`).run();
  // Mark's job has no labels Alex reaches: Alex has Art, not Mark. A household owner reads it.
  expect(hand(alex)).toMatchObject({ kind: 'handoff', with: null, title: 'Check the pump' });
  expect(hand(house)).toMatchObject({ kind: 'handoff', with: 'mark' });
});

it('orders what a person is in first, then what was started for the agent, then tasks, newest first, and counts what the cap leaves out', () => {
  const h = busy(), read = h.as(alex).doing('art');
  expect(read.items.map(item => item.id)).toEqual(['j-loom', 'j-slack', 'j-pond', 'j-guest', 'j-dm', 'j-term', 'j-group', 'j-slack-dm']);
  expect(read.more).toBe(6);
  h.db.delete(jobs).where(sql`${jobs.id} in ('j-loom','j-slack','j-pond','j-guest','j-dm','j-group','j-slack-dm')`).run();
  expect(h.as(alex).doing('art')).toMatchObject({ more: 0, items: ['j-term', 'j-night', 'j-program', 'j-sweep', 'j-hand', 'j-plain', 't-2190'].map(id => ({ id })) });
  expect(h.as(house).doing('mark').items.map(item => item.id)).toEqual(['j-other', 't-2192']);
  expect(h.as(alex).doing('nobody')).toEqual({ items: [], more: 0, claimed: 0 });
  // An agent's own page asks for all of it.
  h.db.delete(tasks).run(); for (let n = 0; n < 9; n++) h.task(`t-${n}`, `Task ${n}`);
  // Nine tasks touched just now: three are pills, six are counted, and only what the cap cut is `more`.
  expect(h.as(alex).doing('art')).toMatchObject({ more: 1, claimed: 6 });
  expect(h.as(alex).doing('art', 100)).toMatchObject({ more: 0, claimed: 6, items: { length: 9 } });
  for (const limit of [0, 1.5, 101]) expect(() => h.as(alex).doing('art', limit)).toThrow('Doing limit');
});

it('shows a terminal session only while it has been heard from, as the current jobs do', () => {
  const h = busy();
  h.db.delete(jobs).where(sql`${jobs.id} <> 'j-term'`).run();
  expect(h.as(alex).doing('art').items.map(item => item.id)).toEqual(['j-term', 't-2190']);
  h.clock(Date.parse(at) + 16 * 60_000);
  expect(h.as(alex).doing('art').items.map(item => item.id)).toEqual(['t-2190']);
});

const privateWords = /alex|4711|pump|garden|claude|Discord|D9|171\.5|th:|cv-|comms-preview|"one"|"(discord|slack|loom|terminal)"/;
it('tells nobody of a conversation they may not read: under the household’s rules its job is not theirs to list at all', () => {
  const h = busy();
  h.db.delete(jobs).where(sql`${jobs.id} in ('j-night','j-program','j-sweep','j-hand','j-plain','j-slack','j-mark')`).run();
  h.db.delete(tasks).run();
  // Alex's own threads and direct messages, and the direct messages only Art's owners read.
  const ids = (viewer: Viewer) => h.as(viewer).doing('art').items.map(item => item.id).sort();
  expect(ids(alex)).toEqual(['j-dm', 'j-group', 'j-guest', 'j-loom', 'j-pond', 'j-slack-dm', 'j-term']);
  for (const viewer of [bo, house, art] as const) {
    const read = h.as(viewer).doing('art');
    expect(read).toEqual({ more: 0, claimed: 0, items: [expect.objectContaining({ id: 'j-pond', kind: 'discord', place: '#pond' })] });
  }
});

it('says only "private" of a job whose conversation the viewer may not read, were a job ever listed without it', () => {
  // The jobs rule reads a job with its conversation (policy.ts, inTalk), so the household's own rules never
  // list such a job. This composition is handed a wider jobs filter on purpose: the conversation's rule alone
  // must still keep every word of the conversation back.
  const h = busy(), wide = { jobs: () => sql`true` } satisfies QueryVisibility;
  h.db.delete(jobs).where(sql`${jobs.id} in ('j-night','j-program','j-sweep','j-hand','j-plain','j-slack','j-mark','j-pond')`).run();
  h.db.delete(tasks).run();
  for (const viewer of [bo, house, art] as const) {
    const read = h.as(viewer, wide).doing('art');
    expect(read.items.map(item => item.id).sort()).toEqual(['j-dm', 'j-group', 'j-guest', 'j-loom', 'j-slack-dm', 'j-term']);
    for (const item of read.items) expect(item).toEqual({ id: item.id, kind: 'private', title: null, with: null, place: null, direct: null, ref: null, task: null, quietSince: null, href: null,
      machine: item.id === 'j-term' && viewer === house ? 'one' : null, since: item.since, state: item.state });
    expect(JSON.stringify(read).replace(/"machine":"one"/, '')).not.toMatch(privateWords);
  }
  // The same read, for the member the conversations are with, is whole.
  expect(h.as(alex, wide).doing('art').items.every(item => item.kind !== 'private' && item.href)).toBe(true);
});

it('names a trigger, a task and a machine each under its own rule', () => {
  const h = household();
  // Work a trigger does for Bo is Bo's private conversation; the trigger itself is Alex's and not Bo's to read.
  h.trigger('tr-bo', 'Remind Bo of the order', { ownerKind: 'member', owner: 'alex', member: 'bo' });
  h.talk('cv-bo', 'wake', wakePlace('tr-bo', 'bo'), 'Morning reminder', { member: 'bo' });
  h.job('j-bo', { conversation: 'cv-bo', member: 'bo', box: 'box-one' });
  h.task('t-7', 'Order the pump'); h.task('t-8', 'Drain the pond', { ownerKind: 'household', owner: null, project: 'pond' });
  expect(h.as(bo).doing('art').items.map(said)).toEqual([
    { id: 'j-bo', kind: 'wake', title: 'Morning reminder', since: at, state: 'running', href: '/p/comms-preview/conversation/cv-bo' },
    { id: 't-8', kind: 'task', title: 'Drain the pond', ref: 't-8', since: at, state: 'in_progress', href: '/p/tasks-preview/task/t-8' },
  ]);
  expect(JSON.stringify(h.as(bo).doing('art'))).not.toMatch(/Remind Bo|tempo|t-7|Order the pump|"one"/);
  // Alex reads the trigger and Art's own task, and not Bo's conversation or the project's task.
  expect(h.as(alex).doing('art').items.map(said)).toEqual([{ id: 't-7', kind: 'task', title: 'Order the pump', ref: 't-7', since: at, state: 'in_progress', href: '/p/tasks-preview/task/t-7' }]);
  // With a wider jobs filter Alex is told of a private job, and still not which trigger, though Alex may read that trigger.
  expect(h.as(alex, { jobs: () => sql`true` }).doing('art').items[0]).toMatchObject({ id: 'j-bo', kind: 'private', title: null, href: null, machine: 'one' });
  expect(h.as(house).doing('art').items.map(item => item.id)).toEqual(['t-7', 't-8']);
});

it('refuses to read without a rule for every source, and reads in four statements at most however many rows there are', async () => {
  const h = busy();
  for (const missing of guarded) {
    const rules = { ...sqlVisibility(alex, guarded) } as QueryVisibility; delete rules[missing];
    expect(() => new JobSummaries(h.db, () => rules).doing('art')).toThrow(`SQL visibility required for ${missing}`);
  }
  // A rule that answers with nothing would fall out of the join it guards: that is refused too, not read open.
  for (const empty of guarded) {
    const rules = { ...sqlVisibility(alex, guarded), [empty]: () => undefined } as unknown as QueryVisibility;
    expect(() => new JobSummaries(h.db, () => rules).doing('art')).toThrow(`SQL visibility required for ${empty}`);
  }
  const statements: string[] = [], prepare = h.client.prepare.bind(h.client);
  h.client.prepare = ((source: string) => { statements.push(source); return prepare(source); }) as typeof h.client.prepare;
  h.as(alex).doing('art');
  expect(statements.map(source => /from "(\w+)"/.exec(source)?.[1])).toEqual(['jobs', 'triggers', 'tasks', 'tasks']);
  statements.length = 0; h.db.delete(jobs).where(sql`${jobs.conversation} in ('cv-night','cv-program','cv-sweep')`).run(); statements.length = 0;
  h.as(alex).doing('art'); expect(statements).toHaveLength(3);
  // With no task in progress the count is the only read of tasks.
  statements.length = 0; h.db.delete(tasks).run(); statements.length = 0; h.as(alex).doing('art'); expect(statements).toHaveLength(2);
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: jobSummaryFields(h.as(house)) }) });
  const result = await graphql({ schema, source: '{ agentDoing(agent:"art") { more items { id kind title with place direct ref task quietSince machine since state href } claimed } }' });
  expect(result.errors).toBeUndefined();
  expect((result.data as { agentDoing: { items: Doing[]; claimed: number } }).agentDoing).toMatchObject({ claimed: 0, items: expect.arrayContaining([expect.objectContaining({ kind: 'handoff', task: null, quietSince: null })]) });
});

const ago = (ms: number) => new Date(Date.parse(at) - ms).toISOString();
it('makes a pill only of a task touched in the last eight hours, three at most, and counts every other one it has in progress', () => {
  const h = household();
  for (let n = 0; n < 52; n++) h.task(`t-${100 + n}`, `Claimed long ago ${n}`, { startedAt: ago(5 * 86_400_000), changedAt: ago(taskRecentMs + 60_000 + n * 3_600_000) });
  h.task('t-1', 'Commented an hour ago', { startedAt: ago(5 * 86_400_000), changedAt: ago(3_600_000) });
  h.task('t-2', 'Claimed just now', { changedAt: ago(60_000) });
  const read = h.as(alex).doing('art');
  expect(read.items.map(said)).toEqual([
    { id: 't-2', kind: 'task', title: 'Claimed just now', ref: 't-2', since: ago(60_000), state: 'in_progress', href: '/p/tasks-preview/task/t-2' },
    { id: 't-1', kind: 'task', title: 'Commented an hour ago', ref: 't-1', since: ago(3_600_000), state: 'in_progress', href: '/p/tasks-preview/task/t-1' },
  ]);
  expect(read).toMatchObject({ more: 0, claimed: 52 });
  expect(JSON.stringify(read)).not.toContain('Claimed long ago');
  // The agent's own page asks for the whole list and gets the same two.
  expect(h.as(alex).doing('art', 100)).toMatchObject({ more: 0, claimed: 52, items: { length: 2 } });
  // Five touched recently: the newest three are pills, the other two are counted with the rest.
  for (const n of [3, 4, 5]) h.task(`t-${n}`, `Touched ${n}`, { changedAt: ago(n * 600_000) });
  expect(h.as(alex).doing('art')).toMatchObject({ more: 0, claimed: 54, items: [{ id: 't-2' }, { id: 't-3' }, { id: 't-4' }] });
  // The count is the tasks rule's too: Bo may read none of Art's own tasks, and is told of none.
  expect(h.as(bo).doing('art')).toEqual({ items: [], more: 0, claimed: 0 });
  expect(h.as(house).doing('art')).toMatchObject({ claimed: 54 });
});

it('says a task in the pill of the job whose conversation it was filed from: one pill for the pair', () => {
  const h = household();
  h.talk('cv-pump', 'loom', 'th:pump', 'Repair the garden pump', { member: 'alex' });
  h.job('j-pump', { conversation: 'cv-pump', member: 'alex' });
  // Filed from that conversation long ago, and one more recently; and one filed from a conversation with no job now.
  h.task('t-10', 'Order the pump', { sourceKind: 'conversation', sourceId: 'cv-pump', changedAt: ago(3 * 86_400_000), member: undefined });
  h.task('t-11', 'Measure the hose', { sourceKind: 'conversation', sourceId: 'cv-pump', changedAt: ago(2 * 86_400_000) });
  h.task('t-12', 'Elsewhere', { sourceKind: 'conversation', sourceId: 'cv-gone', changedAt: ago(2 * 86_400_000) });
  const read = h.as(alex).doing('art');
  expect(read.items.map(said)).toEqual([{ id: 'j-pump', kind: 'loom', title: 'Repair the garden pump', with: 'alex', ref: 't-11', task: 'Measure the hose',
    since: at, state: 'running', href: '/p/comms-preview/thread/pump' }]);
  expect(read).toMatchObject({ more: 0, claimed: 2 });
  // Touched now, the paired task is still said once, in the job's pill; another recent one has its own.
  h.db.update(tasks).set({ changedAt: at }).where(sql`${tasks.id} in ('t-11','t-12')`).run();
  expect(h.as(alex).doing('art').items.map(item => [item.id, item.ref])).toEqual([['j-pump', 't-11'], ['t-12', 't-12']]);
  // Whoever may not read the conversation is told of no task through it: with a wider jobs filter the job is private and names nothing.
  const wide = h.as(house, { jobs: () => sql`true` }).doing('art').items.find(item => item.id === 'j-pump');
  expect(wide).toMatchObject({ kind: 'private', ref: null, task: null, title: null, href: null });
  // And whoever reads the conversation but not the task (a project member, of a task that is the agent's own) sees the job alone.
  h.talk('cv-pond', 'discord', '["g","c",null]', 'Discord channel #pond', { project: 'pond' });
  h.job('j-pond', { conversation: 'cv-pond', project: 'pond' });
  h.task('t-13', 'Art’s own', { sourceKind: 'conversation', sourceId: 'cv-pond' });
  expect(h.as(bo).doing('art')).toMatchObject({ claimed: 0, items: [{ id: 'j-pond', ref: null, task: null }] });
  expect(h.as(alex).doing('art').items.find(item => item.id === 'j-pond')).toMatchObject({ ref: 't-13', task: 'Art’s own' });
});

it('never shows a machine’s id for a terminal: the phrase is built from the machine’s name, the harness and the folder', () => {
  const h = household(), id = 'box-7550ce99-1c2d-4e3f-8a9b-0123456789ab';
  h.db.insert(boxes).values({ id, name: 'loom', owner: 'alex', enrolledAt: at, sameMachineAsLoom: true, hostsAny: true, reportOnly: false, alwaysOn: false }).run();
  // A session opened before labels took the machine's name: its label and title hold the id.
  h.talk('cv-old', 'terminal', 'th:old', `${id} · claude`, { member: 'alex' });
  h.job('j-old', { conversation: 'cv-old', member: 'alex', box: id, startedByKind: 'terminal', startedBy: 'alex', title: `${id} · claude` });
  h.db.insert(terminalSessions).values({ job: 'j-old', sessionId: 's-old', machine: id, member: 'alex', agent: 'art', harness: 'claude', cwd: 'C:\\Users\\alex\\Code\\loom\\' }).run();
  // One with no session row at all: the label's parts stand in, less the id.
  h.talk('cv-bare', 'terminal', 'th:bare', `${id} · codex · pond`, { member: 'alex' });
  h.job('j-bare', { conversation: 'cv-bare', member: 'alex', box: id, startedByKind: 'terminal', startedBy: 'alex', title: `${id} · codex · pond`, queuedAt: hour(1), claimedAt: hour(1) });
  const mine = h.as(alex).doing('art');
  expect(mine.items.map(item => [item.id, item.kind, item.machine, item.title])).toEqual([['j-old', 'terminal', 'loom', 'claude · loom'], ['j-bare', 'terminal', 'loom', 'codex · pond']]);
  expect(JSON.stringify(mine)).not.toContain('box-');
  // Somebody who reads the conversation and not the machine gets the harness and folder and no machine. (Only a wider
  // filter makes such a reader: here the conversations rule is opened for Bo, the machines rule is not.)
  const other = h.as(bo, { jobs: () => sql`true`, conversations: () => sql`true` }).doing('art');
  expect(other.items.map(item => [item.kind, item.machine, item.title])).toEqual([['terminal', null, 'claude · loom'], ['terminal', null, 'codex · pond']]);
  expect(JSON.stringify(other)).not.toContain('box-');
});

it('still lists a job the sweep should have ended and has not, last, with when it was last heard from', () => {
  const h = household();
  h.job('j-live', { title: 'Heard just now', queuedAt: hour(1), claimedAt: hour(1) });
  h.job('j-silent', { title: 'Silent for days', queuedAt: '2026-11-14T10:00:00.000Z', claimedAt: '2026-11-14T10:00:05.000Z', heardAt: '2026-11-14T12:00:00.000Z' });
  h.job('j-edge', { title: 'Within the interval', heardAt: ago(SILENCE_MS - 1_000), queuedAt: hour(2), claimedAt: hour(2) });
  h.job('j-waiting', { title: 'Queued today', state: 'queued', claimedAt: null, heardAt: null, queuedAt: ago(QUEUE_DEADLINE_MS - 60_000) });
  h.job('j-unplaced', { title: 'Queued past the deadline', state: 'queued', claimedAt: null, heardAt: null, queuedAt: ago(QUEUE_DEADLINE_MS + 60_000) });
  h.task('t-1', 'A task');
  expect(h.as(alex).doing('art').items.map(item => [item.id, item.state, item.quietSince])).toEqual([
    ['j-edge', 'running', null], ['j-live', 'running', null], ['t-1', 'in_progress', null],
    ['j-silent', 'running', '2026-11-14T12:00:00.000Z'],
  ]);
});

it('counts each requested agent once for visible current work on its card', () => {
  const h = household();
  h.job('later', {state:'queued'});
  h.task('t-8', 'Earlier claim', {changedAt:hour(3)});
  h.job('private', {member:'alex'});
  h.task('t-9', 'Repair', {assignee:'mark'});
  const view = h.as(alex);
  expect(view.agentsAtWork(['art','mark'])).toEqual(['art','mark'].filter(id=>view.doing(id).items.length));
  expect(view.agentsAtWork([])).toEqual([]);
  const hidden = h.as(bo, {jobs:()=>sql`false`,tasks:()=>sql`false`});
  expect(hidden.agentsAtWork(['art','mark'])).toEqual([]);
  h.client.prepare("delete from jobs where id='private'").run();
  expect(view.agentsAtWork(['art'])).toEqual([]);
  h.db.insert(projectMembers).values({project:'pond',member:'alex'}).run();
  h.task('t-10', 'Inspect', {project:'pond'});
  h.db.update(projects).set({retiredAt:at}).run();
  expect(view.agentsAtWork(['art'])).toEqual([]);
  expect(view.doing('art').items).toEqual([]);
  h.db.update(projects).set({retiredAt:null}).run();
  expect(view.agentsAtWork(['art'])).toEqual(['art']);
  h.job('current');
  expect(view.agentsAtWork(['art','art'])).toEqual(['art']);
});
