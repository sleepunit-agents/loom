/** The per-agent and commons stores carry a version in the file header and refuse a newer or foreign file unaltered. */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import { MIGRATIONS, runMigrations } from './migrations.js';
import { PeopleStore } from './people.js';
import { ProjectsStore } from './projects.js';
import { SqliteKnowledgeBackend } from './sqlite-knowledge.js';
import { SqliteVecBackend } from './sqlite-vec.js';
import type { EmbeddingProvider } from './types.js';

const embedder: EmbeddingProvider = { dimensions: 4, embed: async () => [0.5, 0.5, 0.5, 0.5], embedBatch: async texts => texts.map(() => [0.5, 0.5, 0.5, 0.5]) };
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'loom-store-version-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });
function raw<T>(path: string, read: (db: BetterSqlite3.Database) => T): T { const db = new BetterSqlite3(path); try { return read(db); } finally { db.close(); } }
const version = (path: string) => raw(path, db => db.pragma('user_version', { simple: true }));
const everything = (path: string) => raw(path, db => db.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY name').all());

it('marks a memory store with the number of steps it has had, and refuses one from a newer program without altering it', async () => {
  const path = join(directory, 'memories.db');
  await (new SqliteVecBackend({ dbPath: path }, embedder)).remember({ category: 'project', title: 'Fictional', content: 'Fictional words' });
  expect(version(path)).toBe(MIGRATIONS.length);
  // As a later program leaves it: one more step, and a column this program has never heard of.
  raw(path, db => { db.exec('ALTER TABLE memories ADD COLUMN from_the_future TEXT'); db.pragma(`user_version = ${MIGRATIONS.length + 1}`); });
  const before = everything(path);
  await expect((async () => (new SqliteVecBackend({ dbPath: path }, embedder)).remember({ category: 'project', title: 'Second', content: 'More words' }))()).rejects.toThrow('newer program');
  expect(() => new PeopleStore({ dbPath: path })).toThrow('newer program');
  expect(() => new ProjectsStore({ dbPath: path })).toThrow('newer program');
  expect(() => raw(path, db => runMigrations(db, { strict: false }))).toThrow('newer program');
  expect(everything(path)).toEqual(before);
  expect(version(path)).toBe(MIGRATIONS.length + 1);
});

it('leaves a store only some steps have run on unmarked, so the rest still run', () => {
  const path = join(directory, 'people.db');
  new PeopleStore({ dbPath: path }).close();
  expect(version(path)).toBe(0);
});

it('refuses a knowledge store from a newer program, and a file that is not a knowledge store, without altering either', () => {
  const path = join(directory, 'knowledge.db');
  new SqliteKnowledgeBackend({ dbPath: path }).close();
  expect(version(path)).toBe(1);
  raw(path, db => { db.pragma('user_version = 2'); });
  const before = everything(path);
  expect(() => new SqliteKnowledgeBackend({ dbPath: path })).toThrow('newer program');
  expect(everything(path)).toEqual(before);
  expect(version(path)).toBe(2);

  const foreign = join(directory, 'other.db');
  raw(foreign, db => { db.exec("CREATE TABLE precious (words TEXT); INSERT INTO precious VALUES ('keep me')"); });
  const untouched = everything(foreign);
  expect(() => new SqliteKnowledgeBackend({ dbPath: foreign })).toThrow('not a knowledge store');
  expect(everything(foreign)).toEqual(untouched);
  expect(version(foreign)).toBe(0);
});
