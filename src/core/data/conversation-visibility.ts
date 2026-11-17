/** Wordless conversation history uses the same labelled-record rule as Comms.
 * Every child is seen with its current parent. The rules are stated in policy.ts. */
import type { Viewer } from '../../policy.js';
import { sqlVisibility } from '../../policy-sql.js';
import type { QueryVisibility } from './queries.js';
export const conversationTables = ['conversations','conversationPeople','turns','digests','digestItems','conversationDays','findings'] as const;
export function conversationVisibility(viewer: Viewer): QueryVisibility {
 return sqlVisibility(viewer, conversationTables);
}
/** What hangs off a conversation and carries its words: its jobs (title, brief, log tail) and its Inbox
 * items. These have their own readers, so they are not in the table list above. */
export function talkVisibility(viewer: Viewer) {
 return sqlVisibility(viewer, ['jobs', 'inbox']);
}
