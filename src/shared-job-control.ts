/** Ending a job by hand: work that is stuck (reset) or given up on (write-off). Who may is the stopJob
 * rule in policy.ts, which is wider than who may read the job, on purpose and for the reason given there.
 * So this door says nothing of a job but that it stopped, or that it had already ended. The job records
 * who ended it and why. */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { holds, rules, type Viewer } from './policy.js';
import { sharedSharing } from './shared-sharing.js';
import type { DataDatabase } from './core/data/database.js';
import { jobs } from './core/data/schema.js';
import { jobUnended } from './core/data/job-states.js';
import { OperationError, type Operations } from './core/operations/index.js';
import { Jobs } from './runtime/jobs.js';
export function registerSharedJobControl(operations: Operations, db: DataDatabase, options: { now(): string; jobEnded(job: string): void }) {
  const store = new Jobs(db, options.now);
  const may = (viewer: Viewer, id: string) => {
    const job = db.select({ agent: jobs.agent }).from(jobs).where(eq(jobs.id, id)).get();
    return !!job && holds(rules.stopJob, viewer, job, sharedSharing(db));
  };
  operations.register({ name: 'runtime.jobStop', write: true, recheckPolicy: true, doors: ['http'],
    input: z.object({ job: z.string().min(1).max(200), reason: z.enum(['reset', 'write-off']) }).strict(),
    output: z.object({ stopped: z.literal(true) }).strict(),
    may: (viewer, input) => may(viewer, input.job),
    run(ctx, input) {
      const job = db.select({ state: jobs.state }).from(jobs).where(eq(jobs.id, input.job)).get();
      if (!job || !jobUnended(job.state)) throw new OperationError('conflict', 'That job has already ended');
      store.stop(input.job, ctx.viewer.id, input.reason);
      ctx.changed('job', input.job);
      return { stopped: true as const };
    },
    // Watchers hear of the end only after it and its receipt are saved, as with a worker's finish.
    after: input => options.jobEnded(input.job),
  });
}
