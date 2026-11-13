import type { Migration } from '../../../core/index.js';
export const schema: Migration[] = [{ number: 1, sql: `
CREATE TABLE attention_asks (id TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE attention_statuses (id TEXT PRIMARY KEY, record TEXT NOT NULL);
` }];
