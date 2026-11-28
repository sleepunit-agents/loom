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
    for (const id of ['job-A', 'job-B', 'job-C']) {
      db.insert(jobs).values({ id, agent: 'art', title: 'Review', state: 'queued', brief: '', model: 'reviewer',
        startedByKind: 'agent', startedBy: 'art', houseRepository: 'acme/app', houseFile: '', houseBranch: 'main', queuedAt: at }).run();
    }
    const cache = changeService(db, () => undefined);
    const first = change();
    cache.put(first);
    let clock = at;
    const store = changeReviewStore(db, () => clock);
    const firstAssignment = { job: 'job-A', change: first.id, headCommit: first.head.id, tier: 'high' as const, round: 1 };
    const assigned = store.assign(firstAssignment);
    const nextAssignment = { ...firstAssignment, headCommit: 'b'.repeat(40), job: 'job-B', round: 2 };
    expect(() => store.assign(nextAssignment)).toThrow('current change head');
    expect(() => store.assign({ ...firstAssignment, job: 'missing' })).toThrow();
    cache.put({ ...first, head: { ...first.head, id: nextAssignment.headCommit } });
    store.assign(nextAssignment);
    clock = '2026-11-20T13:00:00Z';
    expect(store.assign(firstAssignment)).toEqual(assigned);
    expect(() => store.assign({ ...nextAssignment, job: firstAssignment.job })).toThrow('already assigned');
    const receipt = { ...firstAssignment, verdict: 'CLEAR' as const, findings: 'No blocking findings' };
    for (const mismatch of [{ job: nextAssignment.job }, { change: 'github:acme/app#4' }, { headCommit: nextAssignment.headCommit }]) {
      expect(() => store.finish({ ...receipt, ...mismatch })).toThrow('does not match');
    }
    const completedAt = clock;
    const filed = store.finish(receipt);
    expect(filed).toMatchObject({ findings: receipt.findings, completedAt });
    clock = '2026-11-20T14:00:00Z';
    expect(store.finish(receipt)).toEqual(filed);
    expect(() => store.finish({ ...receipt, findings: '' })).toThrow('already filed');
    const second = change({ id: 'github:acme/app#4', number: 4 });
    cache.put(second);
    store.assign({ ...firstAssignment, change: second.id, job: 'job-C' });
    expect(store.history(first.id)).toMatchObject([
      { job: nextAssignment.job, current: true, verdict: null }, { job: firstAssignment.job, current: false, verdict: 'CLEAR', findings: receipt.findings, completedAt },
    ]);
    expect(store.history(second.id)).toMatchObject([{ job: 'job-C', current: true }]);
  } finally {
    client.close();
  }
});

it('reads a frozen review\'s verdict from its last line alone, the same for every harness', async () => {
  const { replyVerdict } = await import('./change-reviews.js');
  expect(replyVerdict('No findings.\nVERDICT: CLEAR')).toBe('CLEAR');
  expect(replyVerdict('No findings.\nVERDICT: CLEAR  \n\n')).toBe('CLEAR');
  expect(replyVerdict('- MINOR a.ts:1 a name.\nVERDICT: BLOCKING')).toBe('BLOCKING');
  // Only the last line is read: a bullet above it, a quoted `- MAJOR version bump` or a real finding, changes nothing.
  expect(replyVerdict('- MAJOR version bump in package.json is intended.\nVERDICT: CLEAR')).toBe('CLEAR');
  expect(replyVerdict('  - CRITICAL a.ts:1 wrong.\nVERDICT: CLEAR')).toBe('CLEAR');
  // No verdict: none at all, one that is not the last line, one that only starts the same, one in other words.
  for (const reply of ['Looks fine.', 'VERDICT: CLEAR\nThanks!', 'VERDICT: CLEARLY', 'verdict: clear', 'VERDICT: NONE', '`VERDICT: CLEAR`'])
    expect(replyVerdict(reply), reply).toBeUndefined();
});
