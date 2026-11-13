import type { Migration } from '../../../core/index.js';
export const schema: Migration[] = [{ number: 1, sql: `
CREATE TABLE approvals_approvals (id TEXT PRIMARY KEY, record TEXT NOT NULL, changed_at INTEGER NOT NULL);
CREATE TABLE approvals_rules (id TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE approvals_notices (id INTEGER PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE approvals_audit (id INTEGER PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE approvals_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
` }];
