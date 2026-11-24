import { agentPostFields } from './agent-post-query.js';
import { noticeInfo } from './legacy-notice.js';
import { legacyStepWords, legacyToolCard } from './legacy-tool-card.js';
import { archivedQuestionsField } from './archived-questions.js';
import { readAll } from '../data/execution.js';
import { readCommsFolders, readCommsThreads, readCommsRefs, readCommsPage, readCommsSet, type CommsReadSet } from '../data/comms-read.js';
import { selectedQueryFields } from '../data/queries.js';
import { readCommsHome } from '../data/comms-home.js';
import { wordsDeadline, wordsKept } from './retention.js';
/** Shared Comms read projection. Composition owns current SQL sharing and the
 * authenticated query door; metadata never loads private ciphertext. */
import { and, eq, getTableColumns, is, SQL, type AnyColumn } from 'drizzle-orm';
import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, type GraphQLFieldConfigMap, type GraphQLResolveInfo } from 'graphql/index.js';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from '../data/database.js';
import { conversations, household, messages, threads } from '../data/schema.js';
import { keepReadUntil } from '../data/read-lease.js';
import type { WordsKey } from './words.js';
import { commsKeepDays } from '../data/comms-days.js';
type Message = typeof messages.$inferSelect;
const projected=Symbol('Comms message projection');
type MessageView = Omit<Message, 'words'|'archivedStepWords'> & Pick<typeof conversations.$inferSelect, 'agent' | 'project' | 'member'> & { conversation: string } & { [projected]?: Record<string,unknown> };
export type CommsQueryPolicy = (viewer: Viewer, fields: Record<string, AnyColumn>) => SQL;
const limit = (value: number, max: number) => { if (!Number.isInteger(value) || value < 1 || value > max) throw new Error('Invalid Comms page size'); return value; };

