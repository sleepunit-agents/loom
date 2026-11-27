import { chatFiles } from './chat-files.js';
import { threadTitle } from './title.js';
import {isPrivateInboxQuestion} from './private-inbox-words.js';
/** Shared-schema mutation adapters. Composition supplies CURRENT authorization;
 * these adapters do not grant access, load keys or expose a private read door. */
import { z } from 'zod';
import { and, eq, getTableColumns, sql } from 'drizzle-orm';
import { Operations, OperationError, operation, type Context } from '../operations/index.js';
import { rules, type Viewer } from '../../policy.js';
import { sqlRule } from '../../policy-sql.js';
import { actionResults, deletedThreads, inbox, threads, type conversations } from '../data/schema.js';
import { CommsMessages } from './messages.js';
import { MESSAGE_WORDS_MAX } from './words.js';

type Conversation = typeof conversations.$inferSelect;
type Thread = typeof threads.$inferSelect;
type Item = typeof inbox.$inferSelect;
type ThreadChange = 'rename' | 'pin' | 'archive' | 'read' | 'stop' | 'delete';
export type ConversationAccess =
  | { action: 'open'; id: string; member: string; agent: string; project?: string; existing?: { thread: Thread; conversation: Conversation } }
  | { action: 'send'; conversation: Conversation; thread: Thread }
  | { action: 'change'; change: ThreadChange; conversation: Conversation; thread: Thread }
  | { action: 'answer' | 'read'; item: Item };
export interface ConversationOperationOptions {
  /** Synchronous, side-effect-free current policy check, repeated after async
   * preparation and before receipt replay. No default allow implementation. */
  authorize(viewer: Viewer, access: ConversationAccess): boolean;
  /** The member sent from the page that shows boards, with this board on screen or none. Throws to refuse the send. */
  sentFromBoards?(thread: string, board: string | null, at: string): void;
}

const target = z.object({ thread: z.string().min(1) }).strict();
const acknowledgement = z.object({ saved: z.literal(true) }).strict();
const answerInput = z.object({ item: z.string().min(1), answer: z.enum(inbox.answer.enumValues), words: z.string().max(MESSAGE_WORDS_MAX).optional() }).strict();
const changeInput = z.discriminatedUnion('change', [
  target.extend({ change: z.literal('rename'), title: threadTitle }),
  target.extend({ change: z.literal('pin'), pinned: z.boolean() }),
  target.extend({ change: z.literal('archive'), archived: z.boolean() }),
  target.extend({ change: z.literal('read'), seq: z.number().int().nonnegative() }),
  target.extend({ change: z.literal('stop') }),
  target.extend({ change: z.literal('delete') }),
]);

