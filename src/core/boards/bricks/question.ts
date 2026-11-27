import { z } from 'zod';
import { inbox } from '../../data/schema.js';
import { brick, none, ref } from './kit.js';

/** What inbox.answer takes as its `answer` from a member's hand (web/src/pieces/inbox-view/model.ts, InboxAnswer).
 * `words` says the member answered in words; the words themselves go to inbox.answer and never to the board. */
export const questionAnswers = ['yes', 'no', 'words', 'done', 'dismiss'] as const;

/** What runtime.workerJoinDecide takes as its `decision` (src/core/signin/worker-join.ts). */
export const joinDecisions = ['allow', 'block'] as const;

export default brick({ name: 'question', shows: 'A question waiting on the member, answered from the board.',
  params: z.object({ item: ref }).strict(), references: { item: 'inbox item' }, linkKey: 'item',
  actions: { answer: { operation: 'inbox.answer', detail: z.object({ answer: z.enum(questionAnswers) }).strict() },
    // How loudly the item is shown, where the member may set it: the column's own choices.
    volume: { operation: 'inbox.volume', detail: z.object({ volume: z.enum(inbox.volume.enumValues) }).strict() },
    // The three answers the desktop's opened item gives beside the Inbox's own: a conversation about a notice, a
    // task's question answered through its task (which takes no Mark done or Dismiss), and a machine asking to join.
    discuss: { operation: 'inbox.discuss', detail: none },
    taskAnswer: { operation: 'tasks.command', detail: z.object({ answer: z.enum(questionAnswers.slice(0, 3) as ['yes', 'no', 'words']) }).strict() },
    join: { operation: 'runtime.workerJoinDecide', detail: z.object({ decision: z.enum(joinDecisions) }).strict() } } });