export class CommsQueries {
  private readSet?: CommsReadSet;
  constructor(readonly db: DataDatabase, readonly key: WordsKey, readonly policy: CommsQueryPolicy, readonly now: () => string = () => new Date().toISOString()) {}
  private allowed(viewer: Viewer) {
    const allowed = this.policy(viewer, getTableColumns(conversations));
    if (!is(allowed, SQL)) throw new Error('SQL conversation visibility required');
    return allowed;
  }
  activityFields() {
    return agentPostFields(this.db, this.key, viewer => this.allowed(viewer));
  }
  archivedHistory() {
    return archivedQuestionsField(this.db, this.key, viewer => this.allowed(viewer), this.now);
  }
  list(viewer: Viewer, input: { member?: string; agent?: string; archived?: boolean; search?: string; limit?: number; offset?: number } = {}) {
    const count = limit(input.limit ?? 50, 100), offset = input.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000) throw new Error('Invalid Comms offset');
    const member = input.member ?? (viewer.kind === 'member' ? viewer.id : undefined);
    return readCommsThreads(this.db, this.allowed(viewer), { ...input, member, count, offset });
  }
  folders(viewer: Viewer) {
    if (viewer.kind !== 'member') return { threads: 0, archived: 0 };
    return readCommsFolders(this.db, this.allowed(viewer), viewer.id);
  }

  /** A client deadline includes the current household duration, independently
   * of the stored maximum. No words or ciphertext are loaded for this field. */
  wordsKeepUntil(viewer: Viewer, expected: MessageView): string | null {
    const current = this.readSet?this.readSet.entry(expected.seq)?.conversation===expected.conversation?this.readSet.entry(expected.seq)?.message:undefined:this.db.select({ at: messages.at, keepUntil: messages.keepUntil }).from(messages)
      .innerJoin(threads, eq(threads.id, messages.thread)).innerJoin(conversations, eq(conversations.id, threads.conversation))
      .where(and(eq(messages.thread, expected.thread), eq(messages.seq, expected.seq), eq(conversations.id, expected.conversation), this.allowed(viewer))).get();
    const days = this.readSet?.days??commsKeepDays(this.db);
    if (!current?.keepUntil || current.at !== expected.at || current.keepUntil !== expected.keepUntil) return null;
    const deadline = wordsDeadline(current, days);
    return Number.isFinite(deadline) ? new Date(deadline).toISOString() : null;
  }
  /** Home is the signed-in member's own mailbox, including only agents they
   * can give work to. Reply metadata suffices; no private words are loaded. */
  home(viewer: Viewer, fields?: ReadonlySet<string>) {
    return readCommsHome(this.db, viewer, this.allowed(viewer), fields);
  }

  thread(viewer: Viewer, id: string) {
    return readCommsThreads(this.db, this.allowed(viewer), { id, count: 1, offset: 0 })[0] ?? null;
  }

  messages(viewer: Viewer, thread: string, beforeSeq?: number, count = 50) {
    limit(count, 100);
    if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1)) throw new Error('Invalid message cursor');
    return readCommsPage(this.db,thread,this.allowed(viewer),beforeSeq,count);
  }

  refs(viewer: Viewer, thread: string, count = 100) {
    limit(count, 200);
    return readCommsRefs(this.db, this.allowed(viewer), thread, count);
  }

  async projectMessages(viewer:Viewer,rows:MessageView[],info:GraphQLResolveInfo,retain:(at:number)=>void){
    if(!rows.length)return [];
    const fields=selectedQueryFields(info),words=fields.has('words'),details=fields.has('stepDetails'),thread=rows[0].thread,seqs=rows.map(row=>row.seq);
    const before=readCommsSet(this.db,thread,seqs,this.allowed(viewer),words,details);
    const service=new CommsQueries(this.db,this.key,this.policy,this.now);service.readSet=before;
    const deadlines:number[]=[];
    const result=await readAll(rows.map(async row=>{
      const current=before.entry(row.seq);
      if(!current)throw Error('Comms changed; retry the query');
      const {words:_cipher,archivedStepWords:_step,...message}=current.message;
      if(JSON.stringify({...message,conversation:current.conversation,agent:current.agent,project:current.project,member:current.member})!==JSON.stringify(row))throw Error('Comms changed; retry the query');
      const values:Record<string,unknown>={};
      if(fields.has('wordsKeepUntil'))values.wordsKeepUntil=service.wordsKeepUntil(viewer,row);
      if(words)values.words=await service.words(viewer,row,at=>deadlines.push(at));
      if(details)values.stepDetails=await service.stepDetails(viewer,row,at=>deadlines.push(at));
      return Object.assign({...row},{[projected]:values});
    }));
    const after=readCommsSet(this.db,thread,seqs,this.allowed(viewer),words,details);
    if(before.fingerprint!==after.fingerprint||deadlines.some(at=>at<=Date.parse(this.now())))throw Error('Comms changed; retry the query');
    for(const at of deadlines)retain(at);
    return result;
  }

  async stepDetails(viewer:Viewer, expected:MessageView, retain:(at:number)=>void) {
    if(expected.kind!=='card'||!expected.archivedStepMeta||!expected.tool)return null;
    const parts=await this.words(viewer,expected,retain,'archivedStepWords');
    return parts===null?null:legacyStepWords(parts,expected.tool);
  }
  async words(viewer: Viewer, expected: MessageView, retainedUntil?: (at: number) => void, column:'words'|'archivedStepWords'='words'): Promise<string | null> {
    const row = () => this.readSet?this.readSet.entry(expected.seq):this.db.select({ message: messages, agent: conversations.agent, project: conversations.project, member: conversations.member, conversation: conversations.id })
      .from(messages).innerJoin(threads, eq(threads.id, messages.thread)).innerJoin(conversations, eq(conversations.id, threads.conversation))
      .where(and(eq(messages.thread, expected.thread), eq(messages.seq, expected.seq), this.allowed(viewer))).get();
    const days = () => this.readSet?.days??commsKeepDays(this.db);
    const retained = (entry: ReturnType<typeof row>, keep: number) => !!entry?.message.words && wordsKept(entry.message, keep, this.now());
    const same = (message: Message) => ['at', 'sender', 'kind', 'keepUntil', 'inboxItem'].every(key => message[key as keyof Message] === expected[key as keyof typeof expected]);
    const scope = (entry: ReturnType<typeof row>) => !!entry && entry.agent === expected.agent && entry.project === expected.project && entry.member === expected.member && entry.conversation === expected.conversation;
    const before = row(), keep = days();
    if (!retained(before, keep) || !before?.message.words || !same(before.message) || !scope(before)) return null;
    const envelope=before.message[column];
    if(!envelope)return null;
    const words = await this.key.open(envelope);
    const after = row();
    if (!retained(after, days()) || days() !== keep || !after?.message.words || !same(after.message) || !scope(after)
      || after.agent !== before.agent || after.project !== before.project || after.member !== before.member || after.conversation !== before.conversation
      || !after.message.words.equals(before.message.words) || !after.message[column]?.equals(envelope)) return null;
    retainedUntil?.(wordsDeadline(after.message, keep));
    return words;
  }
}

