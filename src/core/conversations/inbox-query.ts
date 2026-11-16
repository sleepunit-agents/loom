import { readAll } from '../data/execution.js';
import { selectedQueryFields } from '../data/queries.js';
import { readInboxFolders, readInboxSet, type InboxReadSet } from '../data/inbox-read.js';
import {handoffEnvelope,handoffDeadline} from './handoff-words.js';
import { wordsDeadline } from './retention.js';
/** Unified Inbox reads for the generated query composition. The authenticated
 * door supplies current SQL visibility; no default policy or new transport. */
import { and, asc, desc, eq, ne, getTableColumns, inArray, is, isNotNull, isNull, sql, SQL, type AnyColumn } from 'drizzle-orm';
import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, type GraphQLFieldConfigMap, type GraphQLResolveInfo } from 'graphql/index.js';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from '../data/database.js';
import { actionResults, household, inbox, inboxReads, inboxRefs, messages, threads } from '../data/schema.js';
import { keepReadUntil } from '../data/read-lease.js';
import type { WordsKey } from './words.js';

const projected=Symbol('Inbox display projection');
type Item = typeof inbox.$inferSelect;
type Projected=Item&{[projected]?:Record<string,unknown>};
const display=(row:Projected,name:string,read:()=>unknown)=>row[projected]&&Object.hasOwn(row[projected],name)?row[projected][name]:read();
type Body = { words: string; why?: string | null; ifYes?: string | null; ifNo?: string | null; link?: string | null };
export type InboxQueryPolicy = (viewer: Viewer, fields: Record<string, AnyColumn>) => SQL;
export type InboxFilter = { folder?: 'needs' | 'alerts' | 'answered' | 'fyi' | 'all'; state?: Item['state']; source?: Item['source']; agent?: string; conversation?: string; limit?: number; offset?: number; search?: string };

export class InboxQueries {
  private readSet?: InboxReadSet;
  constructor(readonly db: DataDatabase, readonly key: WordsKey, readonly policy: InboxQueryPolicy,
    readonly now: () => string = () => new Date().toISOString(),
    private readonly volumeAllowed: (viewer: Viewer, item: Item) => boolean = () => false,
    private readonly volumeBatch?: (viewer: Viewer, items: Item[]) => Set<string>) {}

