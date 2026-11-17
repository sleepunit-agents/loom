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
const parents = { tasks: s.tasks, approvals: s.approvals, changes: s.changes, conversations: s.conversations, digests: s.digests, triggers: s.triggers, boxes: s.boxes };
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
  db.insert(s.projects).values(['pond', 'side'].map(id => ({ id, name: id }))).run();
  db.insert(s.projectMembers).values([['pond', 'sam'], ['pond', 'gone'], ['side', 'lee']].map(([project, member]) => ({ project, member }))).run();
  db.insert(s.projectAgents).values([['pond', 'art'], ['pond', 'old'], ['side', 'mark']].map(([project, agent]) => ({ project, agent }))).run();
  // A few real parent rows with different labels, for the rules that see a child with its parent.
  const labels = [['p-pond', 'pond', 'mark', null], ['p-agent', 'side', 'art', null], ['p-private', 'pond', 'art', 'lee'], ['p-bare', null, 'mark', null]] as const;
  for (const [id, project, agent, member] of labels) {
    db.insert(s.tasks).values({ id, title: id, project, ownerKind: member ? 'member' : 'agent', owner: member ?? agent, createdByKind: 'agent', createdBy: 'art', createdAt: at, changedAt: at }).run();
    db.insert(s.approvals).values({ id, kind: 'command', target: id, what: id, why: id, agent, project, member, askedFrom: 'test', actingFor: 'unknown', state: 'pending', minutes: 5, ask: id, ifYes: 'yes', ifNo: 'no', details: id, askedAt: at }).run();
    db.insert(s.changes).values({ id, repository: 'house/test', number: labels.findIndex(row => row[0] === id) + 1, title: id, body: id, url: '', state: 'open', draft: false, authorLogin: 'login', project, agent, branch: 'branch', headCommit: 'a'.repeat(40), baseBranch: 'next', checks: 'running', review: 'required', mergeable: 'unknown', waitingOn: 'ci', openedAt: at, updatedAt: at }).run();
    db.insert(s.conversations).values({ id, agent, member, project, venue: 'slack', place: id, label: id, startedAt: at, lastAt: at, turnCount: 0 }).run();
    db.insert(s.digests).values({ id, conversation: id, run: id, revision: 1, at, summary: id }).run();
  }
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
    case 'inProject': add(rule.field, ['pond', 'side', 'nowhere']); break;
    case 'ownsAgent': case 'sharesProjectWithAgent': add(rule.field, agentIds); break;
    case 'equal': add(rule.field, [rule.value, 'something-else']); break;
    case 'set': add(rule.field, []); break;
    case 'seenWith': add(rule.field, [...parentIds[rule.table], 'missing']); break;
    case 'any': case 'all': for (const part of rule.of) domains(part, found); break;
    case 'first': for (const [when, then] of rule.cases) { domains(when, found); domains(then, found); } domains(rule.otherwise, found); break;
    default: break;
  }
  return found;
}
function rows(rule: Rule): Row[] {
  let out: Record<string, string | null>[] = [{}];
  for (const [field, values] of domains(rule)) {
    const tried = values.size > 1 ? [...values] : [null, 'x'];
    out = out.flatMap(row => tried.map(value => ({ ...row, [field]: value })));
  }
  return out;
}
const lookup: ParentLookup = (table, id) => db.select().from(parents[table]).where(eq(parents[table].id, id)).get();

const named: [string, Rule][] = [...Object.entries(tableRules), ['inboxVolume', rules.inboxVolume], ['labelled', rules.labelled]];
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

it('has a rule for every table the shared query door serves, apart from the bridge and secret tables', () => {
  const others = new Set<string>(bridgeSecretsTables);
  expect(sharedQueryTables.filter(name => !others.has(name) && !Object.hasOwn(tableRules, name))).toEqual([]);
});
