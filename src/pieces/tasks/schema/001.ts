import type { Migration } from '../../../core/index.js';
export const schema: Migration[] = [{ number: 1, sql: `
CREATE TABLE tasks_tasks (ord INTEGER NOT NULL, id TEXT PRIMARY KEY, record TEXT NOT NULL, changed_at INTEGER NOT NULL);
CREATE TABLE tasks_links (ord INTEGER PRIMARY KEY, record TEXT NOT NULL);
CREATE INDEX tasks_links_id ON tasks_links(json_extract(record, '$.id'));
CREATE TABLE tasks_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
` }];
