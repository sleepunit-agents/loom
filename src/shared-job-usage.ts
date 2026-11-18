import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { BodyProof } from './core/conversations/body-scope.js';
import type { DataDatabase } from './core/data/database.js';
import { jobs, jobUsage } from './core/data/schema.js';
import { OperationError, type Operations } from './core/operations/index.js';
import { usageReport } from './runtime/usage-report.js';

/** The job comes solely from the enrolled credential. Its asker's reach does not change what it may report. */
export function registerJobUsage(operations: Operations, db: DataDatabase, proof: BodyProof) {
  operations.register({ name: 'conversation.usage', write: true, recheckPolicy: true, doors: ['http'],
    input: usageReport, output: z.object({ saved: z.boolean() }).strict(),
    may: viewer => !!proof(viewer),
    inputHash: (canonical, { actor }) => createHash('sha256').update(JSON.stringify([proof(actor)?.job, canonical])).digest('hex'),
    run(ctx, report) {
      const body = proof(ctx.viewer);
      if (!body) throw new OperationError('denied', 'Assigned body required');
      const job = db.select({ id: jobs.id, harness: jobs.harness, model: jobs.model }).from(jobs).where(eq(jobs.id, body.job)).get()!;
      const result = db.insert(jobUsage).values({ ...report, job: job.id, harness: report.harness ?? job.harness, model: report.model ?? job.model })
        .onConflictDoNothing().run();
      if (result.changes) ctx.changed('job', job.id);
      return { saved: !!result.changes };
    },
  });
}
