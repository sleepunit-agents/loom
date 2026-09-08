import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteKnowledgeBackend } from './sqlite-knowledge.js';

/**
 * Two-connection races on writePage (t-4xx, Mark's observation 2026-09-06).
 *
 * writePage is state-dependent: it SELECTs the existing page, then decides
 * mode/body/uuid from what it read, then writes. If that read happens outside
 * the write transaction, another process can commit in the window between them
 * — an append then overwrites the contribution it never saw, and a replace
 * snapshots a body that is no longer the one it is replacing.
 *
 * The interleave is forced deterministically: both connections are real
 * backends on the same file, and the competing write is fired from inside the
 * existing-page SELECT, i.e. exactly in the window under test. better-sqlite3
 * is synchronous, so this is an ordering, not a timing hope.
 */
describe('SqliteKnowledgeBackend.writePage — two-connection races', () => {
  let tmpDir: string;
  let dbPath: string;
  let a: SqliteKnowledgeBackend;
  let b: SqliteKnowledgeBackend;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'loom-race-'));
    dbPath = join(tmpDir, 'knowledge.db');
    a = new SqliteKnowledgeBackend({ dbPath });
    b = new SqliteKnowledgeBackend({ dbPath });
  });

  afterEach(() => {
    a.close();
    b.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Fire `onRead` once, immediately after writePage's existing-page SELECT
   * returns — the first instant at which a decision has been made from state
   * that another writer could still change.
   */
  function onExistingRead(
    backend: SqliteKnowledgeBackend,
    onRead: () => void,
  ): () => void {
    const db = backend['ensureOpen']() as unknown as {
      prepare: (sql: string) => { get: (...args: unknown[]) => unknown };
    };
    const originalPrepare = db.prepare.bind(db);
    let fired = false;
    db.prepare = (sql: string) => {
      const stmt = originalPrepare(sql);
      if (!sql.includes('SELECT id, uuid, title, body FROM pages')) return stmt;
      const originalGet = stmt.get.bind(stmt);
      stmt.get = (...args: unknown[]) => {
        const row = originalGet(...args);
        if (!fired) {
          fired = true;
          onRead();
        }
        return row;
      };
      return stmt;
    };
    return () => {
      db.prepare = originalPrepare;
    };
  }

  function isBusy(e: unknown): boolean {
    const err = e as { code?: string; message?: string };
    return err?.code === 'SQLITE_BUSY' || /SQLITE_BUSY/.test(err?.message ?? '');
  }

  /** Run a competing write, recording whether it won the lock or was told it lost. */
  function compete(
    backend: SqliteKnowledgeBackend,
    input: Parameters<SqliteKnowledgeBackend['writePage']>[0],
    outcomes: string[],
  ): Promise<void> {
    return backend.writePage(input).then(
      () => {
        outcomes.push('committed');
      },
      (e: unknown) => {
        if (isBusy(e)) outcomes.push('busy');
        else throw e;
      },
    );
  }

  it('does not drop a concurrent append committed after the existing-page read', async () => {
    await a.writePage({ slug: 'p', domain: 'test', title: 'P', body: 'base' });

    const outcomes: string[] = [];
    let competing: Promise<void> | null = null;
    const restore = onExistingRead(a, () => {
      competing = compete(
        b,
        { slug: 'p', domain: 'test', title: 'P', body: 'from-B', bodyMode: 'append' },
        outcomes,
      );
    });

    await a.writePage({ slug: 'p', domain: 'test', title: 'P', body: 'from-A', bodyMode: 'append' });
    restore();
    await competing;

    // The invariant, stated on the data: a write that reported success is in
    // the page. A "committed" that vanished is the lost update.
    const raced = await a.getPage('p');
    expect(raced?.body).toContain('from-A');
    if (outcomes[0] === 'committed') expect(raced?.body).toContain('from-B');

    // The way that invariant is kept: the loser is told it lost…
    expect(outcomes).toEqual(['busy']);

    // …and its contribution survives once it retries outside the window.
    await b.writePage({ slug: 'p', domain: 'test', title: 'P', body: 'from-B', bodyMode: 'append' });

    const page = await a.getPage('p');
    expect(page?.body).toContain('base');
    expect(page?.body).toContain('from-A');
    expect(page?.body).toContain('from-B');
  });

  it('snapshots the body it actually replaces, not a stale read', async () => {
    await a.writePage({ slug: 'q', domain: 'test', title: 'Q', body: 'v1' });

    const outcomes: string[] = [];
    let competing: Promise<void> | null = null;
    const restore = onExistingRead(a, () => {
      competing = compete(
        b,
        { slug: 'q', domain: 'test', title: 'Q', body: 'v2', bodyMode: 'replace' },
        outcomes,
      );
    });

    await a.writePage({ slug: 'q', domain: 'test', title: 'Q', body: 'v3', bodyMode: 'replace' });
    restore();
    await competing;

    const recoverable = async (): Promise<string[]> => {
      const page = await a.getPage('q');
      const bodies = new Set<string>([page?.body ?? '']);
      for (const m of await a.listRevisions('q')) {
        const rev = await a.getRevision(m.id);
        if (rev) bodies.add(rev.body);
      }
      return [...bodies].sort();
    };

    // A body that was committed and then displaced must survive as a snapshot.
    // Snapshotting a stale read loses it with no revision to recover it from.
    if (outcomes[0] === 'committed') expect(await recoverable()).toContain('v2');

    expect(outcomes).toEqual(['busy']);

    await b.writePage({ slug: 'q', domain: 'test', title: 'Q', body: 'v2', bodyMode: 'replace' });

    // Every body that was ever committed is recoverable: current, or snapshotted.
    expect(await recoverable()).toEqual(['v1', 'v2', 'v3']);
  });
});
