import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { createDataSchema } from '../core/data/database.js';
import { agents, jobs } from '../core/data/schema.js';
import { change } from '../pieces/changes/change.fixture.js';
import { changeService } from './changes.js';
import { changeReviewStore } from './change-reviews.js';

it('files a late result on its assigned commit and preserves the original assignment and receipt across retries', () => {
  const client = new Database(':memory:');
  try {
    const at = '2026-11-20T12:00:00Z';
    const db = createDataSchema(client, () => at);
    db.insert(agents).values({ id: 'art', about: '', markBg: '#fff', markFg: '#000', faceShape: 'pebble', faceEyes: 'dot' }).run();
    for (const id of ['job-A', 'job-B']) {
      db.insert(jobs).values({ id, agent: 'art', title: 'Review', state: 'queued', brief: '', model: 'reviewer',
        startedByKind: 'agent', startedBy: 'art', houseRepository: 'acme/app', houseFile: '', houseBranch: 'main', queuedAt: at }).run();
    }
    const cache = changeService(db, () => undefined);
    const first = change();
    cache.put(first);
    const store = changeReviewStore(db, () => at);
    const a = { job: 'job-A', change: first.id, headCommit: first.head.id, tier: 'high' as const, round: 1 };
    const assigned = store.assign(a);
    const b = { ...a, headCommit: 'b'.repeat(40), job: 'job-B', round: 2 };
    expect(() => store.assign(b)).toThrow('current change head');
    expect(() => store.assign({ ...a, job: 'missing' })).toThrow();
    cache.put({ ...first, head: { ...first.head, id: b.headCommit } });
    store.assign(b);
    expect(store.assign(a)).toEqual(assigned);
    expect(() => store.assign({ ...b, job: a.job })).toThrow('already assigned');
    const receipt = { ...a, verdict: 'CLEAR' as const, findings: 'No blocking findings' };
    for (const mismatch of [{ job: b.job }, { change: 'github:acme/app#4' }, { headCommit: b.headCommit }]) {
      expect(() => store.finish({ ...receipt, ...mismatch })).toThrow('does not match');
    }
    const filed = store.finish(receipt);
    expect(store.finish(receipt)).toEqual(filed);
    expect(() => store.finish({ ...receipt, findings: '' })).toThrow('already filed');
    expect(store.history(first.id)).toMatchObject([
      { job: b.job, current: true, verdict: null }, { job: a.job, current: false, verdict: 'CLEAR' },
    ]);
    expect(store.history('github:acme/app#4')).toEqual([]);
  } finally {
    client.close();
  }
});