  private allowed(viewer: Viewer) {
    const allowed = this.policy(viewer, getTableColumns(inbox));
    if (!is(allowed, SQL)) throw new Error('SQL Inbox visibility required');
    return allowed;
  }
  private keepDays() { if(this.readSet)return this.readSet.days; return this.db.select({ days: household.commsDays }).from(household).get()?.days ?? 14; }
  private retainedMessage(message: typeof messages.$inferSelect | undefined, days: number): boolean {
    return !!message?.words && !!message.keepUntil && Number.isInteger(days) && days >= 1 && days <= 14
      && Date.parse(message.keepUntil) > Date.parse(this.now()) && Date.parse(message.at) + days * 86400000 > Date.parse(this.now());
  }
  private current(viewer: Viewer, id: string) {
    if(this.readSet)return this.readSet.item(id);
    return this.db.select().from(inbox).where(and(eq(inbox.id, id), this.allowed(viewer))).get();
  }
  item(viewer: Viewer, id: string): Item | null { return this.current(viewer, id) ?? null; }
  canSetVolume(viewer: Viewer, id: string): boolean {
    const item = this.current(viewer, id);
    return !!item && this.volumeAllowed(viewer, item);
  }
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
    const where=this.mailboxWhere(viewer,filter);
    return this.db.query.inbox.findMany({where:()=>sql`${{getSQL:()=>where!}}`,orderBy:f=>[desc(sql`julianday(${f.at})`),desc(f.id)],limit,offset}).sync();
  }
  /** Compute selected fields against one generated read set, then recheck the
   * complete set after any private decryption. No cache survives this call. */
  async project(viewer:Viewer,items:Item[],info:GraphQLResolveInfo,retainedUntil:(at:number)=>void):Promise<Projected[]> {
    if(!items.length)return [];
    const fields=selectedQueryFields(info),ids=items.map(row=>row.id);
    const words=fields.has('body')||fields.has('answerText');
    const before=readInboxSet(this.db,ids,this.allowed(viewer),words);
    if(items.some(row=>JSON.stringify(row)!==JSON.stringify(before.item(row.id))))throw Error('Inbox changed; retry the query');
    const key=Object.assign(Object.create(this.key) as WordsKey,{open:(bytes:Uint8Array)=>this.key.open(bytes)});
    const service=new InboxQueries(this.db,key,this.policy,this.now,this.volumeAllowed);
    service.readSet=before;
    const permissions=fields.has('canSetVolume')?this.volumeBatch?.(viewer,items):undefined;
    const deadlines:number[]=[];
    const retain=(at:number)=>deadlines.push(at);
    const rows=await readAll(items.map(async row=>{
      const values:Record<string,unknown>={};
      const readers:Record<string,()=>unknown>={
        refs:()=>service.refs(viewer,row.id),read:()=>service.read(viewer,row.id),
        canAnswer:()=>service.canAnswer(viewer,row.id),
        canSetVolume:()=>permissions?permissions.has(row.id):service.canSetVolume(viewer,row.id),
        bodyKeepUntil:()=>service.bodyKeepUntil(viewer,row.id),answerKeepUntil:()=>service.answerKeepUntil(viewer,row.id),
        body:()=>service.body(viewer,row.id,retain),answerText:()=>service.answerText(viewer,row.id,retain),
      };
      await readAll(Object.entries(readers).filter(([name])=>fields.has(name)).map(async([name,read])=>{values[name]=await read();}));
      return Object.assign({...row},{[projected]:values});
    }));
    // Even unchanged ciphertext may no longer be visible after open() yields.
    // A retry is preferable to returning an internally inconsistent page.
    {
      const after=readInboxSet(this.db,ids,this.allowed(viewer),words);
      if(after.fingerprint!==before.fingerprint||deadlines.some(at=>at<=Date.parse(this.now())))throw Error('Inbox changed; retry the query');
      if(permissions&&this.volumeBatch&&JSON.stringify([...this.volumeBatch(viewer,items)].sort())!==JSON.stringify([...permissions].sort()))throw Error('Inbox permissions changed; retry the query');
    }
    for(const at of deadlines)retainedUntil(at);
    return rows;
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
      filter.agent ? eq(inbox.agent, filter.agent) : undefined,
      filter.conversation ? eq(inbox.conversation, filter.conversation) : undefined);
  }
  private mailbox(viewer: Viewer, filter: InboxFilter) {
    const where=this.mailboxWhere(viewer,filter);
    return this.db.query.inbox.findMany({where:()=>sql`${{getSQL:()=>where!}}`,orderBy:f=>[desc(sql`julianday(${f.at})`),desc(f.id)]});
  }
  folders(viewer: Viewer) {
    if (viewer.kind !== 'member' && viewer.kind !== 'agent') return { needs: 0, alerts: 0, answered: 0, fyi: 0, all: 0, agents: [] };
    return readInboxFolders(this.db, this.mailboxWhere(viewer)!);
  }

  /** Search the recipient's whole mailbox before paging. Private text is opened
   * only through body(), and is never indexed or written back to the database. */
  async search(viewer:Viewer,filter:InboxFilter={},retainedUntil?:(at:number)=>void):Promise<Item[]> {
    if(!filter.search?.trim())return this.list(viewer,filter);
    this.list(viewer,filter);
    if(viewer.kind!=='member'&&viewer.kind!=='agent')return [];
    const candidates=this.mailbox(viewer,filter).sync(),ids=candidates.map(row=>row.id);
    if(!ids.length)return [];
    const before=readInboxSet(this.db,ids,this.allowed(viewer));
    const service=new InboxQueries(this.db,this.key,this.policy,this.now,this.volumeAllowed);
    service.readSet=before;
    const deadlines:number[]=[];
    const result=await service.searchInSet(viewer,filter,at=>deadlines.push(at),candidates);
    const after=readInboxSet(this.db,ids,this.allowed(viewer));
    if(before.fingerprint!==after.fingerprint||deadlines.some(at=>at<=Date.parse(this.now())))return [];
    for(const at of deadlines)retainedUntil?.(at);
    return result;
  }
  private async searchInSet(viewer: Viewer, filter: InboxFilter, retainedUntil: (at: number) => void, candidates:Item[]): Promise<Item[]> {
    const query = filter.search?.trim().toLocaleLowerCase() ?? '';
    // Validate the same page bounds even for an empty or unauthorized mailbox.
    if (!query) return this.list(viewer, filter);
    this.list(viewer, filter);
    if (viewer.kind !== 'member' && viewer.kind !== 'agent') return [];
    const privateState = (item: Item, fromAnswer = false) => {
      const answer = fromAnswer ? this.answerState(viewer, item) : undefined;
      const message = fromAnswer ? answer?.message : this.readSet?this.readSet.message(item):item.thread ? this.db.select().from(messages).where(and(eq(messages.thread, item.thread),
        eq(messages.seq, item.messageSeq ?? -1), eq(messages.inboxItem, item.id))).get() : undefined;
      const keep = this.keepDays();
      const thread = item.thread ? this.readSet?this.readSet.thread(item.thread):this.db.select().from(threads).where(eq(threads.id,item.thread)).get():undefined;
      return { message, keep, thread, answerMail: answer?.mail };
    };
    const metadata = (item: Item) => [item.id, item.source, item.sourceId, item.fromId, item.agent, item.project,
        item.answer, item.answeredBy, item.resolution, ...this.refs(viewer, item.id)].some(value => value?.toLocaleLowerCase().includes(query));
    const matches: { item: Item; metadata?: true; fromAnswer?: true; state?: ReturnType<typeof privateState> }[] = [];
    for (const item of candidates) {
      if (metadata(item)) { matches.push({ item, metadata: true }); continue; }
      // Handoffs are agent mail. Their wording is delivered only by take,
      // while this personal mailbox search can match their metadata.
      if(item.source==='handoff')continue;
      const state = item.thread ? privateState(item) : undefined;
      const body = await this.body(viewer, item.id);
      if (body && [body.words, body.why, body.ifYes, body.ifNo, body.link].some(value => value?.toLocaleLowerCase().includes(query))) matches.push({ item, state });
      {
        const answerState = item.thread ? privateState(item, true) : undefined;
        const answer = await this.answerText(viewer, item.id);
        if (answer?.toLocaleLowerCase().includes(query)) matches.push({ item, state: answerState, fromAnswer: true });
      }
    }
    // A later decrypt may yield while earlier matches lose access, change words
    // or expire. Validate every match again synchronously before returning ids.
    const current = matches.filter(({ item, state, metadata: byMetadata, fromAnswer }) => {
      if (JSON.stringify(this.current(viewer, item.id)) !== JSON.stringify(item)) return false;
      if (byMetadata) return metadata(item);
      if (!state) return true;
      const after = privateState(item, fromAnswer), message = after.message;
      return JSON.stringify(after) === JSON.stringify(state) && this.retainedMessage(message, after.keep);
    });
    // One item may match both its question and its independently retained
    // answer. Keep the longest still-valid witness, once, before paging.
    const unique = new Map<string, typeof current[number]>();
    const deadline = (match: typeof current[number]) => match.metadata || !match.state?.message
      ? Infinity : wordsDeadline(match.state.message, match.state.keep);
    for (const match of current) {
      const prior = unique.get(match.item.id);
      if (!prior || deadline(match) > deadline(prior)) unique.set(match.item.id, match);
    }
    const page = [...unique.values()].slice(filter.offset ?? 0, (filter.offset ?? 0) + (filter.limit ?? 50));
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
    if(this.readSet)return this.readSet.refs(id);
    return this.db.select({ ref: inboxRefs.ref }).from(inboxRefs).innerJoin(inbox, eq(inbox.id, inboxRefs.item))
      .where(and(eq(inbox.id, id), this.allowed(viewer))).orderBy(asc(inboxRefs.ref)).all().map(row => row.ref);
  }
  read(viewer: Viewer, id: string): boolean {
    if(this.readSet)return viewer.kind==='member'&&this.readSet.read(id,viewer.id);
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
    if(this.readSet)return this.readSet.answer(item);
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
    if(item?.source==='handoff'){const until=viewer.kind==='member'?handoffDeadline(item,this.keepDays()):-Infinity;return Number.isFinite(until)&&until>Date.parse(this.now())?new Date(until).toISOString():null;}
    if (!item?.thread || !item.conversation) return null;
    const message = this.readSet?this.readSet.thread(item.thread)?.conversation===item.conversation?this.readSet.message(item):undefined:this.db.select({ at: messages.at, keepUntil: messages.keepUntil }).from(messages)
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
    if(item.source==='handoff'){
      if(viewer.kind!=='member')return null;
      const days=this.keepDays(),until=handoffDeadline(item,days);
      if(!(until>Date.parse(this.now())))return null;
      const envelope=handoffEnvelope(item.words);if(!envelope)return null;
      const words=await this.key.open(Buffer.from(envelope.cipher,'base64'));
      const current=this.current(viewer,id);
      if(!current||JSON.stringify(current)!==JSON.stringify(item)||this.keepDays()!==days||handoffDeadline(current,days)<=Date.parse(this.now()))return null;
      retainedUntil?.(until);return {words};
    }
    if (!item.thread) return item.words === null ? null : { words: item.words, why: item.why, ifYes: item.ifYes, ifNo: item.ifNo, link: item.link };
    const row = () => this.readSet?(()=>{const message=this.readSet!.message(item),thread=this.readSet!.thread(item.thread!);return message&&thread?{message,conversation:thread.conversation}:undefined;})():this.db.select({ message: messages, conversation: threads.conversation }).from(messages)
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
    ...Object.fromEntries(['quietUntil', 'conversation', 'sourceId', 'fromId', 'agent', 'project', 'member', 'answers', 'waitsOnKind', 'waitsOnId', 'thread', 'answer', 'answeredBy', 'answeredAt', 'resolution'].map(name => [name, { type: GraphQLString }])),
    seq: { type: GraphQLInt },
    bodyKeepUntil: { type: GraphQLString, resolve: (row, _args, context) => display(row,'bodyKeepUntil',()=>service.bodyKeepUntil(context.viewer,row.id)) },
    answerKeepUntil: { type: GraphQLString, resolve: (row, _args, context) => display(row,'answerKeepUntil',()=>service.answerKeepUntil(context.viewer,row.id)) },
    answerText: { type: GraphQLString, resolve: (row, _args, context) => display(row,'answerText',()=>service.answerText(context.viewer,row.id,until=>keepReadUntil(context,until))) },
    body: { type: body, resolve: (row, _args, context) => display(row,'body',()=>service.body(context.viewer,row.id,until=>keepReadUntil(context,until))) },
    refs: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))), resolve: (row, _args, context) => display(row,'refs',()=>service.refs(context.viewer,row.id)) },
    canSetVolume: { type: new GraphQLNonNull(GraphQLBoolean), resolve: (row, _args, context) => display(row,'canSetVolume',()=>service.canSetVolume(context.viewer,row.id)) },
    canAnswer: { type: new GraphQLNonNull(GraphQLBoolean), resolve: (row, _args, context) => display(row,'canAnswer',()=>service.canAnswer(context.viewer,row.id)) },
    read: { type: new GraphQLNonNull(GraphQLBoolean), resolve: (row, _args, context) => display(row,'read',()=>service.read(context.viewer,row.id)) },
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
    resolve: async(_row,args,context,info)=>{const row=service.item(context.viewer,args.id);return row?(await service.project(context.viewer,[row],info,until=>keepReadUntil(context,until)))[0]:null;},
  }, inboxActionResults: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(result))),
    args: { limit: { type: GraphQLInt, defaultValue: 20 } },
    resolve: (_row, args, context) => service.results(context.viewer, args.limit),
  }, inboxItems: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(item))),
    args: { folder: { type: GraphQLString }, search: { type: GraphQLString }, state: { type: GraphQLString }, source: { type: GraphQLString }, agent: { type: GraphQLString }, conversation: { type: GraphQLString }, limit: { type: GraphQLInt, defaultValue: 50 }, offset: { type: GraphQLInt, defaultValue: 0 } },
    resolve: async(_row,args,context,info)=>service.project(context.viewer,args.search===undefined?service.list(context.viewer,args):await service.search(context.viewer,args,until=>keepReadUntil(context,until)),info,until=>keepReadUntil(context,until)),
  } };
}
