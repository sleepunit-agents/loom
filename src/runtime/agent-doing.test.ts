/** What an agent is doing, as Home's card reads it: each kind from real rows, and who may learn what. */
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { graphql, GraphQLObjectType, GraphQLSchema } from 'graphql/index.js';
import { createDataSchema } from '../core/data/database.js';
import type { QueryVisibility } from '../core/data/queries.js';
import { agents, boxes, conversations, jobs, members, memberAgents, projects, projectAgents, projectMembers, tasks, triggers } from '../core/data/schema.js';
import { conversationPlace, discordPlace } from '../pieces/bridges/place.js';
import { wakePlace } from '../core/tempo/tempo.js';
import { sqlVisibility } from '../policy-sql.js';
import type { Viewer } from '../policy.js';
import { doingCap, JobSummaries, jobSummaryFields, type Doing } from './job-summary.js';

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
  h.job('j-loom', { conversation: 'cv-loom', member: 'alex', title: 'Repair the garden pump', state: 'queued', box: null, queuedAt: hour(14), claimedAt: null });
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
  h.db.delete(jobs).where(sql`${jobs.id} in (${sql.join(first.items.map(item => sql`${item.id}`), sql`, `)})`).run();
  const all = byId([...first.items, ...h.as(alex).doing('art').items]);
  expect(all.get('j-term')).toEqual({ id: 'j-term', kind: 'terminal', title: 'one · claude · loom', machine: 'one', since: hour(9), state: 'running', href: '/p/comms-preview/thread/term' });
  expect(all.get('j-dm')).toEqual({ id: 'j-dm', kind: 'discord', title: 'Discord direct message with alex', with: 'alex', direct: 'person', since: hour(10), state: 'running', href: '/p/comms-preview/conversation/cv-dm' });
  expect(all.get('j-guest')).toEqual({ id: 'j-guest', kind: 'discord', title: 'Discord direct message with 4711', direct: 'person', since: hour(11), state: 'running', href: '/p/comms-preview/conversation/cv-guest' });
  expect(all.get('j-group')).toEqual({ id: 'j-group', kind: 'discord', title: 'Discord group direct message', direct: 'group', since: hour(8), state: 'running', href: '/p/comms-preview/conversation/cv-group' });
  expect(all.get('j-pond')).toEqual({ id: 'j-pond', kind: 'discord', title: 'Discord channel #pond', place: '#pond', since: hour(12), state: 'starting', href: '/p/comms-preview/conversation/cv-pond' });
  // Slack keeps a channel's id and no name, so there is no place to say.
  expect(all.get('j-slack')).toEqual({ id: 'j-slack', kind: 'slack', title: '171.5', since: hour(13), state: 'running', href: '/p/comms-preview/conversation/cv-slack' });
  expect(all.get('j-slack-dm')).toEqual({ id: 'j-slack-dm', kind: 'slack', title: 'D9', with: 'alex', direct: 'person', since: hour(7), state: 'running', href: '/p/comms-preview/conversation/cv-slack-dm' });
  expect(all.get('j-loom')).toEqual({ id: 'j-loom', kind: 'loom', title: 'Repair the garden pump', with: 'alex', since: hour(14), state: 'queued', href: '/p/comms-preview/thread/garden%2F1' });
  expect(all.get('j-night')).toEqual({ id: 'j-night', kind: 'trigger', title: 'Plan the night', machine: 'one', since: hour(15), state: 'running', href: '/p/tempo' });
  expect(all.get('j-program')).toEqual({ id: 'j-program', kind: 'trigger', title: 'Tidy the logs', since: hour(6), state: 'running', href: '/p/tempo' });
  expect(all.get('j-sweep')).toEqual({ id: 'j-sweep', kind: 'wake', title: 'The sweep', since: hour(5), state: 'running', href: '/p/comms-preview/conversation/cv-sweep' });
  expect(all.get('j-hand')).toEqual({ id: 'j-hand', kind: 'handoff', title: 'Check the pump', since: hour(4), state: 'running', href: '/p/comms-preview/conversation/cv-hand' });
  expect(all.get('t-2190')).toEqual({ id: 't-2190', kind: 'task', title: 'Order the pump', ref: 't-2190', since: hour(3), state: 'in_progress', href: '/p/tasks-preview/task/t-2190' });
  expect(all.get('j-plain')).toEqual({ id: 'j-plain', kind: 'job', title: 'Rebuild the index', since: hour(2), state: 'running' });
  expect([...all.keys()].sort()).toEqual(['j-dm', 'j-group', 'j-guest', 'j-hand', 'j-loom', 'j-night', 'j-plain', 'j-pond', 'j-program', 'j-slack', 'j-slack-dm', 'j-sweep', 'j-term', 't-2190']);
});

it('names the agent a hand-off came from only to someone who may read the job it was handed from', () => {
  const h = busy(), hand = (viewer: Viewer) => h.as(viewer).doing('art').items.find(item => item.id === 'j-hand');
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
  expect(h.as(alex).doing('nobody')).toEqual({ items: [], more: 0 });
  // An agent's own page asks for all of it.
  h.db.delete(tasks).run(); for (let n = 0; n < 9; n++) h.task(`t-${n}`, `Task ${n}`);
  expect(h.as(alex).doing('art')).toMatchObject({ more: 7 });
  expect(h.as(alex).doing('art', 100)).toMatchObject({ more: 0, items: { length: 15 } });
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
    expect(read).toEqual({ more: 0, items: [expect.objectContaining({ id: 'j-pond', kind: 'discord', place: '#pond' })] });
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
    for (const item of read.items) expect(item).toEqual({ id: item.id, kind: 'private', title: null, with: null, place: null, direct: null, ref: null, href: null,
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

it('refuses to read without a rule for every source, and reads in three statements however many rows there are', async () => {
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
  expect(statements).toHaveLength(3);
  expect(statements.map(source => /from "(\w+)"/.exec(source)?.[1])).toEqual(['jobs', 'triggers', 'tasks']);
  statements.length = 0; h.db.delete(jobs).where(sql`${jobs.conversation} in ('cv-night','cv-program','cv-sweep')`).run(); statements.length = 0;
  h.as(alex).doing('art'); expect(statements).toHaveLength(2);
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: jobSummaryFields(h.as(house)) }) });
  const result = await graphql({ schema, source: '{ agentDoing(agent:"art") { more items { id kind title with place direct ref machine since state href } } }' });
  expect(result.errors).toBeUndefined();
  expect((result.data as { agentDoing: { items: Doing[] } }).agentDoing.items.map(item => item.kind)).toContain('task');
});
