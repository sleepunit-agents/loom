import { and, eq } from 'drizzle-orm';
import type { DataDatabase } from '../data/database.js';
import { COMMIT } from '../../apps/merge-target.js';
import { conversations, jobs, threads } from '../data/schema.js';

export const REVIEW_ROLE_CHANGED = 'The requested work role changed or was removed.';
export const reviewBriefExpired = (cv: {handoffNotBefore: string | null}) =>
  cv.handoffNotBefore ? 'The scheduled handoff brief expired.' : 'The handoff brief expired.';

type ConversationScope = Pick<typeof conversations.$inferSelect, 'agent' | 'member' | 'project'>;

export function jobMatchesConversation(job: ConversationScope, cv: ConversationScope) {
  return job.agent === cv.agent && job.member === cv.member && job.project === cv.project;
}

/** What a frozen review (conversation.review) looks at, fixed when it was asked for and kept in the child
 * conversation's place, which never changes: the repository (`owner/name` on GitHub), the exact commit, the commit its
 * diff is taken against (a pull request's merge base with its base branch, or a commit's first parent), the pull
 * request loom follows when it is one (`changes.id`, the round is filed on it), and the round's tier. */
export interface ReviewTarget { repository: string; head: string; base: string; change: string | null; tier: 'medium' | 'high' }
const SHA = COMMIT, REPOSITORY = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
/** A repository as a frozen review names it: `owner/name`, each part 1 to 100 of GitHub's characters, neither `.` nor `..`. */
export function reviewRepository(value: string): boolean {
  return REPOSITORY.test(value) && !value.split('/').some(part => part === '.' || part === '..');
}
export function reviewTarget(value: unknown): ReviewTarget | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join() !== 'base,change,head,repository,tier') return;
  if (typeof v.repository !== 'string' || !reviewRepository(v.repository)) return;
  if (typeof v.head !== 'string' || !SHA.test(v.head) || typeof v.base !== 'string' || !SHA.test(v.base)) return;
  if (v.change !== null && (typeof v.change !== 'string' || !v.change.length || v.change.length > 300)) return;
  if (v.tier !== 'medium' && v.tier !== 'high') return;
  return { repository: v.repository, head: v.head, base: v.base, change: v.change as string | null, tier: v.tier };
}

/** A distinct child conversation for each request, including parallel requests from one job. A frozen review's
 * target is its sixth part, so what it reviews is fixed with the conversation itself. */
export function reviewPlace(parent: string, clientId: string, role?:{id:string;revision:string}, target?: ReviewTarget) {
  if (target && !role) throw new Error('A frozen review runs in a work role');
  // The target is read back by the strict shape before the place is made: a place loom writes is one it can read.
  if (target && !reviewTarget(target)) throw new Error('Invalid frozen review target');
  return JSON.stringify(['codex-review', parent, clientId, ...(role?[role.id,role.revision]:[]), ...(target?[JSON.stringify(target)]:[])]);
}

/** A handed-off review's place that loom cannot read: it starts as one, but it is no request loom made, or its
 * frozen target does not parse by the strict shape (reviewTarget). Such a conversation is never an ordinary
 * handoff: its job is unrunnable and ended unplaced (dispatcher.ts), so it gets no secret, kit or mount. */
export const REVIEW_PLACE_UNREADABLE = 'The review this session was asked for could not be read, so it was not run.';
export function unrunnableReview(cv: {venue: string; place: string}): boolean {
  return cv.venue === 'handoff' && cv.place.startsWith('["codex-review",') && !reviewRequest(cv);
}

export function reviewRequest(cv: {venue: string; place: string}) {
  if (cv.venue !== 'handoff' || !cv.place.startsWith('["codex-review",')) return;
  try {
    const parts: unknown = JSON.parse(cv.place);
    if (Array.isArray(parts) && (parts.length === 3 || parts.length === 5 || parts.length === 6) && parts.every(p => typeof p === 'string')) {
      let target: ReviewTarget | undefined;
      if (parts.length === 6) { try { target = reviewTarget(JSON.parse(parts[5] as string)); } catch { return; } }
      // A sixth part that is not a whole target is no request loom made: nothing is run for it (unrunnableReview).
      if (parts.length === 6 && !target) return;
      return {parent:parts[1] as string, clientId:parts[2] as string, role:parts.length>=5?{id:parts[3] as string,revision:parts[4] as string}:undefined,
        ...(target ? {target} : {})};
    }
  } catch { /* An ordinary handoff place has no review destination. */ }
}

/** The frozen review a conversation is, if it is one: what conversation.review pinned. */
export function frozenReview(cv: {venue: string; place: string}): ReviewTarget | undefined {
  return reviewRequest(cv)?.target;
}

export function reviewParent(cv: {venue: string; place: string}) {
  return reviewRequest(cv)?.parent;
}

export function reviewThread(db: DataDatabase, cv: typeof conversations.$inferSelect) {
  const parent = reviewParent(cv);
  if (!parent || !cv.member) return;
  const origin = db.select({cv: conversations, thread: threads, agent: jobs.agent, member: jobs.member, project: jobs.project}).from(jobs)
    .innerJoin(conversations, eq(jobs.conversation, conversations.id))
    .innerJoin(threads, eq(threads.conversation, conversations.id))
    .where(and(eq(jobs.id, parent), eq(jobs.agent, cv.agent))).get();
  if (origin?.cv.venue === 'loom' && jobMatchesConversation(origin,origin.cv) && origin.cv.agent === cv.agent && origin.cv.project === cv.project &&
      origin.cv.member === cv.member && origin.cv.direct === cv.direct && !origin.thread.archivedAt) return origin.thread;
}
