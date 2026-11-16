/** Ending a job by hand. A household owner, or a member who owns the job's
 * agent, ends work that is stuck (reset) or gives up on it (write-off). The
 * job records who ended it and why. */
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Viewer } from './policy.js';
import type { DataDatabase } from './core/data/database.js';
import { jobs, members, memberAgents } from './core/data/schema.js';
import { OperationError, type Operations } from './core/operations/index.js';
import { Jobs } from './runtime/jobs.js';
export function registerSharedJobControl(operations: Operations, db: DataDatabase, options: { now(): string; jobEnded(job: string): void }) {
  const store = new Jobs(db, options.now);
  const may = (viewer: Viewer, id: string) => {
    if (viewer.kind !== 'member') return false;
    const job = db.select({ agent: jobs.agent }).from(jobs).where(eq(jobs.id, id)).get();
    if (!job) return false;
    return db.select({ role: members.role }).from(members).where(eq(members.id, viewer.id)).get()?.role === 'owner'
      || !!db.select().from(memberAgents).where(and(eq(memberAgents.member, viewer.id), eq(memberAgents.agent, job.agent))).get();
  };
  operations.register({ name: 'runtime.jobStop', write: true, recheckPolicy: true, doors: ['http'],
    input: z.object({ job: z.string().min(1).max(200), reason: z.enum(['reset', 'write-off']) }).strict(),
    output: z.object({ stopped: z.literal(true) }).strict(),
    may: (viewer, input) => may(viewer, input.job),
    run(ctx, input) {
      const job = db.select({ state: jobs.state }).from(jobs).where(eq(jobs.id, input.job)).get();
      if (!job || !['queued', 'starting', 'running', 'waiting'].includes(job.state)) throw new OperationError('conflict', 'That job has already ended');
      store.stop(input.job, ctx.viewer.id, input.reason);
      ctx.changed('job', input.job);
      return { stopped: true as const };
    },
    // Watchers hear of the end only after it and its receipt are saved, as with a worker's finish.
    after: input => options.jobEnded(input.job),
  });
}