export function commsQueryFields(service: CommsQueries): GraphQLFieldConfigMap<unknown, { viewer: Viewer }> {
  const thread = new GraphQLObjectType({ name: 'CommsThreadView', fields: {
    ...Object.fromEntries(['id', 'conversation', 'venue', 'title', 'titledBy', 'agent', 'openedAt', 'lastAt'].map(name => [name, { type: new GraphQLNonNull(GraphQLString) }])),
    ...Object.fromEntries(['project', 'member', 'archivedAt', 'workingSince', 'workingBeat'].map(name => [name, { type: GraphQLString }])),
    ...Object.fromEntries(['pinned', 'working', 'stopRequested'].map(name => [name, { type: new GraphQLNonNull(GraphQLBoolean) }])),
    readSeq: { type: new GraphQLNonNull(GraphQLInt) },
  } });
  const notice = new GraphQLObjectType({ name:'ArchivedCommsNotice', fields:{
    error:{type:new GraphQLNonNull(GraphQLString)}, attempt:{type:GraphQLInt}, settled:{type:GraphQLBoolean},
    retryAt:{type:GraphQLString,resolve:row=>row.retry_at},
  }});
  const stepInfo=new GraphQLObjectType({name:'ArchivedStepInfo',fields:{
    exit:{type:GraphQLInt},limit:{type:GraphQLInt},parent:{type:GraphQLString},t0:{type:GraphQLString},t1:{type:GraphQLString},
  }});
  const planItem=new GraphQLObjectType({name:'ArchivedStepPlanItem',fields:{text:{type:GraphQLString},state:{type:GraphQLString}}});
  const stepDetails=new GraphQLObjectType({name:'ArchivedStepDetails',fields:{
    detail:{type:GraphQLString},body:{type:GraphQLString},result:{type:GraphQLString},items:{type:new GraphQLList(planItem)},
  }});
  const message = new GraphQLObjectType<MessageView, { viewer: Viewer }>({ name: 'CommsMessageView', fields: {
    ...Object.fromEntries(['thread', 'kind', 'sender', 'at'].map(name => [name, { type: new GraphQLNonNull(GraphQLString) }])),
    ...Object.fromEntries(['keepUntil', 'delivery', 'inboxItem', 'verdict', 'run', 'tool', 'cardState', 'clientId'].map(name => [name, { type: GraphQLString }])),
    notice:{type:notice,resolve:row=>row.archivedNotice?noticeInfo.parse(JSON.parse(row.archivedNotice)):null},
    stepInfo:{type:stepInfo,resolve:row=>row.archivedStepMeta?legacyToolCard.parse(JSON.parse(row.archivedStepMeta)):null},
    stepDetails:{type:stepDetails,resolve:(row,_args,context)=>row[projected]&&Object.hasOwn(row[projected],'stepDetails')?row[projected].stepDetails:
      service.stepDetails(context.viewer,row,until=>keepReadUntil(context,until))},
    wordsKeepUntil: { type: GraphQLString, resolve:(row,_args,context)=>row[projected]&&Object.hasOwn(row[projected],'wordsKeepUntil')?row[projected].wordsKeepUntil:service.wordsKeepUntil(context.viewer,row) },
    seq: { type: new GraphQLNonNull(GraphQLInt) }, words: { type: GraphQLString, resolve:(row,_args,context)=>row[projected]&&Object.hasOwn(row[projected],'words')?row[projected].words:service.words(context.viewer,row,until=>keepReadUntil(context,until)) },
  } });
  const ref = new GraphQLObjectType({ name: 'CommsReferenceView', fields: { ref: { type: new GraphQLNonNull(GraphQLString) }, messageSeq: { type: new GraphQLNonNull(GraphQLInt) } } });
  const many = (type: GraphQLObjectType<any, any>) => new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(type)));
  const id = { type: new GraphQLNonNull(GraphQLString) };
  const homeThread = new GraphQLObjectType({ name: 'HomeCommsThread', fields: {
    thread: { type: new GraphQLNonNull(GraphQLString) }, title: { type: new GraphQLNonNull(GraphQLString) }, at: { type: new GraphQLNonNull(GraphQLString) },
  } });
  const homeAgent = new GraphQLObjectType({ name: 'HomeCommsAgent', fields: {
    agent: { type: new GraphQLNonNull(GraphQLString) }, unread: { type: new GraphQLNonNull(GraphQLInt) },
    last: { type: homeThread }, first: { type: homeThread },
  } });
  const home = new GraphQLObjectType({ name: 'HomeComms', fields: {
    member: { type: new GraphQLNonNull(GraphQLString) }, agents: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
    summaries: { type: many(homeAgent) },
  } });
  const folders = new GraphQLObjectType({ name: 'CommsFolders', fields: {
    threads: { type: new GraphQLNonNull(GraphQLInt) }, archived: { type: new GraphQLNonNull(GraphQLInt) },
  } });
  return {
    ...service.activityFields(),
    commsArchivedQuestions: service.archivedHistory(),
    homeComms: { type: home, resolve: (_row, _args, context, info) => service.home(context.viewer, selectedQueryFields(info)) },
    commsFolders: { type: new GraphQLNonNull(folders), resolve: (_row, _args, context) => service.folders(context.viewer) },
    commsThreads: { type: many(thread), args: { search: { type: GraphQLString }, member: { type: GraphQLString }, agent: { type: GraphQLString }, archived: { type: GraphQLBoolean }, limit: { type: GraphQLInt }, offset: { type: GraphQLInt } }, resolve: (_row, args, context) => service.list(context.viewer, args) },
    commsThread: { type: thread, args: { id }, resolve: (_row, args, context) => service.thread(context.viewer, args.id) },
    commsMessages: { type: many(message), args: { thread: id, beforeSeq: { type: GraphQLInt }, limit: { type: GraphQLInt, defaultValue: 50 } }, resolve:(_row,args,context,info)=>service.projectMessages(context.viewer,service.messages(context.viewer,args.thread,args.beforeSeq??undefined,args.limit),info,until=>keepReadUntil(context,until)) },
    commsRefs: { type: many(ref), args: { thread: id, limit: { type: GraphQLInt, defaultValue: 100 } }, resolve: (_row, args, context) => service.refs(context.viewer, args.thread, args.limit) },
  };
}
