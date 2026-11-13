import type { Migration } from '../../../core/index.js';
export const schema: Migration[] = [{ number: 1, sql: `
CREATE TABLE runtime_boxes (id TEXT PRIMARY KEY, record TEXT NOT NULL CHECK(json_valid(record)), changed_at INTEGER NOT NULL);
CREATE TABLE runtime_jobs (id TEXT PRIMARY KEY, record TEXT NOT NULL CHECK(json_valid(record)), changed_at INTEGER NOT NULL);
CREATE INDEX runtime_jobs_runner ON runtime_jobs(json_extract(record, '$.runner'));
CREATE INDEX runtime_jobs_agent ON runtime_jobs(json_extract(record, '$.agent'));
CREATE TABLE runtime_settings (id TEXT PRIMARY KEY, record TEXT NOT NULL CHECK(json_valid(record)), changed_at INTEGER NOT NULL);
CREATE TABLE runtime_bindings (id TEXT PRIMARY KEY, record TEXT NOT NULL CHECK(json_valid(record)), changed_at INTEGER NOT NULL);
CREATE UNIQUE INDEX runtime_bindings_place ON runtime_bindings(json_extract(record, '$.agent'), json_extract(record, '$.venue'), json_extract(record, '$.place'));
` }, { number: 2, sql: `
-- Words are private runner inputs, never registry/live records or retry results.
CREATE TABLE runtime_inputs (job TEXT PRIMARY KEY REFERENCES runtime_jobs(id), brief TEXT NOT NULL, needs TEXT NOT NULL CHECK(json_valid(needs)));
` }, { number: 3, sql: `
-- Output words are not registry/live records; reads use current job scope.
CREATE TABLE runtime_results (job TEXT PRIMARY KEY REFERENCES runtime_jobs(id), record TEXT NOT NULL CHECK(json_valid(record)));
` }, { number: 4, sql: `
-- Private routing receipts contain no message words or credentials.
CREATE TABLE runtime_deliveries (id TEXT PRIMARY KEY, job TEXT NOT NULL REFERENCES runtime_jobs(id));
` }, { number: 5, sql: `
-- Private sender/queued-source metadata; never contains message words.
CREATE TABLE runtime_provenance (conversation TEXT PRIMARY KEY, record TEXT NOT NULL CHECK(json_valid(record)));
CREATE TABLE runtime_provenance_sources (conversation TEXT NOT NULL, key TEXT NOT NULL, record TEXT NOT NULL CHECK(json_valid(record)), PRIMARY KEY(conversation,key));
CREATE TABLE runtime_owner_requests (target TEXT PRIMARY KEY, record TEXT NOT NULL CHECK(json_valid(record)));
-- Runner progress is distinct from administrative runtime_jobs.changed_at.
CREATE TABLE runtime_job_heartbeats (job TEXT PRIMARY KEY REFERENCES runtime_jobs(id), heard_at INTEGER NOT NULL);
` }, { number: 6, sql: `
-- Offline migration archive. No registry collections or authority read these tables.
CREATE TABLE runtime_import_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE runtime_import_sources (path TEXT PRIMARY KEY, content TEXT NOT NULL);
CREATE TABLE runtime_import_documents (collection TEXT NOT NULL, key TEXT NOT NULL, record TEXT NOT NULL CHECK(json_valid(record)), PRIMARY KEY(collection,key));
CREATE TABLE runtime_import_revisions (id INTEGER PRIMARY KEY, record TEXT NOT NULL CHECK(json_valid(record)));
` }, { number: 7, sql: `
-- Private venue words and permanent receipt identities, never live records.
CREATE TABLE runtime_bridge_turns (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, conversation TEXT NOT NULL, direction TEXT NOT NULL, record TEXT NOT NULL CHECK(json_valid(record)));
CREATE INDEX runtime_bridge_conversation ON runtime_bridge_turns(conversation,seq);
CREATE TABLE runtime_bridge_stops (id TEXT PRIMARY KEY);
` }];
