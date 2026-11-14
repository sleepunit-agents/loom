import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDataSchema } from '../core/data/database.js';
import { dataQueries } from '../core/data/queries.js';
import { DataLive } from '../core/data/live.js';
import { DataWrites } from '../core/data/writes.js';
import { workVisibility } from '../core/data/work-visibility.js';
import { taskVisibility } from '../core/data/visibility.js';
import * as s from '../core/data/schema.js';
import { approvalService } from './approvals.js';
import { changeService } from './changes.js';
import { changeAnswers } from './changes-answers.js';
import type { Change } from '../pieces/changes/model.js';
import { approvalsQuery, changesQuery } from '../../web/src/data/work-query.js';

// Composition proof on one disposable shared connection. This deliberately
// does not stand in for the authenticated root or the browser command door.
it('publishes committed merge answers and current heads through the shipped live selections, then removes revoked work', async () => {
  const client = new Database(':memory:');
  const live = new DataLive();
  const at = '2026-11-14T20:00:00.000Z';
  const db = createDataSchema(client, () => at);
  const changed = vi.fn(() => live.changed());
  const writes = new DataWrites(db, { refreshAccess() {}, changed });
  const viewer = { kind: 'member' as const, id: 'sam' };
  const tables = ['approvals', 'approvalRecord', 'approvalRules', 'approvalNotices', 'changes', 'changeChecks', 'changePeople', 'changeTasks', 'changeSync', 'tasks'] as const;
  const schema = dataQueries(client, { tables, visibility: { ...taskVisibility(viewer), ...workVisibility(viewer) } });
  const approvals = approvalService(db, new Map(), () => at);
  const changes = changeService(db, () => ({ tier: 'ask' }), () => at);
  const answers = changeAnswers(db, approvals);
  const a = live.watch({ schema, query: approvalsQuery, valid: () => true });
  const c = live.watch({ schema, query: changesQuery, valid: () => true });
  const read = async (stream: typeof a) => {
    const result = await stream.next();
    expect(result.done).toBe(false);
    return result.value!;
  };
  try {
    db.insert(s.members).values([{ id: 'jonathan', role: 'owner', joinedAt: at }, { id: 'sam', role: 'member', joinedAt: at }]).run();
    db.insert(s.agents).values({ id: 'art', about: '', markBg: '', markFg: '', faceShape: 'pebble', faceEyes: 'dot' }).run();
    db.insert(s.agentAccounts).values({ agent: 'art', service: 'github', login: 'art-bot' }).run();
    db.insert(s.projects).values({ id: 'pond', name: 'Pond' }).run();
    db.insert(s.projectMembers).values({ project: 'pond', member: 'sam' }).run();
    db.insert(s.projectRepositories).values({ project: 'pond', repository: 'acme/app' }).run();
    db.insert(s.tasks).values({ id: 't-1', title: 'Order the pump', ownerKind: 'household', project: 'pond', createdByKind: 'agent', createdBy: 'art', createdAt: at, changedAt: at }).run();
    const pr: Change = { id: 'github:acme/app#3', repo: 'github:acme/app', number: 3, page: '', title: 'Finish t-1', body: '', url: 'https://github.com/acme/app/pull/3', state: 'open', draft: false, author: { login: 'art-bot' }, created: at, updated: at, closed: null, head: { ref: 'pump', id: 'a'.repeat(40) }, base: { ref: 'next' }, checks: { state: 'passing', failing: [], running: [], total: 1 }, review: { state: 'approved', by: [] }, mergeable: 'yes', conflicts: false, people: [] };
    const request = (head: string) => approvals.request({ kind: 'merge', target: `${pr.id}@${head}`, agent: 'art', project: 'pond', what: 'Merge pump script', why: 'Ready', askedFrom: 'loom', actingFor: 'owner', ask: 'Merge this commit?', ifYes: 'Art merges it.', ifNo: 'It stays open.' });
    const first = writes.run(() => { changes.put(pr); return request(pr.head.id); }).value;
    expect((await read(a)).patches[0].value).toMatchObject({ approvals: [{ id: first.id, state: 'pending' }], approvalRecord: [{ event: 'request' }] });
    expect((await read(c)).patches[0].value).toMatchObject({ changes: [{ headCommit: pr.head.id, waitingOn: 'you' }], changeTasks: [{ task: 't-1', taskRow: { title: 'Order the pump' } }] });

    // A nested service transaction is provisional: failure after the answer
    // must restore its record, Inbox delivery and change group, with no signal.
    changed.mockClear();
    const mailBefore = db.select().from(s.inbox).all();
    expect(() => writes.run(() => {
      answers.answer({ change: pr.id, head: pr.head.id, approval: first.id, member: 'jonathan', allow: true });
      throw new Error('receipt could not commit');
    })).toThrow('receipt could not commit');
    expect(changed).not.toHaveBeenCalled();
    expect(approvals.get(first.id).state).toBe('pending');
    expect(approvals.record(first.id).map(row => row.event)).toEqual(['request']);
    expect(db.select().from(s.inbox).all()).toEqual(mailBefore);
    expect(changes.get(pr.id).waitingOn).toBe('you');

    const result = writes.run(() => answers.answer({ change: pr.id, head: pr.head.id, approval: first.id, member: 'jonathan', allow: true }));
    expect(result.notificationErrors).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect((await read(a)).patches).toEqual(expect.arrayContaining([{ path: ['approvals', 0, 'state'], value: 'allowed' }, expect.objectContaining({ path: ['approvalRecord', 1], value: expect.objectContaining({ event: 'allow' }) })]));
    expect((await read(c)).patches).toContainEqual({ path: ['changes', 0, 'waitingOn'], value: 'agent' });

    const pending = writes.run(() => request(pr.head.id)).value;
    expect((await read(a)).patches).toContainEqual(expect.objectContaining({ path: ['approvals', 1], value: expect.objectContaining({ id: pending.id, state: 'pending' }) }));
    const nextHead = 'b'.repeat(40);
    writes.run(() => changes.put({ ...pr, head: { ...pr.head, id: nextHead }, checks: { state: 'running', failing: [], running: ['Typecheck'], total: 1 } }));
    expect((await read(c)).patches).toEqual(expect.arrayContaining([{ path: ['changes', 0, 'headCommit'], value: nextHead }, expect.objectContaining({ path: ['changeChecks', 0], value: expect.objectContaining({ name: 'Typecheck' }) })]));
    changed.mockClear();
    expect(() => writes.run(() => answers.answer({ change: pr.id, head: pr.head.id, approval: pending.id, member: 'jonathan', allow: true }))).toThrow('head has changed');
    expect(changed).not.toHaveBeenCalled();
    expect(approvals.get(pending.id).state).toBe('pending');
    expect(approvals.record(pending.id).map(row => row.event)).toEqual(['request']);

    writes.run(() => db.delete(s.projectMembers).where(eq(s.projectMembers.member, 'sam')).run());
    expect((await read(a)).patches).toEqual(expect.arrayContaining([{ path: ['approvals', 0] }, { path: ['approvalRecord', 1] }, { path: ['approvalRecord', 0] }]));
    expect((await read(c)).patches).toEqual(expect.arrayContaining([{ path: ['changes', 0] }, { path: ['changeChecks', 0] }, { path: ['changePeople', 0] }, { path: ['changeTasks', 0] }]));
  } finally { await a.return!(); await c.return!(); live.close(); client.close(); }
});
