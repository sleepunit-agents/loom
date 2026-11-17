import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createDataSchema, recogniseDataSchema } from '../data/database.js';
import { openDb } from './index.js';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

it('refuses a home that holds the household database, and adds nothing to it', () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-older-foundation-')); homes.push(home);
  const made = new Database(join(home, 'loom.db')); createDataSchema(made); made.close();
  expect(() => openDb(home)).toThrow('household database');
  const after = new Database(join(home, 'loom.db'), { readonly: true });
  try {
    expect(after.prepare("SELECT name FROM sqlite_schema WHERE name = 'core_migrations'").all()).toEqual([]);
    // The served program still recognises it.
    expect(recogniseDataSchema(after)).toBeGreaterThan(0);
  } finally { after.close(); }
});

it('still opens an empty home for the older foundation', () => {
  const home = mkdtempSync(join(tmpdir(), 'loom-older-foundation-')); homes.push(home);
  const store = openDb(home);
  try { expect(store.db.prepare("SELECT name FROM sqlite_schema WHERE name = 'core_migrations'").all()).toEqual([{ name: 'core_migrations' }]); } finally { store.close(); }
});
