import type { Migration } from '../../../core/index.js';
export const conversationSchema: Migration = { number: 2, sql: `
CREATE TABLE attention_conversations (id TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE attention_turns (id TEXT PRIMARY KEY, conversation TEXT NOT NULL REFERENCES attention_conversations(id), seq INTEGER NOT NULL, record TEXT NOT NULL, UNIQUE(conversation,seq));
` };
