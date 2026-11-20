/** What a body's mailbox commands are bound to: its own job and conversation,
 * and the member it is working for. Read from the authenticated body, never from request words. */
import type { Viewer } from './policy.js';
import type {conversationBodyScope} from './core/conversations/body-scope.js';
export function sharedTempoSettings(current: ReturnType<typeof conversationBodyScope>) {
  return {
    receiptScope(viewer:Viewer){const found=current(viewer);return found?JSON.stringify({job:found.job.id,box:found.job.box,conversation:found.cv.id,agent:found.cv.agent,member:found.cv.member,project:found.cv.project}):undefined;},
    chatMember(viewer: Viewer) { return current(viewer)?.cv.member ?? undefined; },
  };
}
