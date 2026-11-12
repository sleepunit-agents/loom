import type { Migration } from '../../../core/index.js';
export const schema: Migration[] = [{ number: 1, sql: `CREATE TABLE example_records (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, project TEXT, agent TEXT, member TEXT, parent TEXT,
  expires INTEGER
)` }];
