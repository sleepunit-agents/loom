import type { Database } from 'better-sqlite3';

export const CONVERSATION_TABLES = ['conversations', 'conversation_turns', 'conversation_days', 'conversation_digests'] as const;

/** The historical Memory layout, for checking upgrades against real legacy columns and indexes. */
export function createConversationTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id          TEXT PRIMARY KEY,
      agent       TEXT NOT NULL,
      venue       TEXT NOT NULL,
      place       TEXT NOT NULL,
      label       TEXT,
      people_json TEXT NOT NULL DEFAULT '[]',
      agents_json TEXT NOT NULL DEFAULT '[]',
      started     TEXT NOT NULL,
      last        TEXT NOT NULL,
      last_seq    INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_last ON conversations(last);
    CREATE TABLE IF NOT EXISTS conversation_turns (
      conversation TEXT NOT NULL,
      seq          INTEGER NOT NULL,
      at           TEXT NOT NULL,
      from_json    TEXT NOT NULL,
      kind         TEXT NOT NULL,
      run          TEXT,
      latency_ms   INTEGER,
      model        TEXT,
      harness      TEXT,
      outcome      TEXT,
      writer       TEXT NOT NULL,
      PRIMARY KEY (conversation, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_turns_at ON conversation_turns(at);
    CREATE TABLE IF NOT EXISTS conversation_days (
      conversation      TEXT NOT NULL,
      day               TEXT NOT NULL,
      counts_json       TEXT NOT NULL,
      median_latency_ms INTEGER,
      outcomes_json     TEXT NOT NULL,
      PRIMARY KEY (conversation, day)
    );
    CREATE TABLE IF NOT EXISTS conversation_digests (
      id             TEXT PRIMARY KEY,
      conversation   TEXT NOT NULL,
      run            TEXT NOT NULL,
      at             TEXT NOT NULL,
      summary        TEXT NOT NULL,
      asks_json      TEXT NOT NULL,
      decisions_json TEXT NOT NULL,
      tasks_json     TEXT NOT NULL,
      projects_json  TEXT NOT NULL,
      needs_owner    TEXT,
      needs_owner_href TEXT,
      needs_owner_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_digests_conv ON conversation_digests(conversation, at);
    CREATE INDEX IF NOT EXISTS idx_conversation_digests_at ON conversation_digests(at);
  `);
}
