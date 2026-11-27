/** The tickets a handed-off session was said to be for (`conversation_tasks`; docs/specs/boards.md, "A ticket's
 * sessions"). This file is the table's one writer: `conversation.handoff` links, and a deleted thread unlinks. */
import { inArray } from 'drizzle-orm';
import type { DataDatabase } from '../data/database.js';
import { conversationTasks } from '../data/schema.js';

export function linkHandoffTickets(db: DataDatabase, conversation: string, tickets: readonly string[]): void {
  if (tickets.length) db.insert(conversationTasks).values(tickets.map(task => ({ conversation, task }))).onConflictDoNothing().run();
}
/** The sessions handed off from a deleted thread are no longer listed on their tickets. */
export function unlinkHandoffTickets(db: DataDatabase, conversations: readonly string[]): void {
  if (conversations.length) db.delete(conversationTasks).where(inArray(conversationTasks.conversation, [...conversations])).run();
}
