import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createDataSchema } from '../data/database.js';
import { agents, approvals, changes, inbox, jobs, members, secretRequests, secrets, triggers } from '../data/schema.js';
import { TempoSources } from './sources.js';

it('reports only durable answers and terminal jobs with repeatable namespaced identities', () => {
  const client = new Database(':memory:'), db = createDataSchema(client);
  const events: unknown[][] = [], sources = new TempoSources(db, { event: (...args) => { events.push(args); } });
  const at = '2026-11-14T12:00:00.000Z';
  try {
    db.insert(agents).values({ id: 'art', about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble', faceEyes: 'dot' }).run();
    db.insert(inbox).values({ id: 'same', toKind: 'agent', to: 'art', source: 'notice', fromKind: 'person', state: 'waiting', at, changedAt: at }).run();
    db.insert(approvals).values({ id: 'same', kind: 'command', target: 'test', what: 'test', why: 'test', agent: 'art', askedFrom: 'test', actingFor: 'art', state: 'pending', minutes: 1, ask: 'Run?', ifYes: 'Run', ifNo: 'Stop', details: '', askedAt: at }).run();
    db.insert(members).values({ id: 'jonathan', role: 'owner', joinedAt: at }).run();
    db.insert(secrets).values({ name: 'test', description: '', changedBy: 'jonathan', changedAt: at }).run();
    db.insert(secretRequests).values({ id: 'same', secret: 'test', agent: 'art', why: 'test', state: 'pending', minutes: 1, always: false, askedAt: at }).run();
    db.insert(jobs).values({ id: 'same', agent: 'art', title: 'test', state: 'running', brief: '', model: 'test', startedByKind: 'agent', startedBy: 'art', houseRepository: 'repo', houseFile: 'house', houseBranch: 'main', queuedAt: at }).run();
    sources.question('same'); sources.approval('same'); sources.secret('same'); sources.job('same'); sources.job('missing');
    expect(events).toEqual([]);
    db.update(inbox).set({ answeredAt: at }).where(eq(inbox.id, 'same')).run();
    db.update(approvals).set({ decidedAt: at }).where(eq(approvals.id, 'same')).run();
    db.update(secretRequests).set({ answeredAt: at }).where(eq(secretRequests.id, 'same')).run();
    db.update(jobs).set({ endedAt: at }).where(eq(jobs.id, 'same')).run();
    sources.question('same'); sources.approval('same'); sources.secret('same'); sources.job('same');
    expect(events).toEqual([]);
    db.update(inbox).set({ state: 'answered', answer: 'yes', answeredAt: at }).where(eq(inbox.id, 'same')).run();
    db.update(approvals).set({ state: 'allowed', decidedAt: at }).where(eq(approvals.id, 'same')).run();
    db.update(secretRequests).set({ state: 'allowed', answeredAt: at }).where(eq(secretRequests.id, 'same')).run();
    db.update(jobs).set({ state: 'done', endedAt: at }).where(eq(jobs.id, 'same')).run();
    sources.question('same'); sources.approval('same'); sources.secret('same'); sources.job('same');
    expect(events.map(e => e.slice(0, 2))).toEqual([
      ['answer', 'question:same'], ['answer', 'approval:same'],
      ['answer', 'secret-request:same'], ['job', 'job:same'],
    ]);
    expect(new Set(events.map(e => e[2])).size).toBe(4);
    const first = events.slice();
    for (const [id, sourceKind, watches] of [
      ['a', 'answer', 'approval:same'], ['q', 'answer', 'question:same'],
      ['s', 'answer', 'secret-request:same'], ['j', 'job', 'job:same'],
      ['duplicate', 'answer', 'approval:same'],
      ['wrong-kind', 'job', 'approval:same'], ['missing', 'answer', 'question:missing'],
      ['stopped', 'answer', 'approval:stopped'],
    ] as const) db.insert(triggers).values({ id, sourceKind, watches, ownerKind: 'household', targetKind: 'inbox', toKind: 'agent', to: 'art', lifespan: 'once', note: id, enabled: id !== 'stopped', state: 'standing', createdAt: at, changedAt: at }).run();
    sources.recover();
    expect(events.slice(4)).toEqual([first[1], first[0], first[2], first[3]]);
    events.splice(4);
    db.update(approvals).set({ state: 'used', usedAt: at }).where(eq(approvals.id, 'same')).run();
    db.update(secretRequests).set({ state: 'revoked' }).where(eq(secretRequests.id, 'same')).run();
    sources.question('same'); sources.approval('same'); sources.secret('same'); sources.job('same');
    expect(events.slice(4)).toEqual(first);
    for (const state of ['failed', 'stopped', 'lost'] as const) {
      db.update(jobs).set({ state }).where(eq(jobs.id, 'same')).run();
      const before = events.length; sources.job('same');
      expect(events.length).toBe(before + 1);
      expect(events.at(-1)?.slice(0, 2)).toEqual(['job', 'job:same']);
    }
    db.update(approvals).set({ state: 'denied' }).where(eq(approvals.id, 'same')).run();
    db.update(secretRequests).set({ state: 'denied' }).where(eq(secretRequests.id, 'same')).run();
    const before = events.length; sources.approval('same'); sources.secret('same');
    expect(events.length).toBe(before + 2);
  } finally { client.close(); }
});

it('distinguishes changes at the same source timestamp and repeats an unchanged snapshot', () => {
  const client = new Database(':memory:'), db = createDataSchema(client), events: unknown[][] = [];
  const sources = new TempoSources(db, { event: (...args) => { events.push(args); } });
  const at = '2026-11-14T12:00:00.000Z';
  try {
    db.insert(changes).values({ id: 'pr', repository: 'org/repo', number: 1, title: 'Test', body: '', url: 'https://example.com/1', state: 'open', draft: false, authorLogin: 'art', branch: 'test', headCommit: 'abc', baseBranch: 'main', checks: 'running', review: 'required', mergeable: 'unknown', waitingOn: 'ci', openedAt: at, updatedAt: at }).run();
    sources.change('missing', 'sync-1');
    expect(events).toEqual([]);
    sources.change('pr', 'sync-1'); sources.change('pr', 'sync-1');
    expect(events[0]).toEqual(events[1]);
    db.update(changes).set({ checks: 'passing' }).where(eq(changes.id, 'pr')).run();
    sources.change('pr', 'sync-2');
    expect(events[2].slice(0, 2)).toEqual(['pull-request', 'change:pr']);
    expect(events[2][2]).not.toEqual(events[0][2]);
    db.update(changes).set({ checks: 'running' }).where(eq(changes.id, 'pr')).run();
    sources.change('pr', 'sync-3');
    expect(events[3][2]).not.toEqual(events[0][2]);
    db.insert(triggers).values({ id: 'watch', sourceKind: 'pull-request', watches: 'change:pr', ownerKind: 'household', targetKind: 'operation', target: 'test', lifespan: 'until-stopped', note: 'Change', enabled: true, state: 'standing', createdAt: at, changedAt: at }).run();
    sources.recover();
    sources.recover(() => undefined);
    expect(events).toHaveLength(4);
    sources.recover(id => id === 'pr' ? 'sync-3' : undefined);
    expect(events[4]).toEqual(events[3]);
    expect(() => sources.change('pr', '')).toThrow('durable source revision');
  } finally { client.close(); }
});
