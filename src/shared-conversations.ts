/** Conversations at the shared outside boundary. Current household facts and
 * the existing ordered policy decide every read/write; services own no policy. */
import type { DataDatabase } from './core/data/database.js';
import type { Clock } from './core/clock.js';
import type { Operations } from './core/operations/index.js';
import { workVisibility } from './core/data/work-visibility.js';
import { mayAct, mayCreate, maySee, type RecordScope } from './policy.js';
import { sharedSharing } from './shared-sharing.js';
import { CommsMessages } from './core/conversations/messages.js';
import { CommsQueries, commsQueryFields } from './core/conversations/comms-query.js';
import { InboxQueries, inboxQueryFields } from './core/conversations/inbox-query.js';
import { ConversationSummaries, conversationSummaryFields } from './core/conversations/summaries.js';
import { registerConversationOperations } from './core/conversations/operations.js';
import type { WordsKey } from './core/conversations/words.js';

export function sharedConversations(db: DataDatabase, clock: Clock, key: WordsKey) {
  const now = () => new Date(clock.now()).toISOString();
  const service = new CommsMessages(db, key, now);
  const policy = (viewer: Parameters<typeof workVisibility>[0], fields: Parameters<NonNullable<ReturnType<typeof workVisibility>['approvals']>>[0]) => workVisibility(viewer).approvals!(fields);
  const queries = new CommsQueries(db, key, policy, now), inbox = new InboxQueries(db, key, policy, now);
  const summaries = new ConversationSummaries(db, key, now);
  const scope = (row: { member?: string | null; project?: string | null; agent?: string | null }): RecordScope => ({
    type: 'conversation', member: row.member ?? undefined, project: row.project ?? undefined, agent: row.agent ?? undefined,
  });
  return {
    service, queries, inbox, summaries,
    fields: { ...commsQueryFields(queries), ...inboxQueryFields(inbox), ...conversationSummaryFields(summaries) },
    install(operations: Operations) {
      registerConversationOperations(operations, service, { authorize(viewer, access) {
        if (viewer.kind !== 'member') return false;
        const sharing = sharedSharing(db);
        if (access.action === 'open') {
          const record = scope(access);
          return access.member === viewer.id && mayCreate(viewer, record, sharing) && mayAct(viewer, record, sharing, 'give-work');
        }
        if ('item' in access) return access.item.toKind === 'person' && access.item.to === viewer.id && maySee(viewer, scope(access.item), sharing);
        // Household owners can read another person's private thread; its member
        // remains the only person who can send or manage it.
        return access.conversation.member === viewer.id && mayAct(viewer, scope(access.conversation), sharing, access.action === 'send' ? 'give-work' : 'act');
      } });
    },
  };
}
