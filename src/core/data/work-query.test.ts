import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { graphql } from 'graphql/index.js';
import { eq, sql } from 'drizzle-orm';
import { createDataSchema } from './database.js';
import { dataQueries, type QueryVisibility } from './queries.js';
import * as s from './schema.js';
import { approvalsQuery, changesQuery, approvalSnapshot, changeSnapshot, type ApprovalsResult, type ChangesResult } from '../../../web/src/data/work-query.js';

it('executes both shipped selections against the generated schema and current shared rows', async () => {
  const client = new Database(':memory:');
  try {
    const at = '2026-11-14T00:00:00.000Z';
    const db = createDataSchema(client, () => at);
    db.insert(s.members).values({ id: 'sam', role: 'owner', joinedAt: at }).run();
    db.insert(s.agents).values({ id: 'art', about: '', markBg: '', markFg: '', faceShape: 'pebble', faceEyes: 'dot' }).run();
    db.insert(s.approvals).values({ id: 'a-one', kind: 'setting', target: 'measuring.settings', what: 'Change settings', why: 'Keep less', agent: 'art', askedFrom: 'art', actingFor: 'sam', state: 'pending', minutes: 10, ask: 'Keep one day?', ifYes: 'Keep one', ifNo: 'Keep seven', details: '', askedAt: at }).run();
    db.insert(s.approvalRecord).values({ seq: 1, at, event: 'request', approval: 'a-one', agent: 'art', note: 'Requested' }).run();
    db.insert(s.approvalNotices).values({ id: 'n-one', at, agent: 'art', kind: 'command', target: 'fixture', what: 'Reported step' }).run();
    db.insert(s.approvalRules).values({ kind: 'command', scope: 'fixture', tier: 'tell', setBy: 'sam', setAt: at }).run();
    db.insert(s.changes).values({ id: 'c-one', repository: 'acme/app', number: 1, title: 'Current change', body: '', url: 'https://example.test/1', state: 'open', draft: false, authorLogin: 'sam', agent: 'art', branch: 'work', headCommit: 'old-head', baseBranch: 'next', checks: 'running', review: 'required', mergeable: 'unknown', waitingOn: 'ci', openedAt: at, updatedAt: at }).run();
    for (const id of ['t-visible', 't-hidden']) db.insert(s.tasks).values({ id, title: id, ownerKind: 'member', owner: 'sam', createdByKind: 'member', createdBy: 'sam', createdAt: at, changedAt: at }).run();
    db.insert(s.changeTasks).values([{ change: 'c-one', task: 't-visible' }, { change: 'c-one', task: 't-hidden' }]).run();
    db.insert(s.changeChecks).values({ change: 'c-one', name: 'build', state: 'running' }).run();
    db.insert(s.changePeople).values({ change: 'c-one', login: 'sam', role: 'author' }).run();
    db.insert(s.changeSync).values({ failed: false, readAt: at }).run();
    const tables = ['approvals', 'approvalRecord', 'approvalNotices', 'approvalRules', 'changes', 'changeChecks', 'changePeople', 'changeTasks', 'changeSync', 'tasks'] as const;
    const visibility = Object.fromEntries(tables.map(name => [name, () => sql`true`])) as QueryVisibility;
    // This contract fixture exercises a connected endpoint disappearing. Real
    // composition must also apply workVisibility to links and every child table.
    visibility.tasks = fields => eq(fields.id, 't-visible');
    const schema = dataQueries(client, { tables, visibility });
    const approvals = await graphql({ schema, source: approvalsQuery });
    expect(approvals.errors).toBeUndefined();
    const a = approvalSnapshot({ status: 'live', data: approvals.data as unknown as ApprovalsResult }, 'America/Chicago');
    expect(a.approvals[0]).toMatchObject({ id: 'a-one', ask: 'Keep one day?', state: 'pending' });
    expect(a.record[0]).toMatchObject({ approval: 'a-one', note: 'Requested' });
    expect(a.notices[0].what).toBe('Reported step');
    expect(a.rules[0].tier).toBe('tell');
    const readChanges = async () => {
      const result = await graphql({ schema, source: changesQuery });
      expect(result.errors).toBeUndefined();
      return changeSnapshot({ status: 'live', data: result.data as unknown as ChangesResult }, 'America/Chicago');
    };
    const first = await readChanges();
    expect(first.changes[0].headCommit).toBe('old-head');
    expect(first.links).toEqual([{ change: 'c-one', task: 't-visible' }]);
    expect(first.tasks.map(t => t.id)).toEqual(['t-visible']);
    expect(first.checks[0].name).toBe('build');
    expect(first.people[0].login).toBe('sam');
    expect(first.sync).toMatchObject({ failed: false, readAt: at });
    db.update(s.changes).set({ headCommit: 'new-head', checks: 'passing' }).where(eq(s.changes.id, 'c-one')).run();
    db.update(s.approvals).set({ state: 'denied' }).where(eq(s.approvals.id, 'a-one')).run();
    expect((await readChanges()).changes[0]).toMatchObject({ headCommit: 'new-head', checks: 'passing' });
    const answered = await graphql({ schema, source: approvalsQuery });
    expect(answered.errors).toBeUndefined();
    expect((answered.data as unknown as ApprovalsResult).approvals[0].state).toBe('denied');
    for (const status of ['offline', 'denied', 'loading'] as const) {
      expect(approvalSnapshot({ status, data: approvals.data as unknown as ApprovalsResult }, 'UTC')).toMatchObject({ status, approvals: [], rules: [], notices: [], record: [] });
      expect(changeSnapshot({ status, data: { changes: first.changes, changeChecks: first.checks, changePeople: first.people, changeTasks: [], changeSync: first.sync ? [first.sync] : [] } }, 'UTC')).toMatchObject({ status, changes: [], checks: [], people: [], links: [], tasks: [], sync: null });
    }
  } finally { client.close(); }
});
