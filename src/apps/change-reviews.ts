import { and, desc, eq, getTableColumns, isNull, type SQL } from 'drizzle-orm';
import type { DataDatabase } from '../core/data/database.js';
import { changes, conversations, jobs, changeReviewRounds as rounds } from '../core/data/schema.js';
import { frozenReview, type ReviewTarget } from '../core/conversations/review-place.js';

type Review = typeof rounds.$inferSelect;
type Assignment = Pick<Review, 'job' | 'change' | 'headCommit' | 'tier' | 'round'>;
type Receipt = Pick<Assignment, 'job' | 'change' | 'headCommit'> & {
  verdict: NonNullable<Review['verdict']>;
  findings: string;
};

export function hasChangeReview(db: DataDatabase, job: string): boolean {
  return !!db.select({ job: rounds.job }).from(rounds).where(eq(rounds.job, job)).get();
}

/** A cold review: a round that is not a frozen review's, run by a worker's own review executor and filed with the
 * job's finish (shared-runtime.ts). A frozen review (below) has a body of its own and files its round from its reply. */
export function coldReviewJob(db: DataDatabase, job: string): boolean {
  return hasChangeReview(db, job) && !frozenReviewOf(db, job);
}

/** What a job reviews when it is a frozen review (conversation.review): the target pinned in its conversation's place. */
export function frozenReviewOf(db: DataDatabase, job: string): ReviewTarget | undefined {
  const cv = db.select({ venue: conversations.venue, place: conversations.place }).from(jobs)
    .innerJoin(conversations, eq(conversations.id, jobs.conversation)).where(eq(jobs.id, job)).get();
  return cv ? frozenReview(cv) : undefined;
}

/** A job handed no secret, no kit and no retry: any review, cold or frozen. */
export function reviewJob(db: DataDatabase, job: string): boolean {
  return hasChangeReview(db, job) || !!frozenReviewOf(db, job);
}

/** The reviewer's verdict, by one rule for every harness: the reply's last line, trimmed of trailing space, is exactly
 * `VERDICT: CLEAR` or `VERDICT: BLOCKING`. A CRITICAL or MAJOR bullet makes a CLEAR blocking. No such line: no verdict. */
export function replyVerdict(reply: string): 'CLEAR' | 'BLOCKING' | undefined {
  const last = reply.trimEnd().split('\n').at(-1)?.trimEnd();
  if (last !== 'VERDICT: CLEAR' && last !== 'VERDICT: BLOCKING') return;
  return last === 'VERDICT: BLOCKING' || /^[ \t]*[-*+][ \t]+(?:CRITICAL|MAJOR)\b/m.test(reply) ? 'BLOCKING' : 'CLEAR';
}
/** What a round records of a reply that gave no verdict. */
export const NO_VERDICT = 'The reviewer did not return a final verdict.';
export const TREE_CHANGED = 'The reviewed files changed during the round.';

export function closePendingReview(db: DataDatabase, job: string, at: string) {
  db.update(rounds).set({ verdict: 'NONE', findings: 'The job ended without a reviewer report.', completedAt: at })
    .where(and(eq(rounds.job, job), isNull(rounds.completedAt))).run();
}

/** Internal coordinator storage. Caller authenticates the reporting job before filing its receipt. */
export function changeReviewStore(db: DataDatabase, now = () => new Date().toISOString()) {
  function assign(input: Assignment) {
    return db.transaction(tx => {
      const existing = tx.select().from(rounds).where(eq(rounds.job, input.job)).get();
      if (existing) {
        if (existing.change !== input.change || existing.headCommit !== input.headCommit ||
            existing.tier !== input.tier || existing.round !== input.round) throw new Error('Review job already assigned');
        return existing;
      }
      const job = tx.select({ state: jobs.state, kind: jobs.startedByKind }).from(jobs).where(eq(jobs.id, input.job)).get();
      if (!job || job.state !== 'queued' || job.kind === 'program' || job.kind === 'terminal')
        throw new Error('Review needs an unclaimed model job');
      const change = tx.select({ head: changes.headCommit }).from(changes).where(eq(changes.id, input.change)).get();
      if (change?.head !== input.headCommit) throw new Error('Review commit is not the current change head');
      return tx.insert(rounds).values({ job: input.job, change: input.change, headCommit: input.headCommit,
        tier: input.tier, round: input.round, requestedAt: now() }).returning().get();
    }, { behavior: 'immediate' });
  }
  function finish(input: Receipt) {
    return db.transaction(tx => {
      const match = and(eq(rounds.job, input.job), eq(rounds.change, input.change), eq(rounds.headCommit, input.headCommit));
      const row = tx.select().from(rounds).where(match).get();
      if (!row) throw new Error('Receipt does not match review assignment');
      if (row.completedAt !== null) {
        if (row.verdict !== input.verdict || row.findings !== input.findings) throw new Error('Review result already filed');
        return row;
      }
      return tx.update(rounds).set({ verdict: input.verdict, findings: input.findings, completedAt: now() })
        .where(match).returning().get();
    }, { behavior: 'immediate' });
  }
  /** A frozen review's round, filed when its job is formed (Jobs.admission). It is kept on the commit the review
   * was pinned to, which need not be the change's head by then: the history says whether it is. */
  function assignFrozen(input: { job: string; target: ReviewTarget }) {
    const change = input.target.change;
    if (!change) return;
    const existing = db.select().from(rounds).where(eq(rounds.job, input.job)).get();
    if (existing) return existing;
    const job = db.select({ state: jobs.state }).from(jobs).where(eq(jobs.id, input.job)).get();
    if (job?.state !== 'queued' || !db.select({ id: changes.id }).from(changes).where(eq(changes.id, change)).get()) return;
    const round = (db.select({ round: rounds.round }).from(rounds).where(eq(rounds.change, change)).orderBy(desc(rounds.round)).limit(1).get()?.round ?? 0) + 1;
    return db.insert(rounds).values({ job: input.job, change, headCommit: input.target.head, tier: input.target.tier, round, requestedAt: now() }).returning().get();
  }
  /** A frozen review's reply, filed as it is relayed (body-output.ts). Once filed it is final, but for `voided`. */
  function fileReply(job: string, reply: string) {
    const row = db.select().from(rounds).where(eq(rounds.job, job)).get();
    if (!row || row.completedAt !== null) return row;
    const verdict = replyVerdict(reply);
    return db.update(rounds).set({ verdict: verdict ?? 'NONE', findings: verdict ? reply : NO_VERDICT + '\n\n' + reply, completedAt: now() })
      .where(and(eq(rounds.job, job), isNull(rounds.completedAt))).returning().get();
  }
  /** The worker found the reviewed files changed at the end of the round: whatever was filed is no verdict. */
  function voided(job: string, why: string) {
    db.update(rounds).set({ verdict: 'NONE', findings: why, completedAt: now() }).where(eq(rounds.job, job)).run();
  }
  function history(change: string, visibility?: { change: SQL; job: SQL }) {
    return db.select({ ...getTableColumns(rounds), currentHead: changes.headCommit, conversation: jobs.conversation }).from(rounds)
      .innerJoin(changes, eq(rounds.change, changes.id)).innerJoin(jobs, eq(rounds.job, jobs.id))
      .where(and(eq(rounds.change, change), visibility?.change, visibility?.job))
      .orderBy(desc(rounds.requestedAt), desc(rounds.job)).all()
      .map(({ currentHead, ...row }) => ({ ...row, current: row.headCommit === currentHead }));
  }
  return { assign, finish, assignFrozen, fileReply, voided, history };
}
