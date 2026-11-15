/** Unified Inbox reads for the generated query composition. The authenticated
 * door supplies current SQL visibility; no default policy or new transport. */
import { and, asc, desc, eq, getTableColumns, is, sql, SQL, type AnyColumn } from 'drizzle-orm';
import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, type GraphQLFieldConfigMap } from 'graphql/index.js';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from '../data/database.js';
import { actionResults, household, inbox, inboxReads, inboxRefs, messages, threads } from '../data/schema.js';
import type { WordsKey } from './words.js';

type Item = typeof inbox.$inferSelect;
type Body = { words: string; why?: string | null; ifYes?: string | null; ifNo?: string | null; link?: string | null };
export type InboxQueryPolicy = (viewer: Viewer, fields: Record<string, AnyColumn>) => SQL;
export type InboxFilter = { state?: Item['state']; source?: Item['source']; agent?: string; limit?: number; offset?: number; search?: string };

export class InboxQueries {
  constructor(readonly db: DataDatabase, readonly key: WordsKey, readonly policy: InboxQueryPolicy,
    readonly now: () => string = () => new Date().toISOString()) {}

  private allowed(viewer: Viewer) {
    const allowed = this.policy(viewer, getTableColumns(inbox));
    if (!is(allowed, SQL)) throw new Error('SQL Inbox visibility required');
    return allowed;
  }
  private current(viewer: Viewer, id: string) {
    return this.db.select().from(inbox).where(and(eq(inbox.id, id), this.allowed(viewer))).get();
  }
  item(viewer: Viewer, id: string): Item | null { return this.current(viewer, id) ?? null; }
  list(viewer: Viewer, filter: InboxFilter = {}): Item[] {
    const { limit = 50, offset = 0 } = filter;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 10000) throw new Error('Invalid Inbox page');
    // The personal app always shows its recipient's mailbox. Other apps may
    // use the generated table projection for visible records addressed elsewhere.
    if (viewer.kind !== 'member' && viewer.kind !== 'agent') return [];
    return this.mailbox(viewer, filter).limit(limit).offset(offset).all();
  }
  private mailbox(viewer: Viewer, filter: InboxFilter) {
    return this.db.select().from(inbox).where(and(this.allowed(viewer), eq(inbox.to, viewer.id),
      eq(inbox.toKind, viewer.kind === 'member' ? 'person' : 'agent'),
      filter.state ? eq(inbox.state, filter.state) : undefined,
      filter.source ? eq(inbox.source, filter.source) : undefined,
      filter.agent ? eq(inbox.agent, filter.agent) : undefined))
      .orderBy(desc(sql`julianday(${inbox.at})`), desc(inbox.id));
  }

  /** Search the recipient's whole mailbox before paging. Private text is opened
   * only through body(), and is never indexed or written back to the database. */
  async search(viewer: Viewer, filter: InboxFilter = {}): Promise<Item[]> {
    const query = filter.search?.trim().toLocaleLowerCase() ?? '';
    // Validate the same page bounds even for an empty or unauthorized mailbox.
    this.list(viewer, filter);
    if (!query) return this.list(viewer, filter);
    if (viewer.kind !== 'member' && viewer.kind !== 'agent') return [];
    const candidates = this.mailbox(viewer, filter).all();
    const privateState = (item: Item) => {
      const message = item.thread ? this.db.select().from(messages).where(and(eq(messages.thread, item.thread),
        eq(messages.seq, item.messageSeq ?? -1), eq(messages.inboxItem, item.id))).get() : undefined;
      const keep = this.db.select({ days: household.commsDays }).from(household).get()?.days ?? 14;
      const thread = item.thread ? this.db.select().from(threads).where(eq(threads.id, item.thread)).get() : undefined;
      return { message, keep, thread };
    };
    const metadata = (item: Item) => [item.id, item.source, item.sourceId, item.fromId, item.agent, item.project,
        ...this.refs(viewer, item.id)].some(value => value?.toLocaleLowerCase().includes(query));
    const matches: { item: Item; metadata?: true; state?: ReturnType<typeof privateState> }[] = [];
    for (const item of candidates) {
      if (metadata(item)) { matches.push({ item, metadata: true }); continue; }
      const state = item.thread ? privateState(item) : undefined;
      const body = await this.body(viewer, item.id);
      if (body && Object.values(body).some(value => value?.toLocaleLowerCase().includes(query))) matches.push({ item, state });
    }
    // A later decrypt may yield while earlier matches lose access, change words
    // or expire. Validate every match again synchronously before returning ids.
    const current = matches.filter(({ item, state, metadata: byMetadata }) => {
      if (JSON.stringify(this.current(viewer, item.id)) !== JSON.stringify(item)) return false;
      if (byMetadata) return metadata(item);
      if (!state) return true;
      const after = privateState(item), message = after.message;
      return JSON.stringify(after) === JSON.stringify(state) && !!message?.words && !!message.keepUntil
        && Number.isInteger(after.keep) && after.keep >= 1 && after.keep <= 14
        && message.keepUntil > this.now() && Date.parse(message.at) + after.keep * 86400000 > Date.parse(this.now());
    });
    return current.slice(filter.offset ?? 0, (filter.offset ?? 0) + (filter.limit ?? 50)).map(({ item }) => item);
  }
  results(viewer: Viewer, limit = 20): (typeof actionResults.$inferSelect)[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid action result limit');
    if (viewer.kind !== 'member') return [];
    return this.db.select().from(actionResults).where(eq(actionResults.member, viewer.id))
      .orderBy(desc(sql`julianday(${actionResults.at})`), desc(actionResults.id)).limit(limit).all();
  }
  refs(viewer: Viewer, id: string): string[] {
    return this.db.select({ ref: inboxRefs.ref }).from(inboxRefs).innerJoin(inbox, eq(inbox.id, inboxRefs.item))
      .where(and(eq(inbox.id, id), this.allowed(viewer))).orderBy(asc(inboxRefs.ref)).all().map(row => row.ref);
  }
  read(viewer: Viewer, id: string): boolean {
    return viewer.kind === 'member' && !!this.db.select({ item: inboxReads.item }).from(inboxReads).innerJoin(inbox, eq(inbox.id, inboxReads.item))
      .where(and(eq(inbox.id, id), eq(inboxReads.member, viewer.id), this.allowed(viewer))).get();
  }
  async body(viewer: Viewer, id: string): Promise<Body | null> {
    const item = this.current(viewer, id);
    if (!item) return null;
    if (!item.thread) return item.words === null ? null : { words: item.words, why: item.why, ifYes: item.ifYes, ifNo: item.ifNo, link: item.link };
    const row = () => this.db.select({ message: messages, conversation: threads.conversation }).from(messages)
      .innerJoin(threads, eq(threads.id, messages.thread))
      .where(and(eq(messages.thread, item.thread!), eq(messages.seq, item.messageSeq ?? -1), eq(messages.inboxItem, id))).get();
    const days = () => this.db.select({ days: household.commsDays }).from(household).get()?.days ?? 14;
    const retained = (entry: ReturnType<typeof row>, keep: number) => !!entry?.message.words && !!entry.message.keepUntil
      && entry.conversation === item.conversation && Number.isInteger(keep) && keep >= 1 && keep <= 14
      && entry.message.keepUntil > this.now() && Date.parse(entry.message.at) + keep * 86400000 > Date.parse(this.now());
    const before = row(), keep = days();
    if (!retained(before, keep) || !before?.message.words) return null;
    const words = await this.key.open(before.message.words);
    const after = row(), current = this.current(viewer, id);
    if (!current || JSON.stringify(current) !== JSON.stringify(item) || !retained(after, days()) || days() !== keep
      || !after?.message.words || after.message.at !== before.message.at || after.message.kind !== before.message.kind
      || after.message.keepUntil !== before.message.keepUntil || !after.message.words.equals(before.message.words)) return null;
    if (before.message.kind !== 'ask') return { words };
    // Private questions are the existing Comms encrypted envelope, not a JSON
    // database column. Parse only the named display fields, never arbitrary keys.
    try {
      const value: unknown = JSON.parse(words);
      if (!value || typeof value !== 'object' || !('words' in value) || typeof value.words !== 'string') return null;
      const result: Body = { words: value.words };
      for (const field of ['why', 'ifYes', 'ifNo', 'link'] as const) if (field in value) {
        const text = (value as Record<string, unknown>)[field];
        if (text !== undefined && text !== null && typeof text !== 'string') return null;
        result[field] = text as string | null | undefined;
      }
      return result;
    } catch { return null; }
  }
}

