/** The sessions that worked a ticket (docs/specs/boards.md, "Sessions"): the handed-off conversations whose
 * `conversation.handoff` named it (`conversation_tasks`), each with its latest job. Nothing is inferred from words.
 *
 * It answers a signed-in member, for a ticket they may read, and lists only the conversations and jobs the
 * existing rules already let them read (policy.ts, `conversation` and `inTalk`). Anybody else reads an empty list. */
import { and, desc, eq, getTableColumns, sql } from 'drizzle-orm';
import { GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, type GraphQLFieldConfigMap } from 'graphql/index.js';
import type { Viewer } from '../../policy.js';
import { conversationVisibility, talkVisibility } from '../data/conversation-visibility.js';
import type { DataDatabase } from '../data/database.js';
import { conversations, conversationTasks, jobs, tasks } from '../data/schema.js';
import { taskVisibility } from '../data/visibility.js';

export interface TicketSession { conversation: string; agent: string; job: string | null; title: string; state: string | null; at: string }

/** Newest first, by when the latest job was queued; a handoff that has no job yet (a scheduled one) by when it was opened. */
export function ticketSessions(db: DataDatabase, viewer: Viewer, ticket: string): TicketSession[] {
  if (viewer.kind !== 'member') return [];
  if (!db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.id, ticket), taskVisibility(viewer).tasks!(getTableColumns(tasks)))).get()) return [];
  const seen = conversationVisibility(viewer).conversations!(getTableColumns(conversations)), job = talkVisibility(viewer).jobs!(getTableColumns(jobs));
  return db.select({ conversation: conversations.id, agent: conversations.agent, label: conversations.label, startedAt: conversations.startedAt }).from(conversationTasks)
    .innerJoin(conversations, eq(conversations.id, conversationTasks.conversation)).where(and(eq(conversationTasks.task, ticket), seen)).all()
    .map(cv => {
      const latest = db.select({ id: jobs.id, title: jobs.title, state: jobs.state, queuedAt: jobs.queuedAt }).from(jobs)
        .where(and(eq(jobs.conversation, cv.conversation), job)).orderBy(desc(jobs.queuedAt), desc(sql`jobs.rowid`)).limit(1).get();
      return { conversation: cv.conversation, agent: cv.agent, job: latest?.id ?? null, title: latest?.title || cv.label, state: latest?.state ?? null, at: latest?.queuedAt ?? cv.startedAt };
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.conversation.localeCompare(a.conversation));
}

export function ticketSessionFields(db: DataDatabase): GraphQLFieldConfigMap<unknown, { viewer: Viewer }> {
  const text = { type: new GraphQLNonNull(GraphQLString) };
  const session = new GraphQLObjectType<TicketSession>({ name: 'TicketSession', fields: {
    conversation: text, agent: text, title: text, at: text, job: { type: GraphQLString }, state: { type: GraphQLString },
  } });
  return {
    ticketSessions: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(session))), args: { ticket: text },
      resolve: (_row, args: { ticket: string }, context) => ticketSessions(db, context.viewer, args.ticket) },
  };
}
