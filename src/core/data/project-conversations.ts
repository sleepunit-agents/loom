import { and, asc, desc, getTableColumns, inArray, or, sql } from 'drizzle-orm';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from './database.js';
import { conversations } from './schema.js';
import { conversationVisibility } from './conversation-visibility.js';

interface Scope {names:string[]; venues:string[]}
function indexScopes(scopes: Scope[], field: keyof Scope) {
  const index = new Map<string, number[]>();
  scopes.forEach((scope,i) => {
    for (const key of new Set(scope[field])) {
      const matches = index.get(key) ?? [];
      matches.push(i);
      index.set(key,matches);
    }
  });
  return index;
}
const values = (keys: Iterable<string>) => sql`(select value from json_each(${JSON.stringify([...keys])}))`;

/** Select visible conversations once. Each card needs every matching ID and
 * the participants of its own fifty newest conversations. */
export function readProjectConversations(db: DataDatabase, viewer: Viewer, scopes: Scope[]) {
  const projects = indexScopes(scopes,'names'), venues = indexScopes(scopes,'venues');
  const venueKeys = values(venues.keys());
  const rows = db.query.conversations.findMany({ columns: { id:true, label:true, lastAt:true, project:true, venue:true, place:true },
    where: f => {
      const allowed = conversationVisibility(viewer).conversations!(f);
      return and(sql`${{ getSQL: () => allowed }}`, or(inArray(f.project, values(projects.keys())), inArray(sql`${f.venue} || ':' || ${f.place}`, venueKeys), inArray(sql`${f.venue} || ':' || ${f.id}`, venueKeys)));
    }, orderBy: f => [desc(f.lastAt), asc(f.id)],
  }).sync();
  const groups = scopes.map(():typeof rows=>[]);
  const previewIds = new Set<string>();
  for (const row of rows) {
    const found = new Set([
      ...(row.project===null ? [] : projects.get(row.project)??[]),
      ...(venues.get(row.venue+':'+row.place)??[]),
      ...(venues.get(row.venue+':'+row.id)??[]),
    ]);
    for (const i of found) {
      const group=groups[i]!;
      if (group.length<50) previewIds.add(row.id);
      group.push(row);
    }
  }
  const allowed = conversationVisibility(viewer).conversations!(getTableColumns(conversations));
  const people = db.query.conversationPeople.findMany({ columns: { conversation:true, who:true },
    where: f => and(inArray(f.conversation, values(previewIds)), sql`${{ getSQL: () => sql`exists(select 1 from ${conversations} where ${conversations.id}=${f.conversation} and ${allowed})` }}`),
  }).sync();
  const byConversation = new Map<string, string[]>();
  for (const row of people) { const group = byConversation.get(row.conversation) ?? []; group.push(row.who); byConversation.set(row.conversation, group); }
  return { groups, people: (id:string) => byConversation.get(id) ?? [] };
}
