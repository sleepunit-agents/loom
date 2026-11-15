/** Wordless conversation history uses the same ordered scope as Comms.
 * Every child checks its current parent, including nested/generated reads. */
import { getTableColumns, sql, type AnyColumn } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { Viewer } from '../../policy.js';
import type { QueryVisibility } from './queries.js';
import { conversations, digests } from './schema.js';
import { workVisibility } from './work-visibility.js';
export const conversationTables = ['conversations','conversationPeople','turns','digests','digestItems','conversationDays','findings'] as const;
export function conversationVisibility(viewer: Viewer): QueryVisibility {
 const parent=alias(conversations,'visible_conversation'),digest=alias(digests,'visible_digest');
 const allowed=workVisibility(viewer).approvals!;
 const scope=allowed(getTableColumns(parent));
 const hasVisibleConversation=(id:AnyColumn)=>sql`exists (select 1 from ${conversations} as ${sql.identifier('visible_conversation')} where ${parent.id} = ${id} and ${scope})`;
 return {
  conversations:allowed,
  conversationPeople:f=>hasVisibleConversation(f.conversation),turns:f=>hasVisibleConversation(f.conversation),digests:f=>hasVisibleConversation(f.conversation),
  conversationDays:f=>hasVisibleConversation(f.conversation),findings:f=>hasVisibleConversation(f.conversation),
  digestItems:f=>sql`exists (select 1 from ${digests} as ${sql.identifier('visible_digest')} where ${digest.id} = ${f.digest} and ${hasVisibleConversation(digest.conversation)})`,
 };
}
