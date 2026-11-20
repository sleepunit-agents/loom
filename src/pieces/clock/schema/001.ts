import type { Migration } from '../../../core/index.js';
export const schema: Migration[] = [{ number: 1, sql: `
CREATE TABLE clock_wakes (id TEXT PRIMARY KEY, record TEXT NOT NULL, changed_at INTEGER NOT NULL);
CREATE INDEX clock_wakes_due ON clock_wakes(json_extract(record, '$.state'), json_extract(record, '$.due'));
CREATE TABLE clock_schedules (id TEXT PRIMARY KEY, record TEXT NOT NULL, changed_at INTEGER NOT NULL);
CREATE TABLE clock_pauses (agent TEXT PRIMARY KEY, since INTEGER NOT NULL);
CREATE TABLE clock_events (seq INTEGER PRIMARY KEY, wake TEXT NOT NULL, record TEXT NOT NULL);
CREATE TABLE clock_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
` }];
