import { and, asc, desc, getTableColumns, inArray, or, sql } from 'drizzle-orm';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from './database.js';
import { conversations } from './schema.js';
import { conversationVisibility } from './conversation-visibility.js';

/** The Project hub needs all matching IDs for its other sections, but only
 * the first fifty rows' people. Both batches apply current SQL visibility. */
export function readProjectConversations(db: DataDatabase, viewer: Viewer, names: string[], venues: string[]) {
  const rows = db.query.conversations.findMany({ columns: { id: true, label: true, lastAt: true },
    where: f => {
      const allowed = conversationVisibility(viewer).conversations!(f);
      return and(sql`${{ getSQL: () => allowed }}`, or(inArray(f.project, names), inArray(sql`${f.venue} || ':' || ${f.place}`, venues), inArray(sql`${f.venue} || ':' || ${f.id}`, venues)));
    }, orderBy: f => [desc(f.lastAt), asc(f.id)],
  }).sync();
  const allowed = conversationVisibility(viewer).conversations!(getTableColumns(conversations));
  const people = db.query.conversationPeople.findMany({ columns: { conversation: true, who: true },
    where: f => and(inArray(f.conversation, rows.slice(0, 50).map(row => row.id)), sql`${{ getSQL: () => sql`exists(select 1 from ${conversations} where ${conversations.id}=${f.conversation} and ${allowed})` }}`),
  }).sync();
  const byConversation = new Map<string, string[]>();
  for (const row of people) { const group = byConversation.get(row.conversation) ?? []; group.push(row.who); byConversation.set(row.conversation, group); }
  return { rows, people: (id: string) => byConversation.get(id) ?? [] };
}
