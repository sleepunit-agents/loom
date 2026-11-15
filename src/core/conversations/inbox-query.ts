import { wordsDeadline } from './retention.js';
/** Unified Inbox reads for the generated query composition. The authenticated
 * door supplies current SQL visibility; no default policy or new transport. */
import { and, asc, count, desc, eq, ne, getTableColumns, inArray, is, isNotNull, isNull, sql, SQL, type AnyColumn } from 'drizzle-orm';
import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, type GraphQLFieldConfigMap } from 'graphql/index.js';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from '../data/database.js';
import { actionResults, household, inbox, inboxReads, inboxRefs, messages, threads } from '../data/schema.js';
import { keepReadUntil } from '../data/read-lease.js';
import type { WordsKey } from './words.js';

type Item = typeof inbox.$inferSelect;
type Body = { words: string; why?: string | null; ifYes?: string | null; ifNo?: string | null; link?: string | null };
export type InboxQueryPolicy = (viewer: Viewer, fields: Record<string, AnyColumn>) => SQL;
export type InboxFilter = { folder?: 'needs' | 'alerts' | 'answered' | 'fyi' | 'all'; state?: Item['state']; source?: Item['source']; agent?: string; limit?: number; offset?: number; search?: string };

export class InboxQueries {
  constructor(readonly db: DataDatabase, readonly key: WordsKey, readonly policy: InboxQueryPolicy,
    readonly now: () => string = () => new Date().toISOString()) {}

