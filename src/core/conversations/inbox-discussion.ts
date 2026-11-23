import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { holds, mayAct, mayCreate, rules, type Viewer } from '../../policy.js';
import { sharedSharing } from '../../shared-sharing.js';
import { commsKeepDays } from '../data/comms-days.js';
import { householdSettings } from '../data/household-settings.js';
import { agents, conversations, inbox, messages, threads } from '../data/schema.js';
import { operation, OperationError, type Operations } from '../operations/index.js';
import type { CommsMessages } from './messages.js';
import { keepUntilFor } from './retention.js';

type Item = typeof inbox.$inferSelect;

/** Only the addressee may bring a standalone household FYI into a private conversation. */
export function standaloneFyi(item: Item, member: string | null) {
  return item.toKind === 'person' && item.to === member && (!item.member || item.member === member)
    && !item.conversation && !item.thread && !item.answers && !item.waitsOnKind && !item.waitsOnId
    && (item.source === 'notice' || item.source === 'approval' || item.source === 'trigger');
}

function quotedFyi(item: Item) {
  return [item.words, item.why, item.link].filter(value => value?.trim()).join('\n\n');
}

export function inboxDiscussions(service: CommsMessages, read: (viewer: Viewer, id: string) => Item | null) {
  const db = service.db;
  function target(viewer: Viewer, id: string) {
    const item = read(viewer, id);
    if (!item || viewer.kind !== 'member' || !standaloneFyi(item, viewer.id)) return;
    const existing = db.select({ thread: threads.id, conversation: threads.conversation, agent: conversations.agent })
      .from(messages).innerJoin(threads, eq(threads.id, messages.thread))
      .innerJoin(conversations, eq(conversations.id, threads.conversation))
      .where(and(eq(messages.inboxItem, id), eq(messages.kind, 'notice'), eq(messages.seq, 1), eq(messages.sender, 'loom'),
        eq(conversations.venue, 'loom'), eq(conversations.member, viewer.id), isNull(conversations.project))).get();
    const sharing = sharedSharing(db);
    if (!holds(rules.currentMember, viewer, {}, sharing)) return;
    const scope = (agent: string) => ({type: 'conversation' as const, member: viewer.id, agent});
    const writable = (agent: string) => mayAct(viewer, scope(agent), sharing, 'give-work');
    if (existing) return writable(existing.agent) ? { item, agent: existing.agent, existing } : undefined;
    if (!item.words?.trim()) return;
    const preferred = householdSettings(db).defaultAgent ?? '';
    const agent = db.select({ id: agents.id }).from(agents).where(isNull(agents.removedAt))
      .orderBy(desc(eq(agents.id, preferred)), asc(agents.id)).all().find(row => writable(row.id) && mayCreate(viewer, scope(row.id), sharing));
    if (agent) return { item, agent: agent.id };
  }

  function current(viewer: Viewer, input: {item:string;expectedAgent?:string}) {
    const result = target(viewer, input.item);
    if (!result) throw new OperationError('denied', 'This FYI is unavailable');
    if (input.expectedAgent && result.agent !== input.expectedAgent)
      throw new OperationError('conflict', 'The discussion agent changed. Open this FYI again.');
    return result;
  }

  return {
    agent: (viewer: Viewer, id: string) => target(viewer, id)?.agent ?? null,
    install(operations: Operations) {
      operations.register(operation({
        name: 'inbox.discuss', doors: ['http'], write: true, refuses: true, recheckPolicy: true,
        input: z.object({ item: z.string().min(1), expectedAgent: z.string().min(1).optional() }).strict(),
        output: z.object({ thread: z.string(), conversation: z.string() }).strict(),
        inputHash: value => service.key.hash('inbox-discussion\0' + value),
        may: (viewer, input) => !!target(viewer, input.item),
        validateReplay(viewer, input, _prepared, receipt) {
          const existing = current(viewer, input).existing;
          if (!existing || !receipt?.ok || existing.thread !== (receipt.value as {thread:string}).thread)
            throw new OperationError('conflict', 'This discussion was deleted. Open the FYI again.');
        },
        async prepare(input, ctx) {
          const before = current(ctx.viewer, input);
          const quote = quotedFyi(before.item);
          const sealed = before.existing ? null : await service.key.seal(quote);
          return () => {
            const live = current(ctx.viewer, input);
            if (live.existing) return { thread: live.existing.thread, conversation: live.existing.conversation, created: false };
            if (!sealed || live.agent !== before.agent || quotedFyi(live.item) !== quote)
              throw new OperationError('conflict', 'This FYI changed. Open it again.');
            const thread = service.threads.open({ member: live.item.to, agent: live.agent, title: 'Inbox FYI', titledBy: 'agent' });
            const at = thread.openedAt;
            // A quoted notice gives the member context immediately. The first actual
            // question enters the delivery queue through the ordinary Comms composer.
            db.insert(messages).values({thread: thread.id, seq: 1, kind: 'notice', sender: 'loom',
              at, keepUntil: keepUntilFor(at, commsKeepDays(db)), words: sealed, inboxItem: live.item.id}).run();
            return {thread: thread.id, conversation: thread.conversation, created: true};
          };
        },
        run(ctx, input, prepared) {
          const {thread, conversation, created} = (prepared as () => {thread:string;conversation:string;created:boolean})();
          if (created) {
            ctx.changed('threads',thread); ctx.changed('conversations',conversation);
            ctx.changed('messages',thread); ctx.changed('inbox',input.item);
          }
          return { thread, conversation };
        },
      }));
    },
  };
}
