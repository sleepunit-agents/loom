import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PeopleStore } from './people.js';

/**
 * Criterion 10 of docs/specs/person-cards.md — mirrors
 * sqlite-knowledge-write-race.test.ts.
 *
 * person_write is state-dependent: it reads the current card, merges the
 * passed fields onto it, then writes the whole card back. If that read
 * happened outside the write transaction, a second body could commit in the
 * window and its field would be silently overwritten by a merge over a card
 * that never had it. The competing write is fired from inside the
 * existing-row SELECT, so this is an ordering, not a timing hope.
 */
describe('PeopleStore.write — two-connection race', () => {
  let tmpDir: string;
  let a: PeopleStore;
  let b: PeopleStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'loom-people-race-'));
    const dbPath = join(tmpDir, 'memories.db');
    // Short timeout so the SQLITE_BUSY path doesn't wait 5s per attempt.
    a = new PeopleStore({ dbPath, busyTimeoutMs: 20 });
    b = new PeopleStore({ dbPath, busyTimeoutMs: 20 });
  });

  afterEach(() => {
    a.close();
    b.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Fire `onRead` once, right after write's existing-row SELECT returns. */
  function onExistingRead(store: PeopleStore, onRead: () => void): () => void {
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

  it('a competing write cannot land inside the window, and both fields survive', () => {
    a.write({ slug: 'p', name: 'P', how: { mode: 'terse' } });

    const outcomes: string[] = [];
    const restore = onExistingRead(a, () => {
      try {
        b.write({ slug: 'p', how: { tz: 'America/New_York' } });
        outcomes.push('committed');
      } catch (e) {
        if (isBusy(e)) outcomes.push('busy');
        else throw e;
      }
    });

    a.write({ slug: 'p', how: { lang: 'en' } });
    restore();

    // The loser is told it lost, rather than committing a field A then overwrites…
    expect(outcomes).toEqual(['busy']);

    // …and once it retries after A commits, it merges onto A's card.
    b.write({ slug: 'p', how: { tz: 'America/New_York' } });
    expect(a.getRow('p')!.card.how).toEqual({ mode: 'terse', lang: 'en', tz: 'America/New_York' });
  });
});
