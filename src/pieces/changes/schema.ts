import type { Migration } from '../../core/index.js';
export const schema: Migration[] = [{ number: 1, sql: `
CREATE TABLE changes_changes (id TEXT PRIMARY KEY, repo TEXT NOT NULL, record TEXT NOT NULL);
CREATE INDEX changes_repo ON changes_changes(repo);
CREATE TABLE changes_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE changes_jobs (id INTEGER PRIMARY KEY CHECK(id=1), due INTEGER NOT NULL, running INTEGER NOT NULL DEFAULT 0);
` }, { number: 2, sql: `ALTER TABLE changes_jobs ADD COLUMN requested INTEGER NOT NULL DEFAULT 0` }];