export function registerConversationOperations(operations: Operations, service: CommsMessages, options: ConversationOperationOptions): void {
  // Joining a caller's transaction is meaningful only on the same connection.
  if (operations.db !== service.db.$client) throw new Error('Conversation operations need the shared connection');
  const cvs = service.threads.conversations;
  const member = (viewer: Viewer): string => {
    if (viewer.kind !== 'member') throw new OperationError('denied', 'A signed-in member is required');
    return viewer.id;
  };
  const threadAccess = (viewer: Viewer, id: string, change?: ThreadChange) => {
    if (viewer.kind !== 'member') return false;
    try {
      const thread = service.threads.thread(id), conversation = cvs.conversation(thread.conversation);
      return options.authorize(viewer, change ? { action: 'change', change, thread, conversation } : { action: 'send', thread, conversation });
    } catch { return false; }
  };
  const itemAccess = (viewer: Viewer, id: string, action: 'answer' | 'read') => {
    if (viewer.kind !== 'member') return false;
    try { return options.authorize(viewer, { action, item: cvs.item(id) }); }
    catch { return false; }
  };
  const openAccess = (viewer: Viewer, input: { thread: string; agent: string; project?: string }) => {
    if (viewer.kind !== 'member') return false;
    if (service.db.select().from(deletedThreads).where(eq(deletedThreads.id, input.thread)).get()) return false;
    const thread = service.db.select().from(threads).where(eq(threads.id, input.thread)).get();
    const existing = thread ? { thread, conversation: cvs.conversation(thread.conversation) } : undefined;
    if (existing && (existing.conversation.member !== viewer.id || existing.conversation.agent !== input.agent || existing.conversation.project !== (input.project ?? null))) return false;
    return options.authorize(viewer, { action: 'open', id: input.thread, member: viewer.id, agent: input.agent, project: input.project, existing });
  };
  const changed = (ctx: Context, thread: string) => {
    ctx.changed('threads', thread);
    ctx.changed('conversations', service.threads.thread(thread).conversation);
  };
  const common = {
    refuses: true,
    // A member's own token may do these as well as a signed-in window: answering and sending are not browser-only.
    doors: ['http'] as ['http'], write: true, recheckPolicy: true,
    inputHash: (value: string) => service.key.hash(`conversation-operation\0${value}`),
  };

  operations.register(operation({ ...common, name: 'comms.open',
    input: z.object({ thread: z.string().min(1), agent: z.string().min(1), project: z.string().min(1).optional(), title: threadTitle.optional() }).strict(),
    output: z.object({ thread: z.string(), conversation: z.string() }).strict(),
    may: (v, i) => openAccess(v, i),
    run(ctx, i) {
      const thread = service.threads.open({ id: i.thread, member: member(ctx.viewer), agent: i.agent, project: i.project, title: i.title ?? 'New conversation', titledBy: i.title === undefined ? 'agent' : 'member' });
      changed(ctx, thread.id);
      return { thread: thread.id, conversation: thread.conversation };
    },
  }));

  operations.register(operation({ ...common, name: 'comms.send',
    input: target.extend({ clientId: z.string().min(1).max(200), words: z.string().trim().max(MESSAGE_WORDS_MAX), files: chatFiles.optional(), shows: z.object({ board: z.string().min(1).max(200).nullable() }).strict().optional() }).refine(i => (i.words.length > 0 || !!i.files?.length) && i.words.length + (i.files ? JSON.stringify(i.files.map(f => f.name)).length + 17 : 0) <= MESSAGE_WORDS_MAX),
    output: z.object({ thread: z.string(), seq: z.number().int(), item: z.string() }).strict(),
    may: (v, i) => threadAccess(v, i.thread),
    prepare: (i, ctx) => service.prepareSend({ thread: i.thread, clientId: i.clientId, words: i.words, files:i.files, sender: member(ctx.viewer), kind: 'message' }),
    run(ctx, i, prepared) {
      if (i.shows) options.sentFromBoards?.(i.thread, i.shows.board, new Date(ctx.now).toISOString());
      const message = (prepared as Awaited<ReturnType<CommsMessages['prepareSend']>>)();
      changed(ctx, i.thread);
      ctx.changed('messages', `${i.thread}:${message.seq}`);
      ctx.changed('inbox', message.inboxItem!);
      return { thread: i.thread, seq: message.seq, item: message.inboxItem! };
    },
  }));

  operations.register(operation({ ...common, name: 'comms.change', input: changeInput, output: acknowledgement,
    may: (v, i) => threadAccess(v, i.thread, i.change),
    run(ctx, i) {
      const conversation = service.threads.thread(i.thread).conversation;
      switch (i.change) {
        case 'rename': service.threads.rename(i.thread, i.title, 'member'); break;
        case 'pin': service.threads.pin(i.thread, i.pinned); break;
        case 'archive': service.threads.archive(i.thread, i.archived); break;
        case 'read': service.threads.read(i.thread, i.seq); break;
        case 'stop': service.threads.requestStop(i.thread); break;
        case 'delete': service.delete(i.thread); break;
      }
      ctx.changed('threads', i.thread); ctx.changed('conversations', conversation);
      if (i.change === 'delete') { ctx.changed('messages', i.thread); ctx.changed('inbox', conversation); ctx.changed('threadRefs', i.thread); }
      return { saved: true };
    },
  }));

  operations.register(operation({ ...common, name: 'inbox.answer', input: answerInput, output: acknowledgement,
    may: (v, i) => itemAccess(v, i.item, 'answer'),
    async prepare(i, ctx) {
      const actor = member(ctx.viewer), item = cvs.item(i.item);
      if (item.thread) return service.prepareAnswer(i.item, actor, i.answer, i.words);
      if(isPrivateInboxQuestion(item))return service.prepareInboxAnswer(i.item,actor,i.answer,i.words);
      return () => cvs.answer(i.item, actor, i.answer, i.words);
    },
    run(ctx, i, prepared) {
      const item = (prepared as () => Item)();
      ctx.changed('inbox', i.item);
      if (item.conversation) ctx.changed('inbox', item.conversation);
      if (item.thread) { changed(ctx, item.thread); ctx.changed('messages', item.thread); }
      return { saved: true };
    },
  }));

  operations.register(operation({ ...common, name: 'inbox.read', input: z.object({ item: z.string().min(1) }).strict(), output: acknowledgement,
    may: (v, i) => itemAccess(v, i.item, 'read'),
    run(ctx, i) { cvs.read(i.item, member(ctx.viewer)); ctx.changed('inboxReads', i.item); return { saved: true }; },
  }));
  operations.register(operation({ ...common, name: 'inbox.dismissResult',
    input: z.object({ id: z.string().min(1) }).strict(), output: acknowledgement,
    may: (viewer, input) => !!service.db.select({ id: actionResults.id }).from(actionResults)
      .where(and(eq(actionResults.id, input.id), sqlRule(rules.ownNotice, viewer, getTableColumns(actionResults)))).get(),
    run(ctx, input) {
      service.db.update(actionResults).set({ readAt: sql`coalesce(${actionResults.readAt}, ${new Date(ctx.now).toISOString()})` })
        .where(and(eq(actionResults.id, input.id), eq(actionResults.member, member(ctx.viewer)))).run();
      ctx.changed('actionResults', input.id);
      return { saved: true };
    },
  }));

}
