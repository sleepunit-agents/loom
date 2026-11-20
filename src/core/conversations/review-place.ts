import { and, eq } from 'drizzle-orm';
import type { DataDatabase } from '../data/database.js';
import { conversations, jobs, threads } from '../data/schema.js';

/** A distinct child conversation for each request, including parallel requests from one job. */
export function reviewPlace(parent: string, clientId: string) {
  return JSON.stringify(['codex-review', parent, clientId]);
}

export function reviewParent(cv: {venue: string; place: string}) {
  if (cv.venue !== 'handoff' || !cv.place.startsWith('["codex-review",')) return;
  try {
    const parts: unknown = JSON.parse(cv.place);
    if (Array.isArray(parts) && parts.length === 3 && parts.every(p => typeof p === 'string')) return parts[1] as string;
  } catch { /* An ordinary handoff place has no review destination. */ }
}

export function reviewThread(db: DataDatabase, cv: typeof conversations.$inferSelect) {
  const parent = reviewParent(cv);
  if (!parent || !cv.member) return;
  const origin = db.select({cv: conversations, thread: threads}).from(jobs)
    .innerJoin(conversations, eq(jobs.conversation, conversations.id))
    .innerJoin(threads, eq(threads.conversation, conversations.id))
    .where(and(eq(jobs.id, parent), eq(jobs.agent, cv.agent))).get();
  if (origin?.cv.venue === 'loom' && origin.cv.agent === cv.agent && origin.cv.project === cv.project &&
      origin.cv.member === cv.member && origin.cv.direct === cv.direct && !origin.thread.archivedAt) return origin.thread;
}
