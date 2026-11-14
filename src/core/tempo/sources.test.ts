import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createDataSchema } from '../data/database.js';
import { agents, approvals, changes, inbox, jobs, members, secretRequests, secrets } from '../data/schema.js';
import { TempoSources, tempoWatch } from './sources.js';

it('reports only durable answers and terminal jobs with repeatable namespaced identities', () => {
  const client = new Database(':memory:'), db = createDataSchema(client);
  const events: unknown[][] = [], sources = new TempoSources(db, { event: (...args) => { events.push(args); } });
  const at = '2026-11-14T12:00:00.000Z';
  try {
    db.insert(agents).values({ id: 'art', about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble', faceEyes: 'dot' }).run();
    db.insert(inbox).values({ id: 'q', toKind: 'agent', to: 'art', source: 'notice', fromKind: 'person', state: 'waiting', at, changedAt: at }).run();
    db.insert(approvals).values({ id: 'a', kind: 'command', target: 'test', what: 'test', why: 'test', agent: 'art', askedFrom: 'test', actingFor: 'art', state: 'pending', minutes: 1, ask: 'Run?', ifYes: 'Run', ifNo: 'Stop', details: '', askedAt: at }).run();
    db.insert(members).values({ id: 'jonathan', role: 'owner', joinedAt: at }).run();
    db.insert(secrets).values({ name: 'test', description: '', changedBy: 'jonathan', changedAt: at }).run();
    db.insert(secretRequests).values({ id: 's', secret: 'test', agent: 'art', why: 'test', state: 'pending', minutes: 1, always: false, askedAt: at }).run();
    db.insert(jobs).values({ id: 'j', agent: 'art', title: 'test', state: 'running', brief: '', model: 'test', startedByKind: 'agent', startedBy: 'art', houseRepository: 'repo', houseFile: 'house', houseBranch: 'main', queuedAt: at }).run();
    sources.question('q'); sources.approval('a'); sources.secret('s'); sources.job('j'); sources.job('missing');
    expect(events).toEqual([]);
    db.update(inbox).set({ state: 'answered', answer: 'yes', answeredAt: at }).where(eq(inbox.id, 'q')).run();
    db.update(approvals).set({ state: 'allowed', decidedAt: at }).where(eq(approvals.id, 'a')).run();
    db.update(secretRequests).set({ state: 'allowed', answeredAt: at }).where(eq(secretRequests.id, 's')).run();
    db.update(jobs).set({ state: 'done', endedAt: at }).where(eq(jobs.id, 'j')).run();
    sources.question('q'); sources.approval('a'); sources.secret('s'); sources.job('j');
    expect(events.map(e => e.slice(0, 2))).toEqual([
      ['answer', tempoWatch.question('q')], ['answer', tempoWatch.approval('a')],
      ['answer', tempoWatch.secret('s')], ['job', tempoWatch.job('j')],
    ]);
    const first = events.slice();
    db.update(approvals).set({ state: 'used', usedAt: at }).where(eq(approvals.id, 'a')).run();
    db.update(secretRequests).set({ state: 'revoked' }).where(eq(secretRequests.id, 's')).run();
    sources.question('q'); sources.approval('a'); sources.secret('s'); sources.job('j');
    expect(events.slice(4)).toEqual(first);
  } finally { client.close(); }
});

it('distinguishes changes at the same source timestamp and repeats an unchanged snapshot', () => {
  const client = new Database(':memory:'), db = createDataSchema(client), events: unknown[][] = [];
  const sources = new TempoSources(db, { event: (...args) => { events.push(args); } });
  const at = '2026-11-14T12:00:00.000Z';
  try {
    db.insert(changes).values({ id: 'pr', repository: 'org/repo', number: 1, title: 'Test', body: '', url: 'https://example.com/1', state: 'open', draft: false, authorLogin: 'art', branch: 'test', headCommit: 'abc', baseBranch: 'main', checks: 'running', review: 'required', mergeable: 'unknown', waitingOn: 'ci', openedAt: at, updatedAt: at }).run();
    sources.change('pr', 'sync-1'); sources.change('pr', 'sync-1');
    expect(events[0]).toEqual(events[1]);
    db.update(changes).set({ checks: 'passing' }).where(eq(changes.id, 'pr')).run();
    sources.change('pr', 'sync-2');
    expect(events[2].slice(0, 2)).toEqual(['pull-request', tempoWatch.change('pr')]);
    expect(events[2][2]).not.toEqual(events[0][2]);
    db.update(changes).set({ checks: 'running' }).where(eq(changes.id, 'pr')).run();
    sources.change('pr', 'sync-3');
    expect(events[3][2]).not.toEqual(events[0][2]);
    expect(() => sources.change('pr', '')).toThrow('durable source revision');
  } finally { client.close(); }
});
