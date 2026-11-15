/** Shared Comms read projection. Composition owns current SQL sharing and the
 * authenticated query door; metadata never loads private ciphertext. */
import { and, asc, desc, eq, getTableColumns, is, isNotNull, isNull, lt, SQL, type AnyColumn } from 'drizzle-orm';
import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, type GraphQLFieldConfigMap } from 'graphql/index.js';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from '../data/database.js';
import { conversations, household, messages, threadRefs, threads } from '../data/schema.js';
import type { WordsKey } from './words.js';
type Message = typeof messages.$inferSelect;
type MessageView = Omit<Message, 'words'> & Pick<typeof conversations.$inferSelect, 'agent' | 'project' | 'member'> & { conversation: string };
const { words: _words, ...metadata } = getTableColumns(messages);
const threadFields = { ...getTableColumns(threads), agent: conversations.agent, project: conversations.project, member: conversations.member };
export type CommsQueryPolicy = (viewer: Viewer, fields: Record<string, AnyColumn>) => SQL;
const limit = (value: number, max: number) => { if (!Number.isInteger(value) || value < 1 || value > max) throw new Error('Invalid Comms page size'); return value; };

export class CommsQueries {
  constructor(readonly db: DataDatabase, readonly key: WordsKey, readonly policy: CommsQueryPolicy, readonly now: () => string = () => new Date().toISOString()) {}
  private allowed(viewer: Viewer) {
    const allowed = this.policy(viewer, getTableColumns(conversations));
    if (!is(allowed, SQL)) throw new Error('SQL conversation visibility required');
    return allowed;
  }
  list(viewer: Viewer, input: { member?: string; agent?: string; archived?: boolean; limit?: number; offset?: number } = {}) {
    const count = limit(input.limit ?? 50, 100), offset = input.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000) throw new Error('Invalid Comms offset');
    const member = input.member ?? (viewer.kind === 'member' ? viewer.id : undefined);
    return this.db.select(threadFields).from(threads).innerJoin(conversations, eq(conversations.id, threads.conversation))
      .where(and(this.allowed(viewer), member ? eq(conversations.member, member) : undefined,
        input.agent ? eq(conversations.agent, input.agent) : undefined,
        input.archived ? isNotNull(threads.archivedAt) : isNull(threads.archivedAt)))
      .orderBy(desc(threads.pinned), desc(threads.lastAt), asc(threads.id)).limit(count).offset(offset).all();
  }
  thread(viewer: Viewer, id: string) {
    return this.db.select(threadFields).from(threads).innerJoin(conversations, eq(conversations.id, threads.conversation))
      .where(and(eq(threads.id, id), this.allowed(viewer))).get() ?? null;
  }
  messages(viewer: Viewer, thread: string, beforeSeq?: number, count = 50) {
    limit(count, 100);
    if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1)) throw new Error('Invalid message cursor');
    return this.db.select({ ...metadata, conversation: conversations.id, agent: conversations.agent, project: conversations.project, member: conversations.member }).from(messages).innerJoin(threads, eq(threads.id, messages.thread))
      .innerJoin(conversations, eq(conversations.id, threads.conversation))
      .where(and(eq(threads.id, thread), this.allowed(viewer), beforeSeq === undefined ? undefined : lt(messages.seq, beforeSeq)))
      .orderBy(desc(messages.seq)).limit(count).all().reverse();
  }
  refs(viewer: Viewer, thread: string, count = 100) {
    limit(count, 200);
    return this.db.select({ ref: threadRefs.ref, messageSeq: threadRefs.messageSeq }).from(threadRefs)
      .innerJoin(threads, eq(threads.id, threadRefs.thread)).innerJoin(conversations, eq(conversations.id, threads.conversation))
      .where(and(eq(threads.id, thread), this.allowed(viewer)))
      .orderBy(desc(threadRefs.messageSeq), asc(threadRefs.ref)).limit(count).all();
  }
  async words(viewer: Viewer, expected: MessageView): Promise<string | null> {
    const row = () => this.db.select({ message: messages, agent: conversations.agent, project: conversations.project, member: conversations.member, conversation: conversations.id })
      .from(messages).innerJoin(threads, eq(threads.id, messages.thread)).innerJoin(conversations, eq(conversations.id, threads.conversation))
      .where(and(eq(messages.thread, expected.thread), eq(messages.seq, expected.seq), this.allowed(viewer))).get();
    const days = () => this.db.select({ days: household.commsDays }).from(household).get()?.days ?? 14;
    const retained = (entry: ReturnType<typeof row>, keep: number) => !!entry?.message.words && !!entry.message.keepUntil
      && Number.isInteger(keep) && keep >= 1 && keep <= 14 && Date.parse(entry.message.keepUntil) > Date.parse(this.now())
      && Date.parse(entry.message.at) + keep * 86400000 > Date.parse(this.now());
    const same = (message: Message) => ['at', 'sender', 'kind', 'keepUntil', 'inboxItem'].every(key => message[key as keyof Message] === expected[key as keyof typeof expected]);
    const scope = (entry: ReturnType<typeof row>) => !!entry && entry.agent === expected.agent && entry.project === expected.project && entry.member === expected.member && entry.conversation === expected.conversation;
    const before = row(), keep = days();
    if (!retained(before, keep) || !before?.message.words || !same(before.message) || !scope(before)) return null;
    const words = await this.key.open(before.message.words);
    const after = row();
    if (!retained(after, days()) || days() !== keep || !after?.message.words || !same(after.message) || !scope(after)
      || after.agent !== before.agent || after.project !== before.project || after.member !== before.member || after.conversation !== before.conversation
      || !after.message.words.equals(before.message.words)) return null;
    return words;
  }
}

