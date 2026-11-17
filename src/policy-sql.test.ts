/** The two faces of every rule agree: holds() for one row, sqlRule() for a list.
 * Rows are generated from the fields each rule reads, so a new rule or term is covered without a new case. */
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql, type SQL } from 'drizzle-orm';
import { createDataSchema, type DataDatabase } from './core/data/database.js';
import * as s from './core/data/schema.js';
import { holds, rules, tableRules, type ParentLookup, type Row, type Rule, type Viewer } from './policy.js';
import { sqlRule } from './policy-sql.js';
import { sharedSharing } from './shared-sharing.js';
import { sharedQueryTables } from './next-data.js';
import { bridgeSecretsTables } from './core/data/bridge-secrets-visibility.js';

const at = '2026-11-14T00:00:00.000Z';
let client: Database.Database, db: DataDatabase;
const parents = { tasks: s.tasks, approvals: s.approvals, changes: s.changes, conversations: s.conversations, digests: s.digests, triggers: s.triggers, boxes: s.boxes, bridgeConnections: s.bridgeConnections, bridgeIncoming: s.bridgeIncoming, secretRequests: s.secretRequests };
const parentIds: Record<string, string[]> = {};
beforeAll(() => {
  client = new Database(':memory:'); db = createDataSchema(client, () => at);
  db.insert(s.members).values([
    { id: 'owner', role: 'owner', joinedAt: at }, { id: 'full', role: 'owner', fullOwner: true, joinedAt: at },
    { id: 'exowner', role: 'owner', joinedAt: at, removedAt: at },
    { id: 'sam', role: 'member', joinedAt: at }, { id: 'lee', role: 'member', joinedAt: at },
    // Removed, with every link left behind.
    { id: 'gone', role: 'member', joinedAt: at, removedAt: at },
  ]).run();
  db.insert(s.agents).values(['art', 'mark', 'old'].map(id => ({ id, about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble' as const, faceEyes: 'dot' as const, removedAt: id === 'old' ? at : null }))).run();
  db.insert(s.memberAgents).values([['sam', 'art'], ['lee', 'mark'], ['gone', 'art'], ['exowner', 'mark'], ['full', 'art'], ['full', 'mark'], ['full', 'old']].map(([member, agent]) => ({ member, agent }))).run();
  // 'shut' is a removed project with every link left behind: it grants nobody anything.
  db.insert(s.projects).values(['pond', 'side', 'shut'].map(id => ({ id, name: id, removedAt: id === 'shut' ? at : null }))).run();
  db.insert(s.projectMembers).values([['pond', 'sam'], ['pond', 'gone'], ['side', 'lee'], ['shut', 'sam'], ['shut', 'lee']].map(([project, member]) => ({ project, member }))).run();
  db.insert(s.projectAgents).values([['pond', 'art'], ['pond', 'old'], ['side', 'mark'], ['shut', 'art'], ['shut', 'mark']].map(([project, agent]) => ({ project, agent }))).run();
  // A few real parent rows with different labels, for the rules that see a child with its parent.
  const labels = [['p-pond', 'pond', 'mark', null], ['p-agent', 'side', 'art', null], ['p-private', 'pond', 'art', 'lee'], ['p-bare', null, 'mark', null]] as const;
  for (const [id, project, agent, member] of labels) {
    db.insert(s.tasks).values({ id, title: id, project, ownerKind: member ? 'member' : 'agent', owner: member ?? agent, createdByKind: 'agent', createdBy: 'art', createdAt: at, changedAt: at }).run();
    db.insert(s.approvals).values({ id, kind: 'command', target: id, what: id, why: id, agent, project, member, askedFrom: 'test', actingFor: 'unknown', state: 'pending', minutes: 5, ask: id, ifYes: 'yes', ifNo: 'no', details: id, askedAt: at }).run();
    db.insert(s.changes).values({ id, repository: 'house/test', number: labels.findIndex(row => row[0] === id) + 1, title: id, body: id, url: '', state: 'open', draft: false, authorLogin: 'login', project, agent, branch: 'branch', headCommit: 'a'.repeat(40), baseBranch: 'next', checks: 'running', review: 'required', mergeable: 'unknown', waitingOn: 'ci', openedAt: at, updatedAt: at }).run();
    db.insert(s.conversations).values({ id, agent, member, project, venue: 'slack', place: id, label: id, startedAt: at, lastAt: at, turnCount: 0 }).run();
    db.insert(s.digests).values({ id, conversation: id, run: id, revision: 1, at, summary: id }).run();
  }
  // Direct messages on a bridge: from a linked member (private to lee), from a stranger and in a group (no member).
  db.insert(s.conversations).values([['p-dm-lee', 'lee'], ['p-dm-stranger', null]].map(([id, member]) => ({ id: id!, agent: 'mark', member, direct: true, venue: 'discord' as const, place: id!, label: id!, startedAt: at, lastAt: at, turnCount: 0 }))).run();
  db.insert(s.secrets).values({ name: 'token', description: '', changedAt: at, changedBy: 'owner' }).run();
  db.insert(s.secretRequests).values({ id: 'p-asked', secret: 'token', agent: 'art', why: 'test', state: 'pending', minutes: 5, always: false, askedAt: at }).run();
  db.insert(s.bridgeConnections).values({ id: 'p-mark', platform: 'discord', agent: 'mark', workspace: 'w', botUser: 'bot', tokenSecret: 'token', enabled: true, state: 'connected', stateAt: at }).run();
  // A message in a room, in each direct conversation, and held with no conversation (a room message and a direct one).
  for (const [id, conversation, isDm] of [['p-in-room', 'p-bare', false], ['p-in-dm-lee', 'p-dm-lee', true], ['p-in-dm-stranger', 'p-dm-stranger', true], ['p-held-room', null, false], ['p-held-dm', null, true]] as const)
    db.insert(s.bridgeIncoming).values({ id, connection: 'p-mark', channel: 'c', isDm, user: 'u', text: id, postedAt: at, receivedAt: at, state: conversation ? 'delivered' : 'held', conversation }).run();
  const trigger = client.prepare(`INSERT INTO triggers (id,owner_kind,owner,source_kind,lifespan,target_kind,target,to_kind,"to",project,note,enabled,state,created_at,changed_at)
    VALUES (?,?,?,'time','once',?,?,?,?,?,'note',1,'standing',?,?)`);
  for (const row of [['p-pond', 'member', 'lee', 'inbox', null, 'person', 'lee', 'pond'], ['p-agent', 'member', 'lee', 'inbox', null, 'agent', 'art', null],
    ['p-private', 'member', 'sam', 'inbox', null, 'person', 'sam', null], ['p-bare', 'agent', 'mark', 'operation', 'sweep', null, null, null]]) trigger.run(...row, at, at);
  for (const [id, owner] of [['p-sam', 'sam'], ['p-lee', 'lee'], ['p-gone', 'gone']]) db.insert(s.boxes).values({ id, name: id, owner, hostsAny: true, sameMachineAsLoom: false, reportOnly: false, alwaysOn: false, enrolledAt: at, lastSeenAt: at }).run();
  for (const [name, table] of Object.entries(parents)) parentIds[name] = db.select({ id: table.id }).from(table).all().map(row => row.id);
});
afterAll(() => client.close());

const viewers: Viewer[] = [
  ...['owner', 'full', 'exowner', 'sam', 'lee', 'gone', 'ghost'].map(id => ({ kind: 'member' as const, id })),
  ...['art', 'mark', 'old', 'nobody'].map(id => ({ kind: 'agent' as const, id })),
  // Bodies working for a member: one who owns the agent and shares its project (sam), one who does neither
  // (lee), the owner role without the agent, a full owner, someone removed with every link left, nobody
  // known, and a body of a removed agent.
  ...[['art', 'sam'], ['art', 'lee'], ['art', 'owner'], ['art', 'full'], ['art', 'gone'], ['art', 'ghost'], ['mark', 'lee'], ['mark', 'exowner'], ['old', 'full']]
    .map(([id, workingFor]) => ({ kind: 'agent' as const, id, workingFor })),
  // Workers and installed services read no list: both faces say no.
  { kind: 'runner', id: 'sam' }, { kind: 'service', id: 'owner' },
];
const memberIds = ['owner', 'exowner', 'sam', 'lee', 'gone', 'ghost'], agentIds = ['art', 'mark', 'old', 'nobody'];

/** Every value worth trying for each field a rule reads. */
function domains(rule: Rule, found = new Map<string, Set<string | null>>()): Map<string, Set<string | null>> {
  const add = (field: string, values: readonly (string | null)[]) => { const have = found.get(field) ?? new Set([null]); for (const value of values) have.add(value); found.set(field, have); };
  switch (rule.is) {
    case 'self': add(rule.field, memberIds); break;
    case 'names': add(rule.field, rule.kind === 'member' ? memberIds : agentIds); break;
    case 'inProject': add(rule.field, ['pond', 'side', 'shut', 'nowhere']); break;
    case 'ownsAgent': case 'sharesProjectWithAgent': add(rule.field, agentIds); break;
    case 'equal': add(rule.field, [rule.value, 'something-else']); break;
    case 'set': add(rule.field, []); break;
    case 'seenWith': add(rule.field, [...parentIds[rule.table], 'missing']); break; // The parent's own fields are real rows, not generated.
    case 'forItsMember': domains(rule.rule, found); break;
    case 'any': case 'all': for (const part of rule.of) domains(part, found); break;
    case 'first': for (const [when, then] of rule.cases) { domains(when, found); domains(then, found); } domains(rule.otherwise, found); break;
    default: break;
  }
  return found;
}
const MOST_ROWS = 40_000;
function rows(rule: Rule): Row[] {
  let out: Record<string, string | null>[] = [{}];
  for (const [field, values] of domains(rule)) {
    const tried = values.size > 1 ? [...values] : [null, 'x'];
    out = out.flatMap(row => tried.map(value => ({ ...row, [field]: value })));
  }
  // A rule made of two large parts (the inbox rule) has more combinations than is worth walking, and each
  // part is in the matrix whole under its own name. Such a rule is tried on an even spread of its rows,
  // which must still meet every value of every field.
  if (out.length > MOST_ROWS) {
    const stride = Math.ceil(out.length / MOST_ROWS) | 1; out = out.filter((_, index) => index % stride === 0);
    for (const [field, values] of domains(rule)) if (values.size > 1) expect(new Set(out.map(row => row[field])), field).toEqual(values);
  }
  return out;
}
const lookup: ParentLookup = (table, id) => db.select().from(parents[table]).where(eq(parents[table].id, id)).get();

const named: [string, Rule][] = [...Object.entries(tableRules), ['inboxVolume', rules.inboxVolume], ['labelled', rules.labelled], ['inTalk', rules.inTalk], ['waitsOnReadable', rules.waitsOnReadable], ['answers', rules.answers],
  ['stopJob', rules.stopJob], ['agentItself', rules.agentItself], ['asksSignIn', rules.asksSignIn], ['currentMember', rules.currentMember], ['currentViewer', rules.currentViewer], ['project', rules.project], ['moveTask', rules.moveTask], ['asksToJoin', rules.asksToJoin]];
describe.each(named)('rule %s', (_name, rule) => {
  it('gives the same answer as a predicate and as a SQL filter, for every viewer and row', () => {
    const candidates = rows(rule), sharing = sharedSharing(db), seen = new Set<boolean>();
    const fields = Object.fromEntries(Object.keys(candidates[0]).map(field => [field, sql.raw(`json_extract(matrix.value, '$.${field}')`)])) as Record<string, SQL>;
    for (const viewer of viewers) {
      const listed = db.all<{ n: number; allowed: number }>(sql`select matrix.key as n, (${sqlRule(rule, viewer, fields)}) as allowed from json_each(${JSON.stringify(candidates)}) as matrix`);
      expect(listed).toHaveLength(candidates.length);
      const differing = listed.filter(({ n, allowed }) => {
        const answer = holds(rule, viewer, candidates[n], sharing, lookup);
        seen.add(answer);
        // The filter must be exactly 0 or 1: a NULL would read as "no" in a where clause but flip under "not".
        return allowed !== (answer ? 1 : 0);
      }).map(({ n, allowed }) => ({ viewer, row: candidates[n], sql: allowed }));
      expect(differing.slice(0, 5)).toEqual([]);
    }
    // The matrix reaches both answers, so agreement is not an accident of always saying no.
    expect([...seen].sort()).toEqual([false, true]);
  });
});

it('has a rule for every table the shared query door serves', () => {
  expect([...sharedQueryTables, ...bridgeSecretsTables].filter(name => !Object.hasOwn(tableRules, name))).toEqual([]);
});

describe('whose a conversation is', () => {
  const sees = (viewer: Viewer, row: Row) => {
    const answer = holds(rules.conversation, viewer, row, sharedSharing(db));
    // The list face must say the same, on the same facts.
    const fields = Object.fromEntries(Object.keys(row).map(field => [field, sql.raw(`json_extract(matrix.value, '$.${field}')`)])) as Record<string, SQL>;
    expect(db.all<{ allowed: number }>(sql`select (${sqlRule(rules.conversation, viewer, fields)}) as allowed from json_each(${JSON.stringify([row])}) as matrix`)[0].allowed).toBe(answer ? 1 : 0);
    return answer;
  };
  const member = (id: string): Viewer => ({ kind: 'member', id }), agent = (id: string): Viewer => ({ kind: 'agent', id });
  it('keeps a member\'s private thread from everyone else, a household owner and a full owner included', () => {
    const thread = { member: 'lee', agent: 'mark', project: 'side', direct: false };
    expect(sees(member('lee'), thread)).toBe(true);
    // The owner role, a full owner who also owns the agent, another member, and the agent's own token.
    for (const other of [member('owner'), member('full'), member('sam'), agent('mark')]) expect(sees(other, thread)).toBe(false);
    // Once its member has left the household it is nobody's.
    expect(sees(member('gone'), { ...thread, member: 'gone' })).toBe(false);
    expect(sees(member('owner'), { ...thread, member: 'gone' })).toBe(false);
  });
  it('gives a direct message with no member to the members who own the agent, and not to the agent\'s own token', () => {
    const stranger = { member: null, agent: 'mark', project: null, direct: true };
    expect(sees(member('lee'), stranger)).toBe(true);
    expect(sees(member('full'), stranger)).toBe(true);
    // The owner role alone does not own the agent; the agent's token would hand the words to a body in a public room.
    for (const other of [member('owner'), member('sam'), member('exowner'), agent('mark'), agent('art')]) expect(sees(other, stranger)).toBe(false);
    // A linked member's direct message is private to that member like any thread of theirs.
    expect(sees(member('lee'), { ...stranger, member: 'lee' })).toBe(true);
    expect(sees(member('full'), { ...stranger, member: 'lee' })).toBe(false);
    // A room is still read by the household owner, the agent's owners and the agent.
    for (const other of [member('owner'), member('lee'), agent('mark')]) expect(sees(other, { ...stranger, direct: false })).toBe(true);
  });
});

describe('an inbox item that waits on a record', () => {
  const sees = (viewer: Viewer, item: Row) => holds(tableRules.inbox, viewer, item, sharedSharing(db), lookup);
  it('is seen only by someone who may read that record, whoever the item is addressed to', () => {
    // A question to lee in the open, about a task. p-pond is a task in the pond project, which lee is not in.
    const question = { toKind: 'person', to: 'lee', member: null, project: 'side', agent: 'mark', conversation: null };
    expect(sees({ kind: 'member', id: 'lee' }, { ...question, waitsOnKind: null, waitsOnId: null })).toBe(true);
    expect(sees({ kind: 'member', id: 'lee' }, { ...question, waitsOnKind: 'task', waitsOnId: 'p-agent' })).toBe(true);
    expect(sees({ kind: 'member', id: 'lee' }, { ...question, waitsOnKind: 'task', waitsOnId: 'p-pond' })).toBe(false);
    expect(sees({ kind: 'member', id: 'lee' }, { ...question, waitsOnKind: 'task', waitsOnId: 'missing' })).toBe(false);
    // An approval card by its labels; a secret request is the household owners'.
    expect(sees({ kind: 'member', id: 'lee' }, { ...question, waitsOnKind: 'approval', waitsOnId: 'p-pond' })).toBe(true);
    expect(sees({ kind: 'member', id: 'sam' }, { ...question, to: 'sam', project: 'pond', agent: 'art', waitsOnKind: 'approval', waitsOnId: 'p-bare' })).toBe(false);
    expect(sees({ kind: 'member', id: 'lee' }, { ...question, waitsOnKind: 'secret-request', waitsOnId: 'p-asked' })).toBe(false);
    expect(sees({ kind: 'member', id: 'owner' }, { ...question, to: 'owner', waitsOnKind: 'secret-request', waitsOnId: 'p-asked' })).toBe(true);
    // A kind with no record named, or a record with no kind, is seen by nobody.
    expect(sees({ kind: 'member', id: 'lee' }, { ...question, waitsOnKind: 'task', waitsOnId: null })).toBe(false);
    expect(sees({ kind: 'member', id: 'lee' }, { ...question, waitsOnKind: null, waitsOnId: 'p-agent' })).toBe(false);
  });
});

describe('who answers an inbox item', () => {
  const answers = (viewer: Viewer, item: Row) => holds(rules.answers, viewer, item, sharedSharing(db));
  it('is the person it is addressed to, and nobody on their behalf', () => {
    const question = { toKind: 'person', to: 'lee' };
    expect(answers({ kind: 'member', id: 'lee' }, question)).toBe(true);
    // Setting how loudly it arrives may be done for someone by a household owner; answering may not.
    expect(holds(rules.inboxVolume, { kind: 'member', id: 'owner' }, question, sharedSharing(db))).toBe(true);
    for (const other of [{ kind: 'member', id: 'owner' }, { kind: 'member', id: 'full' }, { kind: 'member', id: 'sam' }, { kind: 'agent', id: 'lee' }] as Viewer[]) expect(answers(other, question)).toBe(false);
    // Mail to an agent is not a person's to answer, even one with the same id; and someone removed answers nothing.
    expect(answers({ kind: 'member', id: 'lee' }, { toKind: 'agent', to: 'lee' })).toBe(false);
    expect(answers({ kind: 'member', id: 'gone' }, { toKind: 'person', to: 'gone' })).toBe(false);
    // A body is not its member: working for the addressee does not make it the one who answers.
    expect(answers({ kind: 'agent', id: 'art', workingFor: 'lee' }, question)).toBe(false);
  });
});

describe('a body working for a member', () => {
  const both = (rule: Rule, viewer: Viewer, row: Row) => {
    const answer = holds(rule, viewer, row, sharedSharing(db), lookup);
    const fields = Object.fromEntries(Object.keys(row).map(field => [field, sql.raw(`json_extract(matrix.value, '$.${field}')`)])) as Record<string, SQL>;
    expect(db.all<{ allowed: number }>(sql`select (${sqlRule(rule, viewer, fields)}) as allowed from json_each(${JSON.stringify([row])}) as matrix`)[0].allowed).toBe(answer ? 1 : 0);
    return answer;
  };
  const body = (id: string, workingFor: string): Viewer => ({ kind: 'agent', id, workingFor });
  const art: Viewer = { kind: 'agent', id: 'art' };
  it('gives nobody anything through a removed project, though every link to it is still there', () => {
    // sam and lee are members of shut, art and mark are agents in it, and shut is removed.
    const task = { project: 'shut', ownerKind: 'agent', owner: 'mark' };
    for (const viewer of [{ kind: 'member', id: 'sam' }, { kind: 'member', id: 'lee' }, art, body('art', 'sam'), { kind: 'agent', id: 'mark' }] as Viewer[]) {
      expect(both(rules.task, viewer, { ...task, owner: 'nobody' }), JSON.stringify(viewer)).toBe(false);
      for (const rule of [tableRules.changes, rules.conversation, tableRules.projects])
        expect(both(rule, viewer, { id: 'shut', project: 'shut', agent: 'old', member: null, direct: false }), JSON.stringify(viewer)).toBe(false);
    }
    // A household owner still sees what was in it.
    expect(both(tableRules.changes, { kind: 'member', id: 'owner' }, { id: 'shut', project: 'shut', agent: 'old', member: null, direct: false })).toBe(true);
    // Sharing a removed project with an agent is not sharing a project with it: sam has art, not mark.
    expect(both(tableRules.agentStatus, { kind: 'member', id: 'sam' }, { agent: 'mark' })).toBe(false);
  });
  it('reaches a project only while its member is in it too, or is a household owner', () => {
    // art is in pond; sam is, lee is not, owner has the role. mark is in side with lee.
    const pondTask = { project: 'pond', ownerKind: 'member', owner: 'sam' }, sideTask = { project: 'side', ownerKind: 'agent', owner: 'mark' };
    expect(both(rules.task, art, pondTask)).toBe(true);
    expect(both(rules.task, body('art', 'sam'), pondTask)).toBe(true);
    expect(both(rules.task, body('art', 'lee'), pondTask)).toBe(false);
    expect(both(rules.task, body('art', 'owner'), pondTask)).toBe(true);
    expect(both(rules.task, body('mark', 'lee'), sideTask)).toBe(true);
    // The same for every record shared by project: a change, a room, the roster of agents in it.
    for (const rule of [tableRules.changes, rules.conversation, tableRules.projects]) {
      const row = { id: 'pond', project: 'pond', agent: 'mark', member: null, direct: false };
      expect(both(rule, art, row)).toBe(true);
      expect(both(rule, body('art', 'sam'), row)).toBe(true);
      expect(both(rule, body('art', 'lee'), row)).toBe(false);
    }
    expect(both(tableRules.agents, art, { id: 'old' })).toBe(true);
    expect(both(tableRules.agents, body('art', 'lee'), { id: 'old' })).toBe(false);
  });
  it('is the agent a record names only while its member has that agent on their own list', () => {
    const own = { project: null, ownerKind: 'agent', owner: 'art' };
    expect(both(rules.task, body('art', 'sam'), own)).toBe(true);
    // lee does not own art; the owner role alone does not either; a full owner does.
    expect(both(rules.task, body('art', 'lee'), own)).toBe(false);
    expect(both(rules.task, body('art', 'owner'), own)).toBe(false);
    expect(both(rules.task, body('art', 'full'), own)).toBe(true);
    expect(both(rules.agentItself, body('art', 'sam'), { agent: 'art' })).toBe(true);
    expect(both(rules.agentItself, body('art', 'lee'), { agent: 'art' })).toBe(false);
    expect(both(rules.agentItself, body('art', 'sam'), { agent: 'mark' })).toBe(false);
  });
  it('reaches nothing once its member has left the household, whatever links they left behind', () => {
    for (const gone of [body('art', 'gone'), body('art', 'ghost'), body('mark', 'exowner')]) {
      expect(both(rules.currentViewer, gone, {})).toBe(false);
      expect(both(rules.task, gone, { project: 'pond', ownerKind: 'agent', owner: 'art' })).toBe(false);
      expect(both(rules.task, gone, { project: null, ownerKind: 'agent', owner: gone.id })).toBe(false);
      expect(both(tableRules.timingDays, gone, {})).toBe(false);
    }
  });
  it('never becomes its member: nothing that is the member\'s own, and nothing of the owner role', () => {
    expect(both(rules.task, body('art', 'sam'), { project: null, ownerKind: 'member', owner: 'sam' })).toBe(false);
    expect(both(rules.conversation, body('art', 'sam'), { member: 'sam', agent: 'art', project: 'pond', direct: false })).toBe(false);
    expect(both(rules.householdOwner, body('art', 'full'), {})).toBe(false);
    expect(both(tableRules.secrets, body('art', 'full'), {})).toBe(false);
    expect(both(rules.stopJob, body('art', 'full'), { agent: 'art' })).toBe(false);
  });
  it('sets the volume of its member\'s own mail on that member\'s word, and of nobody else\'s', () => {
    const to = (id: string) => ({ toKind: 'person', to: id });
    expect(both(rules.inboxVolume, body('art', 'sam'), to('sam'))).toBe(true);
    expect(both(rules.inboxVolume, body('art', 'sam'), to('lee'))).toBe(false);
    // The agent alone cannot, and neither can a body whose member does not have the agent.
    expect(both(rules.inboxVolume, art, to('sam'))).toBe(false);
    expect(both(rules.inboxVolume, body('art', 'lee'), to('lee'))).toBe(false);
    expect(both(rules.inboxVolume, body('art', 'gone'), to('gone'))).toBe(false);
    // A full owner may address any person, so a body working for one may set that person's volume too.
    expect(both(rules.inboxVolume, body('art', 'full'), to('lee'))).toBe(true);
  });
});

describe('moving a task to another project', () => {
  const sharing = () => sharedSharing(db);
  // A task's labels now, and `to`: the project it would go to, or null for none.
  const moves = (viewer: Viewer, row: Row) => {
    const answer = holds(rules.moveTask, viewer, row, sharing());
    const fields = Object.fromEntries(Object.keys(row).map(field => [field, sql.raw(`json_extract(matrix.value, '$.${field}')`)])) as Record<string, SQL>;
    expect(db.all<{ allowed: number }>(sql`select (${sqlRule(rules.moveTask, viewer, fields)}) as allowed from json_each(${JSON.stringify([row])}) as matrix`)[0].allowed).toBe(answer ? 1 : 0);
    return answer;
  };
  const member = (id: string): Viewer => ({ kind: 'member', id }), agent = (id: string, workingFor?: string): Viewer => ({ kind: 'agent', id, ...(workingFor ? { workingFor } : {}) });
  it('needs the mover to act on the task where it is and to be someone who could file work where it goes', () => {
    // sam and art are in pond; lee and mark are in side; owner has the role and is in neither.
    const inPond = { project: 'pond', ownerKind: 'member', owner: 'lee' }, samsOwn = { project: null, ownerKind: 'member', owner: 'sam' };
    // In the task's project and not in the destination: no. In the destination and not able to act on the task: no.
    expect(moves(member('sam'), { ...inPond, to: 'side' })).toBe(false);
    expect(moves(member('lee'), { ...inPond, to: 'side' })).toBe(false);
    expect(moves(member('owner'), { ...inPond, to: 'side' })).toBe(true);
    // One's own task into a project one is in; not into one somebody else is in.
    expect(moves(member('sam'), { ...samsOwn, to: 'pond' })).toBe(true);
    expect(moves(member('sam'), { ...samsOwn, to: 'side' })).toBe(false);
    expect(moves(member('lee'), { ...samsOwn, to: 'side' })).toBe(false);
    // An agent on both sides of the move, and a body that reaches no further than its member.
    const artsOwn = { project: null, ownerKind: 'agent', owner: 'art' };
    expect(moves(agent('art'), { ...artsOwn, to: 'pond' })).toBe(true);
    expect(moves(agent('art'), { ...artsOwn, to: 'side' })).toBe(false);
    expect(moves(agent('art', 'sam'), { ...artsOwn, to: 'pond' })).toBe(true);
    expect(moves(agent('art', 'lee'), { ...artsOwn, to: 'pond' })).toBe(false);
    // A removed project is nobody's destination but a household owner's, and the door refuses it to them too.
    expect(moves(member('sam'), { ...samsOwn, to: 'shut' })).toBe(false);
    // Someone removed, a worker and a service move nothing.
    for (const nobody of [member('gone'), member('exowner'), { kind: 'runner', id: 'sam' }, { kind: 'service', id: 'owner' }] as Viewer[]) expect(moves(nobody, { ...inPond, to: 'pond' })).toBe(false);
  });
  it('lets only the task\'s owner or a household owner take it out of every project', () => {
    // Out of its project a task is its owner's alone, so being in the project is not enough.
    const leesInPond = { project: 'pond', ownerKind: 'member', owner: 'lee', to: null }, samsInPond = { ...leesInPond, owner: 'sam' };
    expect(moves(member('sam'), leesInPond)).toBe(false);
    expect(moves(member('sam'), samsInPond)).toBe(true);
    expect(moves(member('owner'), leesInPond)).toBe(true);
    // lee owns it and cannot act on it where it is: pond is not lee's project.
    expect(moves(member('lee'), leesInPond)).toBe(false);
    // An agent's task: the agent, and the members who have that agent. Not another agent in the project.
    const artsInPond = { project: 'pond', ownerKind: 'agent', owner: 'art', to: null };
    expect(moves(agent('art'), artsInPond)).toBe(true);
    expect(moves(member('sam'), artsInPond)).toBe(true);
    expect(moves(agent('old'), artsInPond)).toBe(false);
    expect(moves(member('sam'), { ...artsInPond, owner: 'mark' })).toBe(false);
    // The household's own task has no owner to be alone with: a household owner only.
    expect(moves(member('sam'), { project: 'pond', ownerKind: 'household', owner: null, to: null })).toBe(false);
    expect(moves(member('owner'), { project: 'pond', ownerKind: 'household', owner: null, to: null })).toBe(true);
  });
});

describe('asking for an agent to be let onto a project', () => {
  it('is for the agent itself, about itself, and for a household owner about any agent', () => {
    const asks = (viewer: Viewer, agent: string) => {
      const answer = holds(rules.asksToJoin, viewer, { agent }, sharedSharing(db));
      expect(db.all<{ allowed: number }>(sql`select (${sqlRule(rules.asksToJoin, viewer, { agent: sql`${agent}` })}) as allowed`)[0].allowed).toBe(answer ? 1 : 0);
      return answer;
    };
    expect(asks({ kind: 'agent', id: 'art' }, 'art')).toBe(true);
    expect(asks({ kind: 'agent', id: 'art' }, 'mark')).toBe(false);
    // A body asks for its agent while its member has that agent; a removed agent asks for nothing.
    expect(asks({ kind: 'agent', id: 'art', workingFor: 'sam' }, 'art')).toBe(true);
    expect(asks({ kind: 'agent', id: 'art', workingFor: 'lee' }, 'art')).toBe(false);
    expect(asks({ kind: 'agent', id: 'old' }, 'old')).toBe(false);
    // A household owner for any agent. A member who has the agent is not thereby one; nor is someone removed.
    for (const agent of ['art', 'mark']) expect(asks({ kind: 'member', id: 'owner' }, agent)).toBe(true);
    for (const member of ['sam', 'lee', 'exowner', 'gone']) expect(asks({ kind: 'member', id: member }, 'art'), member).toBe(false);
  });
});

describe('ending a job by hand', () => {
  it('is for a household owner and the members who own its agent, and reads nothing of the job', () => {
    const sharing = () => sharedSharing(db);
    const privateJob = { agent: 'mark', member: 'lee', project: 'side', conversation: null };
    for (const [id, stops, lists] of [['owner', true, false], ['full', true, false], ['lee', true, true], ['sam', false, false], ['exowner', false, false]] as const) {
      const viewer: Viewer = { kind: 'member', id };
      expect(holds(rules.stopJob, viewer, privateJob, sharing()), id).toBe(stops);
      expect(holds(tableRules.jobs, viewer, privateJob, sharing(), lookup), id).toBe(lists);
    }
    expect(holds(rules.stopJob, { kind: 'agent', id: 'mark' }, privateJob, sharing())).toBe(false);
  });
});
