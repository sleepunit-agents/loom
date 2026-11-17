/** An upgrade step of a memory or knowledge store happens whole or not at all, so "is it pending" stays answerable from the file's shape. */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import { MIGRATIONS, runMigrations } from './migrations.js';
import { SqliteKnowledgeBackend } from './sqlite-knowledge.js';

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'loom-upgrade-steps-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });
const columns = (db: BetterSqlite3.Database, table: string) => (db.pragma(`table_info(${table})`) as { name: string }[]).map(column => column.name);

it('leaves no part of a memory store step behind when the step fails midway', () => {
  const db = new BetterSqlite3(join(directory, 'memories.db'));
  try {
    // The first shape of the table, with one feedback memory that has a confidence to backfill from.
    db.exec(`CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE, ref TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
      category TEXT NOT NULL, project TEXT, content TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', created TEXT NOT NULL, updated TEXT,
      last_accessed TEXT, ttl TEXT, expires_at TEXT)`);
    // Something else already holds the name the add_uniq step gives its index, so that step's second statement fails.
    db.exec('CREATE INDEX idx_memories_uniq ON memories(title)');
    expect(() => runMigrations(db)).toThrow("Migration 'add_uniq' failed");
    // Its first statement added the column. Kept, the step would read as done for ever, with no index and no backfill.
    expect(columns(db, 'memories')).not.toContain('uniq');
    expect(MIGRATIONS.find(step => step.id === 'add_uniq')!.pending(db)).toBe(true);
    // The steps before it each committed whole, and the store is not marked as having had them all.
    expect(columns(db, 'memories')).toContain('times_seen');
    expect(db.pragma('user_version', { simple: true })).toBe(0);
    // With the obstacle gone the same call finishes the rest.
    db.exec('DROP INDEX idx_memories_uniq');
    expect(runMigrations(db).some(result => result.status === 'failed')).toBe(false);
    expect(columns(db, 'memories')).toContain('uniq');
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
  } finally { db.close(); }
});

it('leaves an older knowledge store as it was when its upgrade fails midway', () => {
  const path = join(directory, 'knowledge.db');
  const old = new BetterSqlite3(path);
  try {
    // A store from before pages carried a class, with a trigger that refuses the backfill's UPDATE.
    old.exec(`CREATE TABLE pages (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
      domain TEXT NOT NULL, body TEXT NOT NULL, sourcing TEXT NOT NULL DEFAULT 'sourced', provenance TEXT, status TEXT NOT NULL DEFAULT 'active',
      created TEXT NOT NULL, updated TEXT, last_accessed TEXT, hit_count INTEGER NOT NULL DEFAULT 0, freshness_anchor TEXT)`);
    old.prepare("INSERT INTO pages (uuid, slug, title, domain, body, created, freshness_anchor) VALUES ('u', 'price', 'Price', 'fiction', 'words', '2026-01-01T00:00:00.000Z', 'v2.1')").run();
    old.exec("CREATE TRIGGER refuse_backfill BEFORE UPDATE ON pages BEGIN SELECT RAISE(ABORT, 'fictional interruption'); END");
  } finally { old.close(); }
  expect(() => new SqliteKnowledgeBackend({ dbPath: path })).toThrow('fictional interruption');
  const after = new BetterSqlite3(path);
  try {
    // No column of the upgrade stays, so the next open does all of it, backfill included.
    expect(columns(after, 'pages')).not.toContain('sla_class');
    expect(columns(after, 'pages')).not.toContain('verified_at');
    after.exec('DROP TRIGGER refuse_backfill');
  } finally { after.close(); }
  const store = new SqliteKnowledgeBackend({ dbPath: path });
  store.close();
  const done = new BetterSqlite3(path);
  try { expect(done.prepare("SELECT sla_class FROM pages WHERE slug = 'price'").get()).not.toEqual({ sla_class: 'default' }); } finally { done.close(); }
});
