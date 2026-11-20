import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import { startLoom } from '../../foundation.js';
import { FakeClock, operation } from '../../core/index.js';
import { SqliteKnowledgeBackend } from '../../backends/sqlite-knowledge.js';
import { verifyKnowledgePages } from '../../backends/knowledge-verification.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'mind-verify-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, 'knowledge.db');
  const backend = new SqliteKnowledgeBackend({ dbPath: path });
  cleanups.push(() => backend.close());
  await backend.writePage({ slug: 'fact', title: 'Fact', domain: 'systems', body: 'Original' });
  const db = new BetterSqlite3(path);
  cleanups.push(() => db.close());
  const clock = new FakeClock(Date.UTC(2026, 10, 12));
  const app = await startLoom({ home: join(home, 'daemon'), clock });
  cleanups.push(() => app.close());
  return { backend, db, clock, app };
}
it('runs synchronously inside the operation registry, using its fake clock and preserving stale stamps', async () => {
  const { db, clock, app, backend } = await fixture();
  // Test-only operation: production composition still needs cross-store retry receipts.
  app.operations.register(operation({ name: 'test.verify', input: z.object({ outcome: z.enum(['confirmed', 'stale']) }), output: z.unknown(), may: () => true,
    run: (ctx, input) => verifyKnowledgePages(db, { slug: 'fact', outcome: input.outcome, verifier: 'art', citation_checked: true }, ctx.now),
  }));
  const viewer = { kind: 'agent' as const, id: 'art' };
  app.operations.register(operation({ name: 'test.promiseVerify', input: z.object({}), output: z.unknown(), may: () => true,
    run: () => backend.verifyPages({ slug: 'fact' }),
  }));
  expect(app.operations.call('direct', viewer, 'test.promiseVerify', {})).toMatchObject({ ok: false, code: 'unavailable' });
  const first = new Date(clock.now()).toISOString();
  const before = await backend.getPage('fact');
  expect(app.operations.call('direct', viewer, 'test.verify', { outcome: 'confirmed' })).toMatchObject({ ok: true, value: { stamped: true, verified_at: first } });
  clock.advance(86400_000);
  expect(app.operations.call('direct', viewer, 'test.verify', { outcome: 'stale' })).toMatchObject({ ok: true, value: { stamped: false } });
  expect(await backend.getPage('fact')).toMatchObject({ verified_at: first, body: before!.body, updated: before!.updated });
  expect(await backend.getVerifications('fact')).toEqual(expect.arrayContaining([
    expect.objectContaining({ outcome: 'confirmed', verifier: 'art', citation_checked: true, verified_at: first }),
    expect.objectContaining({ outcome: 'stale', verified_at: new Date(clock.now()).toISOString() }),
  ]));
});
it('honors explicit verification time, while content edits use the supplied clock', async () => {
  const { db, clock, backend } = await fixture();
  const at = '2026-10-01T12:00:00.000Z';
  const result = verifyKnowledgePages(db, { slug: 'fact', verified_at: at, freshness_anchor: 'v2.1', note: 'Checked sources', outcome: 'corrected' }, clock.now());
  expect(result).toEqual({ verified: 1, slugs: ['fact'], verified_at: at, stamped: true, noted: true });
  expect(await backend.getPage('fact')).toMatchObject({ verified_at: at, updated: new Date(clock.now()).toISOString(), freshness_anchor: 'v2.1', sla_class: 'software', body: 'Original\n\n## Verification — 2026-10-01\n\nChecked sources' });
});
it('rejects bad batches before any stamp and rolls back stamp/anchor if a note exceeds the body cap', async () => {
  const { db, clock, backend } = await fixture();
  const before = await backend.getPage('fact');
  for (const input of [{ slugs: ['fact', 'missing'] }, { slug: 'fact', slugs: ['fact'] }, { slugs: [] }, { slugs: ['fact'], note: 'no' }]) {
    expect(() => verifyKnowledgePages(db, input, clock.now())).toThrow();
  }
  expect(() => verifyKnowledgePages(db, { slug: 'fact', freshness_anchor: 'v9.0', note: 'a'.repeat(65536) }, clock.now())).toThrow('hard cap');
  expect(await backend.getPage('fact')).toMatchObject({ verified_at: before!.verified_at, freshness_anchor: null, body: 'Original' });
  expect(await backend.getVerifications('fact')).toEqual([]);
  await backend.archivePage({ slug: 'fact' });
  expect(() => verifyKnowledgePages(db, { slug: 'fact' }, clock.now())).toThrow('archived');
});
