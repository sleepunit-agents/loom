import type { Migration } from '../../../core/index.js';
/** Bounded member-private action history plus retry tombstones. */
export const outcomeSchema: Migration = { number: 7, sql: `
CREATE TABLE attention_outcomes (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  member TEXT NOT NULL, record TEXT NOT NULL
);
CREATE INDEX attention_outcomes_member ON attention_outcomes(member, ordinal);
CREATE TABLE attention_outcome_seen (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
` };
