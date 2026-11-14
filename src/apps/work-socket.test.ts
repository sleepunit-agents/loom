import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { eq } from 'drizzle-orm';
import { FakeClock } from '../core/clock.js';
import { createDataSchema } from '../core/data/database.js';
import { dataAuthentication } from '../core/data/authentication.js';
import { dataQueries } from '../core/data/queries.js';
import { dataSocket } from '../core/data/socket.js';
import { DataLive } from '../core/data/live.js';
import { DataWrites } from '../core/data/writes.js';
import { workVisibility } from '../core/data/work-visibility.js';
import { taskVisibility } from '../core/data/visibility.js';
import * as s from '../core/data/schema.js';
import { approvalsQuery, changesQuery } from '../../web/src/data/work-query.js';

// Actual credentials and wire transport, with an explicit disposable composition.
// This does not assert that nextData exposes these tables or browser commands.
it('keeps shipped work selections private and current on an authenticated retained socket', async () => {
  const client = new Database(':memory:');
  const at = '2026-11-14T20:00:00.000Z', clock = new FakeClock(Date.parse(at));
  const db = createDataSchema(client, () => at);
  const token = 's'.repeat(64), fingerprint = createHash('sha256').update(token).digest('hex');
  db.insert(s.members).values(['sam', 'lee', 'owner'].map(id => ({ id, role: id === 'owner' ? 'owner' as const : 'member' as const, joinedAt: at }))).run();
  db.insert(s.agents).values({ id: 'art', about: '', markBg: '', markFg: '', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(s.memberAgents).values({ member: 'sam', agent: 'art' }).run();
  db.insert(s.projects).values({ id: 'pond', name: 'Pond' }).run();
  db.insert(s.projectMembers).values({ project: 'pond', member: 'sam' }).run();
  db.insert(s.tokens).values({ fingerprint, label: 'Disposable Sam token', kind: 'owner', member: 'sam', createdAt: at }).run();
  for (const [id, member] of [['shared', null], ['private', 'lee']] as const) {
    db.insert(s.approvals).values({ id, kind: 'command', target: id, what: id, why: id, agent: 'art', project: 'pond', member, askedFrom: 'test', actingFor: 'unknown', state: 'pending', minutes: 5, ask: id, ifYes: 'yes', ifNo: 'no', details: id, askedAt: at }).run();
    db.insert(s.approvalRecord).values({ seq: id === 'shared' ? 1 : 2, approval: id, agent: 'art', at, event: 'request', note: id }).run();
  }
  db.insert(s.changes).values({ id: 'change', repository: 'house/test', number: 1, title: 'Shared change', body: '', url: '', state: 'open', draft: false, authorLogin: 'art', project: 'pond', agent: 'art', branch: 'work', headCommit: 'a'.repeat(40), baseBranch: 'next', checks: 'running', review: 'required', mergeable: 'unknown', waitingOn: 'ci', openedAt: at, updatedAt: at }).run();
  db.insert(s.changeChecks).values({ change: 'change', name: 'Typecheck', state: 'running' }).run();
  db.insert(s.changePeople).values({ change: 'change', login: 'reviewer', role: 'reviewer' }).run();
  for (const id of ['visible', 'private-task']) db.insert(s.tasks).values({ id, title: id, ownerKind: id === 'visible' ? 'household' : 'member', owner: id === 'visible' ? null : 'lee', project: id === 'visible' ? 'pond' : null, createdByKind: 'agent', createdBy: 'art', createdAt: at, changedAt: at }).run();
  db.insert(s.changeTasks).values(['visible', 'private-task'].map(task => ({ change: 'change', task }))).run();
  const authenticate = dataAuthentication(db, () => clock.now()), live = new DataLive();
  const tables = ['approvals', 'approvalRecord', 'approvalRules', 'approvalNotices', 'changes', 'changeChecks', 'changePeople', 'changeTasks', 'changeSync', 'tasks'] as const;
  const socket = dataSocket({ live, clock, originAllowed: req => !req.headers.origin,
    authenticate: req => authenticate(new Request('http://localhost/graphql', { headers: { authorization: req.headers.authorization ?? '' } })),
    schema: viewer => dataQueries(client, { tables, visibility: { ...taskVisibility(viewer), ...workVisibility(viewer) } }),
  });
  const writes = new DataWrites(db, { refreshAccess: () => socket.refreshAccess(), changed: () => live.changed() });
  const http = createServer(); socket.attach(http);
  const sockets: WebSocket[] = [];
  const receive = async (ws: WebSocket, action: () => void) => { const result = once(ws, 'message'); action(); return JSON.parse(String((await result)[0])); };
  try {
    await new Promise<void>(ok => http.listen(0, '127.0.0.1', ok));
    const address = http.address(); if (!address || typeof address === 'string') throw new Error('No address');
    const url = `ws://127.0.0.1:${address.port}/graphql`;
    const ws = new WebSocket(url, 'graphql-transport-ws', { headers: { authorization: `Bearer ${token}` } }); sockets.push(ws);
    await once(ws, 'open');
    // Token kind and hostile connectionParams cannot impersonate an owner.
    expect(await receive(ws, () => ws.send(JSON.stringify({ type: 'connection_init', payload: { viewer: { kind: 'member', id: 'owner' } } })))).toEqual({ type: 'connection_ack' });
    const observe = (id: string, query: string) => ws.send(JSON.stringify({ type: 'subscribe', id, payload: { query: 'subscription($query:String!){observe(query:$query){revision patches{path removed value}}}', variables: { query } } }));
    const approvals = await receive(ws, () => observe('approvals', approvalsQuery));
    const changes = await receive(ws, () => observe('changes', changesQuery));
    expect(approvals.type).toBe('next'); expect(changes.type).toBe('next');
    const initialApprovals = approvals.payload.data.observe.patches[0].value;
    const initialChanges = changes.payload.data.observe.patches[0].value;
    expect(initialApprovals.approvals.map((row: { id: string }) => row.id)).toEqual(['shared']);
    expect(initialApprovals.approvalRecord.map((row: { approval: string }) => row.approval)).toEqual(['shared']);
    expect(initialChanges.changeTasks.map((row: { task: string }) => row.task)).toEqual(['visible']);
    expect(initialChanges.changes).toHaveLength(1); expect(initialChanges.changeChecks).toHaveLength(1); expect(initialChanges.changePeople).toHaveLength(1);
    // Membership and owned-agent access are independent: removing both empties
    // every retained work/child selection without reconnecting or reauthenticating.
    const revisions = new Promise<Record<string, { path: string[]; removed: boolean }[]>>(ok => {
      const results: Record<string, { path: string[]; removed: boolean }[]> = {};
      const listener = (raw: Buffer) => {
        const message = JSON.parse(String(raw));
        results[message.id] = message.payload.data.observe.patches;
        if (Object.keys(results).length === 2) { ws.off('message', listener); ok(results); }
      };
      ws.on('message', listener);
    });
    writes.run(() => {
      db.delete(s.projectMembers).where(eq(s.projectMembers.member, 'sam')).run();
      db.delete(s.memberAgents).where(eq(s.memberAgents.member, 'sam')).run();
    });
    const revoked = await revisions;
    for (const [id, fields] of [['approvals', ['approvals', 'approvalRecord']], ['changes', ['changes', 'changeChecks', 'changePeople', 'changeTasks']]] as const) {
      expect(revoked[id]).toEqual(expect.arrayContaining(fields.map(field => expect.objectContaining({ path: [field, 0], removed: true }))));
    }
    const closed = once(ws, 'close');
    writes.run(() => db.update(s.tokens).set({ revokedAt: at }).where(eq(s.tokens.fingerprint, fingerprint)).run());
    expect((await closed)[0]).toBe(4403);
    const rejected = new WebSocket(url, 'graphql-transport-ws', { headers: { authorization: `Bearer ${token}` } }); sockets.push(rejected); rejected.on('error', () => {});
    const response = await new Promise<number>(ok => rejected.once('unexpected-response', (_req, res) => { res.resume(); rejected.terminate(); ok(res.statusCode!); }));
    expect(response).toBe(401);
  } finally {
    for (const ws of sockets) ws.terminate();
    await socket.close(); live.close();
    await new Promise<void>(ok => http.close(() => ok())); client.close();
  }
});
