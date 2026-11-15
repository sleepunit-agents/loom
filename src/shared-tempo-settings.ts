/** The fresh door supplies its authenticated body context, never request words.
 * Timings are only proposed here; Approvals applies the static prepared change. */
import type { Viewer } from './policy.js';
import type { DataDatabase } from './core/data/database.js';
import type { Clock } from './core/clock.js';
import type {conversationBodyScope} from './core/conversations/body-scope.js';
import type { approvalService } from './apps/approvals.js';
import { tempoSettingsProposals } from './core/tempo/proposal.js';
import type { Recipient, Timings } from './core/tempo/volume.js';
export function sharedTempoSettings(db: DataDatabase, clock: Clock,
  current: ReturnType<typeof conversationBodyScope>, approvals: ReturnType<typeof approvalService>) {
  const proposals = tempoSettingsProposals(db, clock);
  const context = (viewer: Viewer) => {
    const found=current(viewer);
    if(!found)return;
    const conversation=found.cv;
    return { agent: viewer.id, askedFrom: conversation.id, conversation: conversation.id, actingFor: conversation.member ?? 'unknown',
      project: conversation.project, member: conversation.member, why: 'Requested in this conversation' };
  };
  return {
    receiptScope(viewer:Viewer){const found=current(viewer);return found?JSON.stringify({job:found.job.id,box:found.job.box,conversation:found.cv.id,agent:found.cv.agent,member:found.cv.member,project:found.cv.project}):undefined;},
    chatMember(viewer: Viewer) { return context(viewer)?.member ?? undefined; },
    allowed(viewer: Viewer, who: Recipient) { const source=context(viewer); return !!source && (who.kind === 'agent' || source.member === who.id); },
    request(viewer: Viewer, who: Recipient, patch: Partial<Timings>) {
      const source = context(viewer);
      if (!source) throw new Error('Settings proposal needs the current authenticated body conversation');
      return proposals.request(approvals, who, patch, source);
    },
  };
}
