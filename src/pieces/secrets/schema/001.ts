import type { Migration } from '../../../core/index.js';
export const schema: Migration[] = [{ number: 1, sql: `
CREATE TABLE secrets_names (id TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE secrets_grants (id TEXT PRIMARY KEY, agent TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, record TEXT NOT NULL, UNIQUE(agent,kind,target));
CREATE TABLE secrets_requests (id TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE secrets_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
` }];