export function commsQueryFields(service: CommsQueries): GraphQLFieldConfigMap<unknown, { viewer: Viewer }> {
  const thread = new GraphQLObjectType({ name: 'CommsThreadView', fields: {
    ...Object.fromEntries(['id', 'conversation', 'title', 'titledBy', 'agent', 'openedAt', 'lastAt'].map(name => [name, { type: new GraphQLNonNull(GraphQLString) }])),
    ...Object.fromEntries(['project', 'member', 'archivedAt', 'workingSince', 'workingBeat'].map(name => [name, { type: GraphQLString }])),
    ...Object.fromEntries(['pinned', 'working', 'stopRequested'].map(name => [name, { type: new GraphQLNonNull(GraphQLBoolean) }])),
    readSeq: { type: new GraphQLNonNull(GraphQLInt) },
  } });
  const message = new GraphQLObjectType<MessageView, { viewer: Viewer }>({ name: 'CommsMessageView', fields: {
    ...Object.fromEntries(['thread', 'kind', 'sender', 'at'].map(name => [name, { type: new GraphQLNonNull(GraphQLString) }])),
    ...Object.fromEntries(['keepUntil', 'delivery', 'inboxItem', 'verdict', 'run', 'tool', 'cardState', 'clientId'].map(name => [name, { type: GraphQLString }])),
    seq: { type: new GraphQLNonNull(GraphQLInt) }, words: { type: GraphQLString, resolve: (row, _args, context) => service.words(context.viewer, row) },
  } });
  const ref = new GraphQLObjectType({ name: 'CommsReferenceView', fields: { ref: { type: new GraphQLNonNull(GraphQLString) }, messageSeq: { type: new GraphQLNonNull(GraphQLInt) } } });
  const many = (type: GraphQLObjectType<any, any>) => new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(type)));
  const id = { type: new GraphQLNonNull(GraphQLString) };
  return {
    commsThreads: { type: many(thread), args: { member: { type: GraphQLString }, agent: { type: GraphQLString }, archived: { type: GraphQLBoolean }, limit: { type: GraphQLInt }, offset: { type: GraphQLInt } }, resolve: (_row, args, context) => service.list(context.viewer, args) },
    commsThread: { type: thread, args: { id }, resolve: (_row, args, context) => service.thread(context.viewer, args.id) },
    commsMessages: { type: many(message), args: { thread: id, beforeSeq: { type: GraphQLInt }, limit: { type: GraphQLInt, defaultValue: 50 } }, resolve: (_row, args, context) => service.messages(context.viewer, args.thread, args.beforeSeq, args.limit) },
    commsRefs: { type: many(ref), args: { thread: id, limit: { type: GraphQLInt, defaultValue: 100 } }, resolve: (_row, args, context) => service.refs(context.viewer, args.thread, args.limit) },
  };
}
