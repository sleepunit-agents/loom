import type { Migration } from '../../../core/index.js';
/** Private raw receipts precede metadata lookup and the normalized engine inbox. */
export const schema: Migration[] = [{ number: 3, sql: `
CREATE TABLE bridges_slack_receipts (
  id TEXT PRIMARY KEY,
  venue TEXT NOT NULL,
  binding TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','consumed')),
  received INTEGER NOT NULL
);
CREATE INDEX bridges_slack_pending ON bridges_slack_receipts(venue,state,received,id);
` }];
