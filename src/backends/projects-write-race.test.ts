import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import { ProjectsStore } from './projects.js';

/**
 * Criterion 3 of docs/specs/projects.md, the atomicity half — mirrors
 * people-write-race.test.ts: two concurrent writes giving the same alias to
 * two projects leave exactly one holder.
 *
 * The alias check reads project_names and the write then claims the name. If
 * the read happened outside the write's transaction, a second body could
 * claim the alias in the window and both would think they held it (the
 * primary key would then make one of them fail late, after its card row was
 * already written). The competing write is fired from inside the first
 * write's row read, so this is an ordering, not a timing hope.
 */
describe('ProjectsStore.write — two-connection race', () => {
  let tmpDir: string;
  let dbPath: string;
  let a: ProjectsStore;
  let b: ProjectsStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'loom-projects-race-'));
    dbPath = join(tmpDir, 'memories.db');
    a = new ProjectsStore({ dbPath, busyTimeoutMs: 20 });
    b = new ProjectsStore({ dbPath, busyTimeoutMs: 20 });
  });

  afterEach(() => {
    a.close();
    b.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Fire `onRead` once, right after write's row SELECT returns. */
  function onRowRead(store: ProjectsStore, onRead: () => void): () => void {
    const db = store['db'] as unknown as { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } };
    const originalPrepare = db.prepare.bind(db);
    let fired = false;
    db.prepare = (sql: string) => {
      const stmt = originalPrepare(sql);
      if (!sql.startsWith('SELECT slug, name, card_json') || !sql.includes('WHERE slug = ?')) return stmt;
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

  const isBusy = (e: unknown) => /SQLITE_BUSY/.test(`${(e as { code?: string }).code} ${(e as Error).message}`);

  it('two writes giving the same alias to two projects leave exactly one holder', () => {
    a.write({ slug: 'pond', name: 'Pond' });
    b.write({ slug: 'hockey', name: 'Hockey' });

    const outcomes: string[] = [];
    const restore = onRowRead(a, () => {
      try {
        b.write({ slug: 'hockey', links: { aliases: ['toad'] } });
        outcomes.push('committed');
      } catch (e) {
        if (isBusy(e)) outcomes.push('busy');
        else throw e;
      }
    });
    a.write({ slug: 'pond', links: { aliases: ['toad'] } });
    restore();

    // The loser can't commit inside the window…
    expect(outcomes).toEqual(['busy']);
    // …and when it retries after A commits, it is rejected naming the holder.
    expect(() => b.write({ slug: 'hockey', links: { aliases: ['toad'] } })).toThrow(/"toad" is held by project pond/);

    const db = new BetterSqlite3(dbPath, { readonly: true });
    try {
      expect(db.prepare("SELECT slug FROM project_names WHERE name = 'toad'").all()).toEqual([{ slug: 'pond' }]);
    } finally {
      db.close();
    }
    expect(b.resolve('hockey')!.row.card.links).toEqual({});
  });
});
