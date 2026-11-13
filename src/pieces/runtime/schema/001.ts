import type { Migration } from '../../../core/index.js';
export const schema: Migration[] = [{ number: 1, sql: `
CREATE TABLE runtime_boxes (id TEXT PRIMARY KEY, record TEXT NOT NULL CHECK(json_valid(record)), changed_at INTEGER NOT NULL);
CREATE TABLE runtime_jobs (id TEXT PRIMARY KEY, record TEXT NOT NULL CHECK(json_valid(record)), changed_at INTEGER NOT NULL);
CREATE INDEX runtime_jobs_runner ON runtime_jobs(json_extract(record, '$.runner'));
CREATE INDEX runtime_jobs_agent ON runtime_jobs(json_extract(record, '$.agent'));
CREATE TABLE runtime_settings (id TEXT PRIMARY KEY, record TEXT NOT NULL CHECK(json_valid(record)), changed_at INTEGER NOT NULL);
CREATE TABLE runtime_bindings (id TEXT PRIMARY KEY, record TEXT NOT NULL CHECK(json_valid(record)), changed_at INTEGER NOT NULL);
CREATE UNIQUE INDEX runtime_bindings_place ON runtime_bindings(json_extract(record, '$.agent'), json_extract(record, '$.venue'), json_extract(record, '$.place'));
` }];
