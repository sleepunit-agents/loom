/** Generated Activity reads. SQL scope precedes bounds; connected metadata is
 * loaded once per selection rather than once per digest or conversation. */
import { and, asc, desc, eq, getTableColumns, gte, inArray, lt, sql } from 'drizzle-orm';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from './database.js';
import { conversations, digests, turns } from './schema.js';
import { conversationVisibility, talkVisibility } from './conversation-visibility.js';
const protectedSQL = (value: ReturnType<typeof sql>) => sql`${{ getSQL: () => value }}`;
function scope(viewer: Viewer) { return conversationVisibility(viewer).conversations!(getTableColumns(conversations)); }
export function readActivityAgents(db: DataDatabase, viewer: Viewer) {
  return [...new Set(db.query.conversations.findMany({ columns: { agent: true }, where: () => protectedSQL(scope(viewer)) }).sync().map(row => row.agent))];
}
export function readActivityWindow(db: DataDatabase, viewer: Viewer, query: { agent: string; from: number; until: number; limit: number }) {
  const from = new Date(query.from).toISOString(), until = new Date(query.until).toISOString();
  const digestRows = db.query.digests.findMany({ with: { conversationRow: true },
    where: f => and(gte(f.at, from), lt(f.at, until), protectedSQL(sql`exists(select 1 from ${conversations} where ${conversations.id}=${f.conversation} and ${conversations.agent}=${query.agent} and ${scope(viewer)})`)),
    orderBy: f => [desc(f.at), asc(f.id)], limit: query.limit,
  }).sync();
  const moved = db.query.conversations.findMany({ where: f => and(eq(f.agent, query.agent), gte(f.lastAt, from), lt(f.lastAt, until),
    protectedSQL(conversationVisibility(viewer).conversations!(f)),
    protectedSQL(sql`not exists(select 1 from ${digests} where ${digests.conversation}=${f.id} and ${digests.at}>=${from} and ${digests.at}<${until})`)),
    orderBy: f => [desc(f.lastAt), asc(f.id)], limit: query.limit,
  }).sync();
  return { digestRows, moved };
}
export function readActivityConversation(db: DataDatabase, viewer: Viewer, agent: string, id: string) {
  return db.query.conversations.findFirst({ where: f => and(eq(f.id, id), eq(f.agent, agent), protectedSQL(conversationVisibility(viewer).conversations!(f))) }).sync();
}
export function readActivityDigest(db: DataDatabase, viewer: Viewer, agent: string, id: string) {
  return db.query.digests.findFirst({ where: f => and(eq(f.id, id), protectedSQL(sql`exists(select 1 from ${conversations} where ${conversations.id}=${f.conversation} and ${conversations.agent}=${agent} and ${scope(viewer)})`)) }).sync();
}
export function readActivitySet(db: DataDatabase, viewer: Viewer, ids: string[], digestIds: string[], questionIds: string[]) {
  const rows = db.query.conversations.findMany({
    with: { conversationPeopleByConversation: { columns: { who: true }, orderBy: f => asc(f.who) },
      digestsByConversation: { columns: { id: true, at: true, summary: true }, orderBy: f => [desc(f.at), asc(f.id)], limit: 9 } },
    extras: f => ({ replyCount: protectedSQL(sql`(select count(*) from ${turns} where ${turns.conversation}=${f.id} and ${turns.kind}='reply')`).mapWith(Number).as('activity_reply_count') }),
    where: f => and(inArray(f.id, ids), protectedSQL(conversationVisibility(viewer).conversations!(f))),
  }).sync();
  const items = db.query.digestItems.findMany({ where: f => inArray(f.digest, digestIds), orderBy: f => [asc(f.kind), asc(f.text)] }).sync();
  // A digest's question is an Inbox item, so it is read by the Inbox's own rule (policy.ts, tableRules.inbox,
  // which includes that what it waits on is still readable), narrowed here to the viewer's own waiting ones.
  const questions = db.query.inbox.findMany({ columns: { id: true, words: true, link: true, to: true },
    where: f => and(inArray(f.id, questionIds), eq(f.toKind, 'person'), eq(f.to, viewer.id), eq(f.state, 'waiting'),
      viewer.kind === 'member' ? protectedSQL(talkVisibility(viewer).inbox!(f)) : sql`false`),
  }).sync();
  const byConversation = new Map(rows.map(row => [row.id, row]));
  const byDigest = new Map<string, typeof items>();
  for (const item of items) { const group = byDigest.get(item.digest) ?? []; group.push(item); byDigest.set(item.digest, group); }
  const byQuestion = new Map(questions.map(row => [row.id, row]));
  return { conversation: (id: string) => byConversation.get(id), items: (id: string) => byDigest.get(id) ?? [], question: (id: string) => byQuestion.get(id) };
}
export type ActivityReadSet = ReturnType<typeof readActivitySet>;
