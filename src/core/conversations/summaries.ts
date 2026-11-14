/** Small Home/People reads over the same conversations as Comms. Never uses
 * question answers as an agent's last reply or subscribes to whole threads. */
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, type GraphQLFieldConfigMap } from 'graphql/index.js';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from '../data/database.js';
import { conversations, members, memberAgents, projectMembers, projectAgents, threads, messages, household } from '../data/schema.js';
import type { WordsKey } from './words.js';

type Conversation = typeof conversations.$inferSelect;
/** Current facts, evaluated by SQLite on every read. Private wins over project
 * or agent ownership; household owners may see another member's private chat. */
function visible(viewer: Viewer): SQL {
  if (viewer.kind !== 'member' && viewer.kind !== 'agent') return sql`false`;
  const owner = viewer.kind === 'member' ? sql`exists(select 1 from ${members} where ${members.id} = ${viewer.id} and ${members.role} = 'owner')` : sql`false`;
  const person = viewer.kind === 'member' ? sql`exists(select 1 from ${members} where ${members.id} = ${viewer.id})` : sql`false`;
  const project = viewer.kind === 'member'
    ? sql`exists(select 1 from ${projectMembers} where ${projectMembers.project} = ${conversations.project} and ${projectMembers.member} = ${viewer.id})`
    : sql`exists(select 1 from ${projectAgents} where ${projectAgents.project} = ${conversations.project} and ${projectAgents.agent} = ${viewer.id})`;
  const agent = viewer.kind === 'member'
    ? sql`exists(select 1 from ${memberAgents} where ${memberAgents.agent} = ${conversations.agent} and ${memberAgents.member} = ${viewer.id})`
    : sql`${conversations.agent} = ${viewer.id}`;
  return sql`(${owner} or case when ${conversations.member} is not null then ${person} and ${conversations.member} = ${viewer.id} else ${project} or ${agent} end)`;
}

export class ConversationSummaries {
  constructor(readonly db: DataDatabase, readonly key: WordsKey, readonly now: () => string = () => new Date().toISOString()) {}

  recent(viewer: Viewer, agent: string, limit = 8): Conversation[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error('Conversation limit must be 1–25');
    return this.db.select().from(conversations).where(and(visible(viewer), eq(conversations.agent, agent)))
      .orderBy(desc(conversations.lastAt), desc(conversations.id)).limit(limit).all();
  }

  /** Words are read only when the client selects lastAnswer. Recheck the exact
   * reply, retention and current sharing after the key operation yields. */
  async lastAnswer(viewer: Viewer, conversation: string): Promise<{ at: string; words: string } | null> {
    const latest = () => this.db.select({ thread: messages.thread, seq: messages.seq, at: messages.at, keepUntil: messages.keepUntil, words: messages.words, agent: conversations.agent, project: conversations.project, member: conversations.member })
      .from(messages).innerJoin(threads, eq(threads.id, messages.thread))
      .innerJoin(conversations, eq(conversations.id, threads.conversation))
      .where(and(visible(viewer), eq(conversations.id, conversation), eq(messages.kind, 'reply'),
        eq(messages.sender, conversations.agent)))
      .orderBy(desc(messages.seq)).limit(1).get();
    const keepDays = () => this.db.select({ days: household.commsDays }).from(household).get()?.days ?? 14;
    const retained = (row: ReturnType<typeof latest>, days: number) => !!row?.words && !!row.keepUntil
      && Number.isInteger(days) && days >= 1 && days <= 14
      && row.keepUntil > this.now() && Date.parse(row.at) + days * 86400000 > Date.parse(this.now());
    const row = latest(), days = keepDays();
    if (!retained(row, days) || !row?.words) return null;
    const words = await this.key.open(row.words);
    const current = latest();
    if (!retained(current, keepDays()) || keepDays() !== days || !current?.words || current.agent !== row.agent || current.project !== row.project || current.member !== row.member || current.at !== row.at || current.thread !== row.thread || current.seq !== row.seq || current.keepUntil !== row.keepUntil || !current.words.equals(row.words)) return null;
    return { at: row.at, words };
  }
}

/** Structural match for DataQueryContext: composition supplies this group to
 * the ONE generated endpoint. No transport or viewer input of its own. */
export function conversationSummaryFields(service: ConversationSummaries): GraphQLFieldConfigMap<unknown, { viewer: Viewer }> {
  const answer = new GraphQLObjectType({ name: 'ConversationLastAnswer', fields: {
    at: { type: new GraphQLNonNull(GraphQLString) }, words: { type: new GraphQLNonNull(GraphQLString) },
  } });
  const summary = new GraphQLObjectType<Conversation, { viewer: Viewer }>({ name: 'ConversationSummary', fields: {
    id: { type: new GraphQLNonNull(GraphQLString) }, agent: { type: new GraphQLNonNull(GraphQLString) },
    label: { type: new GraphQLNonNull(GraphQLString) }, venue: { type: new GraphQLNonNull(GraphQLString) },
    project: { type: GraphQLString }, member: { type: GraphQLString }, lastAt: { type: new GraphQLNonNull(GraphQLString) },
    lastAnswer: { type: answer, resolve: (row, _args, context) => service.lastAnswer(context.viewer, row.id) },
  } });
  return { recentConversations: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(summary))),
    args: { agent: { type: new GraphQLNonNull(GraphQLString) }, limit: { type: GraphQLInt, defaultValue: 8 } },
    resolve: (_row, args, context) => service.recent(context.viewer, args.agent, args.limit),
  } };
}
