/** Ending a job by hand. A household owner, or a member who owns the job's
 * agent, ends work that is stuck (reset) or gives up on it (write-off). The
 * job records who ended it and why. */
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Viewer } from './policy.js';
import type { DataDatabase } from './core/data/database.js';
import { jobs, members, memberAgents } from './core/data/schema.js';
import { OperationError, type Operations } from './core/operations/index.js';
export function registerSharedJobControl(operations: Operations, db: DataDatabase, stop: (job: string, member: string, reason: 'reset' | 'write-off') => unknown) {
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
      stop(input.job, ctx.viewer.id, input.reason);
      ctx.changed('jobs', input.job);
      return { stopped: true as const };
    },
  });
}
