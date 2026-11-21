import { eq } from 'drizzle-orm';
import type { DataDatabase } from '../data/database.js';
import { approvals, conversations, jobs, secretRequests, secretGrants } from '../data/schema.js';

/** Parked continuations have their own watch names. Ordinary answer watches deliver their original words. */
export function parkedSource(trigger: {parked?: boolean; watches?: string | null}) {
  if (!trigger.parked) return undefined;
  const match = /^(park-approval|park-secret):([A-Za-z0-9_-]{1,200})$/.exec(trigger.watches ?? '');
  return match ? { approval:match[1] === 'park-approval', id:match[2] } : undefined;
}

type Destination = { agent: string; project?: string | null; member?: string | null; conversation?: string | null };

/** Check the actual audience again before delivery. An unlabelled wake is agent-wide.
 * A request attached to a job inherits that job's conversation and private labels. */
export function parkedDestination(db: DataDatabase, source: NonNullable<ReturnType<typeof parkedSource>>, dest: Destination) {
  const scope = source.approval
    ? db.select({agent:approvals.agent, member:approvals.member, project:approvals.project, conversation:approvals.conversation})
        .from(approvals).where(eq(approvals.id, source.id)).get()
    : db.select({agent:secretRequests.agent, conversation:secretRequests.conversation, job:secretRequests.job})
        .from(secretRequests).where(eq(secretRequests.id, source.id)).get();
  if (!scope || scope.agent !== dest.agent) return false;
  const job = 'job' in scope && scope.job ? db.select({agent:jobs.agent, conversation:jobs.conversation, project:jobs.project, member:jobs.member})
    .from(jobs).where(eq(jobs.id, scope.job)).get() : undefined;
  if ('job' in scope && scope.job && (!job || job.agent !== dest.agent)) return false;
  const conversation = scope.conversation ?? job?.conversation ?? null;
  if ((dest.conversation && conversation !== dest.conversation) || (job?.conversation && job.conversation !== conversation)) return false;
  const cv = conversation ? db.select({venue:conversations.venue, agent:conversations.agent, member:conversations.member, project:conversations.project})
    .from(conversations).where(eq(conversations.id, conversation)).get() : undefined;
  if (conversation && (!cv || cv.agent !== dest.agent)) return false;
  // Native chat and wake deliver privately to the same member, agent and project.
  // A bridge or handoff can carry an outside identity in addition to these labels.
  if (cv && !dest.conversation && ((cv.venue !== 'loom' && cv.venue !== 'wake') ||
      cv.member !== (dest.member ?? null) || cv.project !== (dest.project ?? null))) return false;
  if (cv && ((dest.project && dest.project !== cv.project) || (dest.member && dest.member !== cv.member))) return false;
  const member = cv ? cv.member : dest.member ?? null;
  const project = cv ? cv.project : dest.project ?? null;
  const labels = 'member' in scope ? scope : job;
  if (labels?.member && labels.member !== member || labels?.project && labels.project !== project) return false;
  return !!conversation || ((labels?.member ?? null) === member && (labels?.project ?? null) === project);
}

export function parkedVerdict(db: DataDatabase, source: NonNullable<ReturnType<typeof parkedSource>>, now: number) {
  if (source.approval) {
    const row = db.select({state:approvals.state, expires:approvals.expiresAt}).from(approvals).where(eq(approvals.id,source.id)).get();
    if (!row) return 'unavailable';
    if (row.state === 'allowed' && row.expires && Date.parse(row.expires) <= now) return 'expired';
    return row.state;
  }
  const row = db.select({state:secretRequests.state}).from(secretRequests).where(eq(secretRequests.id, source.id)).get();
  if (!row) return 'unavailable';
  if (row.state !== 'allowed') return row.state;
  const grant = db.select({expires:secretGrants.expiresAt}).from(secretGrants).where(eq(secretGrants.request, source.id)).get();
  return grant && Date.parse(grant.expires) > now ? 'allowed' : 'expired';
}
