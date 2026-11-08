/**
 * t-1270 — loom-http restarts didn't apply pending memories.db migrations.
 * The default server's backend constructor runs `runMigrations` (strict),
 * but that constructor only ran lazily, on whichever session's first
 * backend-touching tool call happened to land first — an unauthenticated
 * health probe never reached it, so a restarted daemon could look fully up
 * while memories.db still had the old schema underneath it. startHttpServer
 * now constructs the default backend eagerly, before the socket opens.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import { startHttpServer, type HttpServeHandle } from './http-server.js';
import { createKnowledgeOnlyServer } from './knowledge-server.js';
import { resolveSqliteDbPath } from '../config.js';
import { pendingMigrations } from '../backends/migrations.js';

/**
 * Pre-SLE-90 memories.db schema — missing `archived`/`archive_note` and
 * every migration after them. Mirrors migrations.test.ts's openOldSchemaDb,
 * minus vec_memories: the backend's own constructor creates that table
 * (and loads the vec0 extension) the first time it opens this file.
 */
function writeOldSchemaDb(dbPath: string): void {
  const db = new BetterSqlite3(dbPath);
  db.prepare(
    `CREATE TABLE memories (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid          TEXT NOT NULL UNIQUE,
      ref           TEXT NOT NULL UNIQUE,
      title         TEXT NOT NULL,
      category      TEXT NOT NULL,
      project       TEXT,
      content       TEXT NOT NULL,
      metadata      TEXT NOT NULL DEFAULT '{}',
      created       TEXT NOT NULL,
      updated       TEXT,
      last_accessed TEXT,
      ttl           TEXT,
      expires_at    TEXT
    )`,
  ).run();
  db.close();
}

describe('t-1270: eager-migrate on loom-http boot', () => {
  it('applies pending memories.db migrations at startup, before any client ever connects', async () => {
    const contextDir = mkdtempSync(join(tmpdir(), 'loom-eager-migrate-'));
    const dbPath = resolveSqliteDbPath(contextDir);
    writeOldSchemaDb(dbPath);

    let handle: HttpServeHandle | undefined;
    try {
      // Before the fix, this db stayed on the old schema until some
      // session's first backend-touching tool call — which never happens
      // in this test, by design: no MCP client connects.
      handle = await startHttpServer({ contextDir, host: '127.0.0.1', port: 0 });

      const db = new BetterSqlite3(dbPath, { readonly: true });
      try {
        expect(pendingMigrations(db)).toEqual([]);
        const columns = (db.pragma('table_info(memories)') as { name: string }[]).map((c) => c.name);
        expect(columns).toContain('archived');
      } finally {
        db.close();
      }
    } finally {
      await handle?.close();
      rmSync(contextDir, { recursive: true, force: true });
    }
  });

  it('does not touch memories.db for a scoped createServer (knowledge-only service)', async () => {
    const contextDir = mkdtempSync(join(tmpdir(), 'loom-eager-migrate-scoped-'));
    const dbPath = resolveSqliteDbPath(contextDir);

    let handle: HttpServeHandle | undefined;
    try {
      handle = await startHttpServer({
        contextDir,
        host: '127.0.0.1',
        port: 0,
        tokens: { art: 'test-secret' },
        createServer: createKnowledgeOnlyServer,
      });

      // The knowledge-only scope never registers memory tools, so eager-
      // migrating its backend would only pay for an unused construction —
      // assert it's skipped: memories.db was never even created.
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      await handle?.close();
      rmSync(contextDir, { recursive: true, force: true });
    }
  });
});
