import type { Migration } from '../../../core/index.js';
export const retentionSchema: Migration = { number: 4, sql: `
CREATE TABLE attention_days (id TEXT PRIMARY KEY, conversation TEXT NOT NULL REFERENCES attention_conversations(id), day TEXT NOT NULL, record TEXT NOT NULL, UNIQUE(conversation,day));
CREATE TABLE attention_findings (id TEXT PRIMARY KEY, conversation TEXT NOT NULL REFERENCES attention_conversations(id), day TEXT NOT NULL, record TEXT NOT NULL, UNIQUE(conversation,day));
` };
