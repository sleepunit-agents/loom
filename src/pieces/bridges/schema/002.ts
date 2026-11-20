import type { Migration } from '../../../core/index.js';
/** Pending rows from the foundation already waited; preserve their original budget. */
export const schema: Migration[] = [{ number: 2, sql: `
ALTER TABLE bridges_inbox ADD COLUMN retry_since INTEGER;
UPDATE bridges_inbox SET retry_since=received WHERE state='pending';
` }];
