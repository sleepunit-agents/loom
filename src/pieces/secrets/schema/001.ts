import type { Migration } from '../../../core/index.js';
export const schema: Migration[] = [{ number: 1, sql: `
CREATE TABLE secrets_names (id TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE secrets_grants (id TEXT PRIMARY KEY, agent TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, record TEXT NOT NULL, UNIQUE(agent,kind,target));
CREATE TABLE secrets_requests (id TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE secrets_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
` }, { number: 2, sql: `
-- Scoped grants may coexist for the same agent/resource. Their identities include scope.
ALTER TABLE secrets_grants RENAME TO secrets_grants_v1;
CREATE TABLE secrets_grants (id TEXT PRIMARY KEY, agent TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, record TEXT NOT NULL);
INSERT INTO secrets_grants SELECT * FROM secrets_grants_v1;
DROP TABLE secrets_grants_v1;
CREATE INDEX secrets_grants_resource ON secrets_grants(agent,kind,target);
` }, { number: 3, sql: `
CREATE TABLE secrets_changes (id TEXT PRIMARY KEY, record TEXT NOT NULL);
` }, { number: 4, sql: `
CREATE TABLE secrets_uses (id TEXT PRIMARY KEY, name TEXT NOT NULL, record TEXT NOT NULL);
CREATE INDEX secrets_uses_name ON secrets_uses(name);
` }, { number: 5, sql: `
CREATE TABLE secrets_write_intents (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 viewer TEXT NOT NULL, id TEXT NOT NULL, operation TEXT NOT NULL, input_hash TEXT NOT NULL,
 member TEXT NOT NULL, write_id TEXT NOT NULL, holder_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, action TEXT NOT NULL,
 admitted_at INTEGER NOT NULL, committed_at INTEGER, commit_order INTEGER UNIQUE, state TEXT NOT NULL,
 UNIQUE(viewer,id), UNIQUE(member,write_id)
);
CREATE UNIQUE INDEX secrets_write_unfinished ON secrets_write_intents((1)) WHERE state <> 'complete';
` }];
