/** The fresh door supplies its authenticated body context, never request words.
 * Timings are only proposed here; Approvals applies the static prepared change. */
import { and, asc, eq } from 'drizzle-orm';
import type { Viewer } from './policy.js';
import type { DataDatabase } from './core/data/database.js';
import type { Clock } from './core/clock.js';
import { conversations, jobs, members } from './core/data/schema.js';
import type { approvalService } from './apps/approvals.js';
import { tempoSettingsProposals } from './core/tempo/proposal.js';
import type { Recipient, Timings } from './core/tempo/volume.js';
export interface TempoChatAuthentication { viewer: Viewer; readonly job?: string; valid(): boolean }
export function sharedTempoSettings(db: DataDatabase, clock: Clock,
  current: () => TempoChatAuthentication | undefined, approvals: ReturnType<typeof approvalService>) {
  const proposals = tempoSettingsProposals(db, clock);
  const context = (viewer: Viewer) => {
    const auth = current();
    if (!auth?.valid() || auth.viewer.kind !== 'agent' || viewer.kind !== 'agent' || auth.viewer.id !== viewer.id || !auth.job) return;
    const job = db.select().from(jobs).where(and(eq(jobs.id, auth.job), eq(jobs.agent, viewer.id), eq(jobs.state, 'running'))).get();
    if (!job?.conversation) return;
    const conversation = db.select().from(conversations).where(and(eq(conversations.id, job.conversation),
      eq(conversations.agent, viewer.id), eq(conversations.job, job.id))).get();
    if (!conversation) return;
    const owner = conversation.member ?? db.select({id:members.id}).from(members)
      .where(eq(members.role, 'owner')).orderBy(asc(members.position), asc(members.id)).get()?.id;
    if (!owner) return;
    return { agent: viewer.id, askedFrom: conversation.id, conversation: conversation.id, actingFor: owner,
      project: conversation.project, member: conversation.member, why: 'Requested in this conversation' };
  };
  return {
    allowed(viewer: Viewer) { return !!context(viewer); },
    request(viewer: Viewer, who: Recipient, patch: Partial<Timings>) {
      const source = context(viewer);
      if (!source) throw new Error('Settings proposal needs the current authenticated body conversation');
      return proposals.request(approvals, who, patch, source);
    },
  };
}
