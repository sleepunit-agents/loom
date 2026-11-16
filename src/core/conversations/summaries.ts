import { readAll } from '../data/execution.js';
import { conversationVisibility } from '../data/conversation-visibility.js';
import { readRecentConversations, readConversationAnswers, type ConversationAnswerSet } from '../data/conversation-summaries.js';
import { selectedQueryFields } from '../data/queries.js';
import { wordsDeadline } from './retention.js';
/** Small Home/People reads over the same conversations as Comms. Never uses
 * question answers as an agent's last reply or subscribes to whole threads. */
import { and, desc, eq, getTableColumns } from 'drizzle-orm';
import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, type GraphQLFieldConfigMap, type GraphQLResolveInfo } from 'graphql/index.js';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from '../data/database.js';
import { conversations, threads, messages, household } from '../data/schema.js';
import { keepReadUntil } from '../data/read-lease.js';
import type { WordsKey } from './words.js';

const projected = Symbol('Conversation answer projection');
type Answer = { at: string; words: string } | null;
type Conversation = typeof conversations.$inferSelect & { [projected]?: Answer };
export class ConversationSummaries {
  private readSet?: ConversationAnswerSet;
  constructor(readonly db: DataDatabase, readonly key: WordsKey, readonly now: () => string = () => new Date().toISOString()) {}

  recent(viewer: Viewer, agent: string, limit = 8, answeredOnly = false): Conversation[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error('Conversation limit must be 1–25');
    return readRecentConversations(this.db, viewer, agent, limit, answeredOnly);
  }

  async project(viewer: Viewer, rows: Conversation[], info: GraphQLResolveInfo, retain: (at: number) => void) {
    if (!rows.length || !selectedQueryFields(info).has('lastAnswer')) return rows;
    const words = selectedQueryFields(info, ['lastAnswer']).has('words');
    const ids = rows.map(row => row.id), before = readConversationAnswers(this.db, viewer, ids, words);
    const service = new ConversationSummaries(this.db, this.key, this.now); service.readSet = before;
    const deadlines: number[] = [];
    const result = await readAll(rows.map(async row => {
      let answer: Answer;
      if (words) answer = await service.lastAnswer(viewer, row.id, at => deadlines.push(at));
      else {
        const current = before.latest(row.id), days = before.days;
        const deadline = current?.keepUntil ? wordsDeadline(current, days) : NaN;
        answer = current?.hasWords && Number.isInteger(days) && days >= 1 && days <= 14 && deadline > Date.parse(this.now()) ? { at: current.at, words: '' } : null;
        if (answer) deadlines.push(deadline);
      }
      return { ...row, [projected]: answer };
    }));
    const after = readConversationAnswers(this.db, viewer, ids, words);
    if (before.fingerprint !== after.fingerprint || deadlines.some(at => at <= Date.parse(this.now()))) throw Error('Conversation changed; retry the query');
    for (const at of deadlines) retain(at);
    return result;
  }

  /** Words are read only when the client selects lastAnswer. Recheck the exact
   * reply, retention and current sharing after the key operation yields. */
  async lastAnswer(viewer: Viewer, conversation: string, retainedUntil?: (at: number) => void): Promise<{ at: string; words: string } | null> {
    const latest = () => this.readSet ? this.readSet.latest(conversation) : this.db.select({ thread: messages.thread, seq: messages.seq, at: messages.at, keepUntil: messages.keepUntil, words: messages.words, agent: conversations.agent, project: conversations.project, member: conversations.member })
      .from(messages).innerJoin(threads, eq(threads.id, messages.thread))
      .innerJoin(conversations, eq(conversations.id, threads.conversation))
      .where(and(conversationVisibility(viewer).conversations!(getTableColumns(conversations)), eq(conversations.id, conversation), eq(messages.kind, 'reply'),
        eq(messages.sender, conversations.agent)))
      .orderBy(desc(messages.seq)).limit(1).get();
    const keepDays = () => this.readSet?.days ?? this.db.select({ days: household.commsDays }).from(household).get()?.days ?? 14;
    const retained = (row: ReturnType<typeof latest>, days: number) => !!row?.words && !!row.keepUntil
      && Number.isInteger(days) && days >= 1 && days <= 14
      && Date.parse(row.keepUntil) > Date.parse(this.now()) && Date.parse(row.at) + days * 86400000 > Date.parse(this.now());
    const row = latest(), days = keepDays();
    if (!retained(row, days) || !row?.words) return null;
    const words = await this.key.open(row.words);
    const current = latest();
    if (!retained(current, keepDays()) || keepDays() !== days || !current?.words || current.agent !== row.agent || current.project !== row.project || current.member !== row.member || current.at !== row.at || current.thread !== row.thread || current.seq !== row.seq || current.keepUntil !== row.keepUntil || !current.words.equals(row.words)) return null;
    retainedUntil?.(wordsDeadline(current, days));
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
    label: { type: new GraphQLNonNull(GraphQLString) }, place: { type: new GraphQLNonNull(GraphQLString) }, venue: { type: new GraphQLNonNull(GraphQLString) },
    project: { type: GraphQLString }, member: { type: GraphQLString }, lastAt: { type: new GraphQLNonNull(GraphQLString) },
    lastAnswer: { type: answer, resolve: (row, _args, context) => Object.hasOwn(row, projected) ? row[projected] : service.lastAnswer(context.viewer, row.id, until => keepReadUntil(context, until)) },
  } });
  return { recentConversations: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(summary))),
    args: { agent: { type: new GraphQLNonNull(GraphQLString) }, limit: { type: GraphQLInt, defaultValue: 8 }, answeredOnly: { type: GraphQLBoolean, defaultValue: false } },
    resolve: (_row, args, context, info) => service.project(context.viewer, service.recent(context.viewer, args.agent, args.limit, args.answeredOnly), info, until => keepReadUntil(context, until)),
  } };
}
