import type { Migration } from '../../../core/index.js';
/** Global age scans must not walk permanent consumed tombstones. */
export const schema: Migration[] = [{ number: 6, sql: `
CREATE INDEX bridges_discord_raw_expiry ON bridges_discord_receipts(received,id) WHERE state='pending';
CREATE INDEX bridges_slack_raw_expiry ON bridges_slack_receipts(received,id) WHERE state='pending';
` }];