export function inboxQueryFields(service: InboxQueries): GraphQLFieldConfigMap<unknown, { viewer: Viewer }> {
  const body = new GraphQLObjectType({ name: 'InboxItemBody', fields: {
    words: { type: new GraphQLNonNull(GraphQLString) }, why: { type: GraphQLString },
    ifYes: { type: GraphQLString }, ifNo: { type: GraphQLString }, link: { type: GraphQLString },
  } });
  const item = new GraphQLObjectType<Item, { viewer: Viewer }>({ name: 'InboxItemView', fields: {
    ...Object.fromEntries(['id', 'toKind', 'to', 'source', 'fromKind', 'at', 'state', 'volume', 'changedAt'].map(name => [name, { type: new GraphQLNonNull(GraphQLString) }])),
    ...Object.fromEntries(['conversation', 'sourceId', 'fromId', 'agent', 'project', 'member', 'answers', 'waitsOnKind', 'waitsOnId', 'thread', 'answer', 'answerText', 'answeredBy', 'answeredAt', 'resolution'].map(name => [name, { type: GraphQLString }])),
    seq: { type: GraphQLInt },
    body: { type: body, resolve: (row, _args, context) => service.body(context.viewer, row.id) },
    refs: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))), resolve: (row, _args, context) => service.refs(context.viewer, row.id) },
    read: { type: new GraphQLNonNull(GraphQLBoolean), resolve: (row, _args, context) => service.read(context.viewer, row.id) },
  } });
  const result = new GraphQLObjectType({ name: 'InboxActionResult', fields: {
    id: { type: new GraphQLNonNull(GraphQLString) }, at: { type: new GraphQLNonNull(GraphQLString) },
    ok: { type: new GraphQLNonNull(GraphQLBoolean) }, text: { type: new GraphQLNonNull(GraphQLString) },
    page: { type: GraphQLString }, readAt: { type: GraphQLString },
  } });
  return { inboxItem: {
    type: item, args: { id: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: (_row, args, context) => service.item(context.viewer, args.id),
  }, inboxActionResults: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(result))),
    args: { limit: { type: GraphQLInt, defaultValue: 20 } },
    resolve: (_row, args, context) => service.results(context.viewer, args.limit),
  }, inboxItems: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(item))),
    args: { search: { type: GraphQLString }, state: { type: GraphQLString }, source: { type: GraphQLString }, agent: { type: GraphQLString }, limit: { type: GraphQLInt, defaultValue: 50 }, offset: { type: GraphQLInt, defaultValue: 0 } },
    resolve: (_row, args, context) => args.search === undefined ? service.list(context.viewer, args) : service.search(context.viewer, args),
  } };
}
