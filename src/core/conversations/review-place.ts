import { and, eq } from 'drizzle-orm';
import type { DataDatabase } from '../data/database.js';
import { conversations, jobs, threads } from '../data/schema.js';

export const REVIEW_ROLE_CHANGED = 'The requested work role changed or was removed.';
export const reviewBriefExpired = (cv: {handoffNotBefore: string | null}) =>
  cv.handoffNotBefore ? 'The scheduled handoff brief expired.' : 'The handoff brief expired.';

type ConversationScope = Pick<typeof conversations.$inferSelect, 'agent' | 'member' | 'project'>;

export function jobMatchesConversation(job: ConversationScope, cv: ConversationScope) {
  return job.agent === cv.agent && job.member === cv.member && job.project === cv.project;
}

/** A distinct child conversation for each request, including parallel requests from one job. */
export function reviewPlace(parent: string, clientId: string, role?:{id:string;revision:string}) {
  return JSON.stringify(['codex-review', parent, clientId, ...(role?[role.id,role.revision]:[])]);
}

export function reviewRequest(cv: {venue: string; place: string}) {
  if (cv.venue !== 'handoff' || !cv.place.startsWith('["codex-review",')) return;
  try {
    const parts: unknown = JSON.parse(cv.place);
    if (Array.isArray(parts) && (parts.length === 3 || parts.length === 5) && parts.every(p => typeof p === 'string'))
      return {parent:parts[1] as string, clientId:parts[2] as string, role:parts.length===5?{id:parts[3] as string,revision:parts[4] as string}:undefined};
  } catch { /* An ordinary handoff place has no review destination. */ }
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