  private allowed(viewer: Viewer) {
    const allowed = this.policy(viewer, getTableColumns(inbox));
    if (!is(allowed, SQL)) throw new Error('SQL Inbox visibility required');
    return allowed;
  }
  private keepDays() { return this.db.select({ days: household.commsDays }).from(household).get()?.days ?? 14; }
  private retainedMessage(message: typeof messages.$inferSelect | undefined, days: number): boolean {
    return !!message?.words && !!message.keepUntil && Number.isInteger(days) && days >= 1 && days <= 14
      && Date.parse(message.keepUntil) > Date.parse(this.now()) && Date.parse(message.at) + days * 86400000 > Date.parse(this.now());
  }
  private current(viewer: Viewer, id: string) {
    return this.db.select().from(inbox).where(and(eq(inbox.id, id), this.allowed(viewer))).get();
  }
  item(viewer: Viewer, id: string): Item | null { return this.current(viewer, id) ?? null; }
  canAnswer(viewer: Viewer, id: string): boolean {
    const item = this.current(viewer, id);
    return viewer.kind === 'member' && !!item && item.toKind === 'person' && item.to === viewer.id
      && item.state === 'waiting' && !!item.answers && !item.waitsOnKind
      && !['task','approval','secret-request'].includes(item.source);
  }
  list(viewer: Viewer, filter: InboxFilter = {}): Item[] {
    const { limit = 50, offset = 0 } = filter;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 10000) throw new Error('Invalid Inbox page');
    if (filter.folder && !['needs', 'alerts', 'answered', 'fyi', 'all'].includes(filter.folder)) throw new Error('Invalid Inbox folder');
    // The personal app always shows its recipient's mailbox. Other apps may
    // use the generated table projection for visible records addressed elsewhere.
    if (viewer.kind !== 'member' && viewer.kind !== 'agent') return [];
    return this.mailbox(viewer, filter).limit(limit).offset(offset).all();
  }
  private folderWhere(folder?: InboxFilter['folder']) {
    if (folder === 'needs') return and(eq(inbox.state, 'waiting'), isNotNull(inbox.answers))!;
    if (folder === 'alerts') return and(eq(inbox.state, 'waiting'), eq(inbox.source, 'notice'), isNull(inbox.answers))!;
    if (folder === 'fyi') return and(eq(inbox.state, 'waiting'), isNull(inbox.answers))!;
    if (folder === 'answered') return inArray(inbox.state, ['answered', 'resolved', 'done']);
    return sql`true`;
  }
  private mailboxWhere(viewer: Viewer, filter: InboxFilter = {}) {
    return and(this.allowed(viewer), eq(inbox.to, viewer.id),
      eq(inbox.toKind, viewer.kind === 'member' ? 'person' : 'agent'),
      this.folderWhere(filter.folder),
      ne(inbox.volume, 'mute'),
      filter.state ? eq(inbox.state, filter.state) : undefined,
      filter.source ? eq(inbox.source, filter.source) : undefined,
      filter.agent ? eq(inbox.agent, filter.agent) : undefined);
  }
  private mailbox(viewer: Viewer, filter: InboxFilter) {
    return this.db.select().from(inbox).where(this.mailboxWhere(viewer, filter))
      .orderBy(desc(sql`julianday(${inbox.at})`), desc(inbox.id));
  }
  folders(viewer: Viewer) {
    if (viewer.kind !== 'member' && viewer.kind !== 'agent') return { needs: 0, alerts: 0, answered: 0, fyi: 0, all: 0, agents: [] };
    const where = this.mailboxWhere(viewer);
    const totals = this.db.select({
      needs: sql<number>`coalesce(sum(case when ${this.folderWhere('needs')} then 1 else 0 end),0)`,
      alerts: sql<number>`coalesce(sum(case when ${this.folderWhere('alerts')} then 1 else 0 end),0)`,
      fyi: sql<number>`coalesce(sum(case when ${this.folderWhere('fyi')} then 1 else 0 end),0)`,
      answered: sql<number>`coalesce(sum(case when ${this.folderWhere('answered')} then 1 else 0 end),0)`,
      all: count(),
    }).from(inbox).where(where).get()!;
    const agents = this.db.select({ id: inbox.agent, count: count(),
      needs: sql<number>`coalesce(sum(case when ${this.folderWhere('needs')} then 1 else 0 end),0)`,
    }).from(inbox)
      .where(and(where, isNotNull(inbox.agent))).groupBy(inbox.agent).orderBy(asc(inbox.agent)).all()
      .map(row => ({ id: row.id!, count: row.count, needs: row.needs }));
    return { ...totals, agents };
  }

  /** Search the recipient's whole mailbox before paging. Private text is opened
   * only through body(), and is never indexed or written back to the database. */
  async search(viewer: Viewer, filter: InboxFilter = {}, retainedUntil?: (at: number) => void): Promise<Item[]> {
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
      if (body && [body.words, body.why, body.ifYes, body.ifNo, body.link].some(value => value?.toLocaleLowerCase().includes(query))) matches.push({ item, state });
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
        && Date.parse(message.keepUntil) > Date.parse(this.now()) && Date.parse(message.at) + after.keep * 86400000 > Date.parse(this.now());
    });
    const page = current.slice(filter.offset ?? 0, (filter.offset ?? 0) + (filter.limit ?? 50));
    for (const match of page) if (!match.metadata && match.state?.message) {
      const message = match.state.message;
      retainedUntil?.(wordsDeadline(message, match.state.keep));
    }
    return page.map(({ item }) => item);
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
  private deadline(message: Pick<typeof messages.$inferSelect, 'at' | 'keepUntil'> | undefined): string | null {
    const days = this.keepDays();
    if (!message?.keepUntil || !Number.isInteger(days) || days < 1 || days > 14) return null;
    const at = wordsDeadline(message, days);
    return Number.isFinite(at) ? new Date(at).toISOString() : null;
  }
  private answerState(viewer: Viewer, item: Item) {
    if (!item.thread || !item.conversation || item.state !== 'answered' || !['words', 'replied'].includes(item.answer ?? '') || !item.answeredBy || !item.answeredAt) return undefined;
    return this.db.select({ mail: inbox, message: messages }).from(inbox)
      .innerJoin(messages, and(eq(messages.thread, inbox.thread), eq(messages.seq, inbox.messageSeq), eq(messages.inboxItem, inbox.id)))
      .innerJoin(threads, eq(threads.id, inbox.thread))
      .where(and(eq(inbox.source, 'answer'), eq(inbox.sourceId, item.id), eq(inbox.toKind, 'agent'),
        eq(inbox.conversation, item.conversation!), eq(inbox.thread, item.thread!), eq(inbox.fromKind, 'person'), eq(inbox.fromId, item.answeredBy!),
        eq(messages.kind, 'answer'), eq(messages.sender, item.answeredBy!), eq(threads.conversation, item.conversation!), this.allowed(viewer))).get();
  }
  bodyKeepUntil(viewer: Viewer, id: string): string | null {
    const item = this.current(viewer, id);
    if (!item?.thread || !item.conversation) return null;
    const message = this.db.select({ at: messages.at, keepUntil: messages.keepUntil }).from(messages)
      .innerJoin(threads, eq(threads.id, messages.thread)).where(and(eq(messages.thread, item.thread),
        eq(messages.seq, item.messageSeq ?? -1), eq(messages.inboxItem, item.id), eq(threads.conversation, item.conversation))).get();
    return this.deadline(message);
  }
  answerKeepUntil(viewer: Viewer, id: string): string | null {
    const item = this.current(viewer, id);
    return item ? this.deadline(this.answerState(viewer, item)?.message) : null;
  }
  /** Private answers live only in their retained encrypted thread message.
   * Resolve them on selection, never copy them into the question or receipts. */
  async answerText(viewer: Viewer, id: string, retainedUntil?: (at: number) => void): Promise<string | null> {
    const item = this.current(viewer, id);
    if (!item) return null;
    if (!item.thread) return item.answerText;
    if (item.state !== 'answered' || !['words', 'replied'].includes(item.answer ?? '') || !item.answeredBy || !item.answeredAt) return null;
    const answer = () => this.answerState(viewer, item);
    const before = answer(), keep = this.keepDays();
    if (!before) return null;
    const body = await this.body(viewer, before.mail.id, retainedUntil);
    const after = answer(), days = this.keepDays();
    if (JSON.stringify(this.current(viewer, id)) !== JSON.stringify(item) || JSON.stringify(after) !== JSON.stringify(before)
      || days !== keep || !this.retainedMessage(after?.message, days)) return null;
    return body?.words ?? null;
  }
  async body(viewer: Viewer, id: string, retainedUntil?: (at: number) => void): Promise<Body | null> {
    const item = this.current(viewer, id);
    if (!item) return null;
    if (!item.thread) return item.words === null ? null : { words: item.words, why: item.why, ifYes: item.ifYes, ifNo: item.ifNo, link: item.link };
    const row = () => this.db.select({ message: messages, conversation: threads.conversation }).from(messages)
      .innerJoin(threads, eq(threads.id, messages.thread))
      .where(and(eq(messages.thread, item.thread!), eq(messages.seq, item.messageSeq ?? -1), eq(messages.inboxItem, id))).get();
    const days = () => this.keepDays();
    const retained = (entry: ReturnType<typeof row>, keep: number) => entry?.conversation === item.conversation
      && this.retainedMessage(entry?.message, keep);
    const before = row(), keep = days();
    if (!retained(before, keep) || !before?.message.words) return null;
    const words = await this.key.open(before.message.words);
    const after = row(), current = this.current(viewer, id);
    if (!current || JSON.stringify(current) !== JSON.stringify(item) || !retained(after, days()) || days() !== keep
      || !after?.message.words || after.message.at !== before.message.at || after.message.kind !== before.message.kind
      || after.message.keepUntil !== before.message.keepUntil || !after.message.words.equals(before.message.words)) return null;
    const deadline = wordsDeadline(after.message, keep);
    if (before.message.kind !== 'ask') { retainedUntil?.(deadline); return { words }; }
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
      retainedUntil?.(deadline);
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
    ...Object.fromEntries(['conversation', 'sourceId', 'fromId', 'agent', 'project', 'member', 'answers', 'waitsOnKind', 'waitsOnId', 'thread', 'answer', 'answeredBy', 'answeredAt', 'resolution'].map(name => [name, { type: GraphQLString }])),
    seq: { type: GraphQLInt },
    bodyKeepUntil: { type: GraphQLString, resolve: (row, _args, context) => service.bodyKeepUntil(context.viewer, row.id) },
    answerKeepUntil: { type: GraphQLString, resolve: (row, _args, context) => service.answerKeepUntil(context.viewer, row.id) },
    answerText: { type: GraphQLString, resolve: (row, _args, context) => service.answerText(context.viewer, row.id, until => keepReadUntil(context, until)) },
    body: { type: body, resolve: (row, _args, context) => service.body(context.viewer, row.id, until => keepReadUntil(context, until)) },
    refs: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))), resolve: (row, _args, context) => service.refs(context.viewer, row.id) },
    canAnswer: { type: new GraphQLNonNull(GraphQLBoolean), resolve: (row, _args, context) => service.canAnswer(context.viewer, row.id) },
    read: { type: new GraphQLNonNull(GraphQLBoolean), resolve: (row, _args, context) => service.read(context.viewer, row.id) },
  } });
  const result = new GraphQLObjectType({ name: 'InboxActionResult', fields: {
    id: { type: new GraphQLNonNull(GraphQLString) }, at: { type: new GraphQLNonNull(GraphQLString) },
    ok: { type: new GraphQLNonNull(GraphQLBoolean) }, text: { type: new GraphQLNonNull(GraphQLString) },
    page: { type: GraphQLString }, readAt: { type: GraphQLString },
  } });
  const agentCount = new GraphQLObjectType({ name: 'InboxAgentCount', fields: {
    id: { type: new GraphQLNonNull(GraphQLString) }, count: { type: new GraphQLNonNull(GraphQLInt) },
    needs: { type: new GraphQLNonNull(GraphQLInt) },
  } });
  const folders = new GraphQLObjectType({ name: 'InboxFolders', fields: {
    ...Object.fromEntries(['needs', 'alerts', 'answered', 'fyi', 'all'].map(name => [name, { type: new GraphQLNonNull(GraphQLInt) }])),
    agents: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(agentCount))) },
  } });
  return { inboxFolders: { type: new GraphQLNonNull(folders), resolve: (_row, _args, context) => service.folders(context.viewer) }, inboxItem: {
    type: item, args: { id: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: (_row, args, context) => service.item(context.viewer, args.id),
  }, inboxActionResults: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(result))),
    args: { limit: { type: GraphQLInt, defaultValue: 20 } },
    resolve: (_row, args, context) => service.results(context.viewer, args.limit),
  }, inboxItems: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(item))),
    args: { folder: { type: GraphQLString }, search: { type: GraphQLString }, state: { type: GraphQLString }, source: { type: GraphQLString }, agent: { type: GraphQLString }, limit: { type: GraphQLInt, defaultValue: 50 }, offset: { type: GraphQLInt, defaultValue: 0 } },
    resolve: (_row, args, context) => args.search === undefined ? service.list(context.viewer, args) : service.search(context.viewer, args, until => keepReadUntil(context, until)),
  } };
}
