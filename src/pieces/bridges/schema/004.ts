import type { Migration } from '../../../core/index.js';
/** Private Gateway cursor and message words never become live records. */
export const schema: Migration[] = [{ number: 4, sql: `
CREATE TABLE bridges_discord_sessions (
  binding TEXT PRIMARY KEY,
  checkpoint TEXT NOT NULL
);
CREATE TABLE bridges_discord_receipts (
  id TEXT PRIMARY KEY,
  venue TEXT NOT NULL,
  binding TEXT NOT NULL,
  message_id TEXT NOT NULL,
  event TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','consumed')),
  received INTEGER NOT NULL
);
CREATE INDEX bridges_discord_pending ON bridges_discord_receipts(venue,binding,state,received,id);
` }];
