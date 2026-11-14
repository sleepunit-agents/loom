import type { Migration } from '../../../core/index.js';
/** Per-member Inbox read facts, independent of whether an ask still needs an answer. */
export const readMarkSchema: Migration = { number: 6, sql: `
CREATE TABLE attention_read_marks (id TEXT PRIMARY KEY, ask TEXT NOT NULL REFERENCES attention_asks(id), record TEXT NOT NULL);
` };
