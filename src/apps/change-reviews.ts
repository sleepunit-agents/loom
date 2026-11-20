import { and, desc, eq, getTableColumns, isNull, type SQL } from 'drizzle-orm';
import type { DataDatabase } from '../core/data/database.js';
import { changes, jobs, changeReviewRounds as rounds } from '../core/data/schema.js';

type Review = typeof rounds.$inferSelect;
type Assignment = Pick<Review, 'job' | 'change' | 'headCommit' | 'tier' | 'round'>;
type Receipt = Pick<Assignment, 'job' | 'change' | 'headCommit'> & {
  verdict: NonNullable<Review['verdict']>;
  findings: string;
};

export function hasChangeReview(db: DataDatabase, job: string): boolean {
  return !!db.select({ job: rounds.job }).from(rounds).where(eq(rounds.job, job)).get();
}

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
  function history(change: string, visibility?: { change: SQL; job: SQL }) {
    return db.select({ ...getTableColumns(rounds), currentHead: changes.headCommit }).from(rounds)
      .innerJoin(changes, eq(rounds.change, changes.id)).innerJoin(jobs, eq(rounds.job, jobs.id))
      .where(and(eq(rounds.change, change), visibility?.change, visibility?.job))
      .orderBy(desc(rounds.requestedAt), desc(rounds.job)).all()
      .map(({ currentHead, ...row }) => ({ ...row, current: row.headCommit === currentHead }));
  }
  return { assign, finish, history };
}
