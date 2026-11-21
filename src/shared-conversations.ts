import type {inbox as inboxTable} from './core/data/schema.js';
import {privateInboxDeadline} from './core/conversations/private-inbox-words.js';
import {commsKeepDays} from './core/data/comms-days.js';
import { readInboxVolume } from './core/data/inbox-volume.js';
import {conversationQuestionPolicy} from './shared-conversation-questions.js';
/** Conversations at the shared outside boundary. Current household facts and
 * the existing ordered policy decide every read/write; services own no policy. */
import type { DataDatabase } from './core/data/database.js';
import type { Clock } from './core/clock.js';
import type { Operations } from './core/operations/index.js';
import { conversationVisibility } from './core/data/conversation-visibility.js';
import type { AnyColumn } from 'drizzle-orm';
import { holds, mayAct, mayCreate, rules, type RecordScope, type Viewer } from './policy.js';
import { tempoCommandAllowed } from './shared-tempo-access.js';
import { sharedSharing } from './shared-sharing.js';
import { CommsMessages } from './core/conversations/messages.js';
import { CommsQueries, commsQueryFields } from './core/conversations/comms-query.js';
import { InboxQueries, inboxQueryFields, type QuestionAsker } from './core/conversations/inbox-query.js';
import { ConversationSummaries, conversationSummaryFields } from './core/conversations/summaries.js';
import { registerConversationOperations } from './core/conversations/operations.js';
import { lateMailJoins, tellOwners } from './shared-place-mail.js';
import type { WordsKey } from './core/conversations/words.js';

export function sharedConversations(db: DataDatabase, clock: Clock, key: WordsKey, questionAsker?:QuestionAsker) {
  const now = () => new Date(clock.now()).toISOString();
  // Bodies take their mail through this service: mail a person writes after a job was admitted joins it only
  // when the same asker wrote it (shared-place-mail.ts, lateMailJoins).
  const service = new CommsMessages(db, key, now, job => lateMailJoins(db, job));
  // A thread is read by the rule of its conversation: its own member, nobody else.
  const policy = (viewer: Viewer, fields: Record<string, AnyColumn>) => conversationVisibility(viewer).conversations!(fields);
  const questionPolicy=conversationQuestionPolicy(db);
  // Who may answer an item is the household's rule (policy.ts, answers), asked here for the read side's
  // "can answer" and for the write alike.
  const answers = (viewer: Viewer) => { const sharing = sharedSharing(db); return (item: typeof inboxTable.$inferSelect) => {
    if(item.source==='thread'&&item.sourceId?.startsWith('guest-decision:')){
      if(!item.agent||viewer.kind!=='member'||viewer.id!==item.to||!tellOwners(db,item.agent).includes(viewer.id))return false;
      if(privateInboxDeadline(item,commsKeepDays(db))<=clock.now())return false;
    }
    return holds(rules.answers, viewer, item, sharing);
  }; };
  const queries = new CommsQueries(db, key, policy, now), inbox = new InboxQueries(db, key, questionPolicy.visibility, now, (viewer, item) => tempoCommandAllowed(db, viewer, { action: 'volume', item }), (viewer,items)=>readInboxVolume(db,viewer,items,f=>questionPolicy.sourceVisibility(viewer,f)), answers, questionAsker);
  const summaries = new ConversationSummaries(db, key, now);
  const scope = (row: { member?: string | null; project?: string | null; agent?: string | null }): RecordScope => ({
    type: 'conversation', member: row.member ?? undefined, project: row.project ?? undefined, agent: row.agent ?? undefined,
  });
  return {
    service, queries, inbox, summaries, authorizeQuestion:questionPolicy.ask,
    fields: { ...commsQueryFields(queries), ...inboxQueryFields(inbox), ...conversationSummaryFields(summaries) },
    install(operations: Operations) {
      registerConversationOperations(operations, service, { authorize(viewer, access) {
        if (viewer.kind !== 'member') return false;
        const sharing = sharedSharing(db);
        if (access.action === 'open') {
          const record = scope(access);
          return access.member === viewer.id && mayCreate(viewer, record, sharing) && mayAct(viewer, record, sharing, 'give-work');
        }
        if ('item' in access) return !!inbox.item(viewer,access.item.id) && (access.action === 'read' || answers(viewer)(access.item));
        if (access.conversation.venue === 'terminal' &&
            (access.action === 'send' || (access.action === 'change' && access.change === 'stop'))) return false;
        // A thread is its member's alone, to read, send to or manage (docs/specs/comms.md, rule 2).
        return access.conversation.member === viewer.id && mayAct(viewer, scope(access.conversation), sharing, access.action === 'send' ? 'give-work' : 'act');
      } });
    },
  };
}
