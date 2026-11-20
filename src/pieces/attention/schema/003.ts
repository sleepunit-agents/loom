import type { Migration } from '../../../core/index.js';
export const digestSchema: Migration = { number: 3, sql: `
CREATE TABLE attention_digests (id TEXT PRIMARY KEY, conversation TEXT NOT NULL REFERENCES attention_conversations(id), revision INTEGER NOT NULL, record TEXT NOT NULL);
CREATE INDEX attention_digests_conversation ON attention_digests(conversation);
` };
