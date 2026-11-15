import {keepJobText} from './runtime/job-text.js';
/** Worker operations on the shared connection. No body executes in this root. */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from './core/data/database.js';
import { boxes, jobs, conversations } from './core/data/schema.js';
import { OperationError, type Operations } from './core/operations/index.js';
import type { Viewer } from './policy.js';
import { Dispatcher } from './runtime/dispatcher.js';
import type { ModelRole } from './runtime/placement.js';
import { machineFacts } from './runtime/machine-facts.js';
import { workerAssignment } from './runtime/worker-http.js';

const jobInput = z.object({ job: z.string().min(1) });
const ack = z.object({ ok: z.literal(true) }).strict();
export function registerSharedRuntime(operations: Operations, db: DataDatabase, options: {
  now(): string; roles(): readonly ModelRole[];
  runner(viewer: Viewer): Readonly<{ box: string }> | undefined;
  /** Called after the effect AND receipt commit, including successful replay. */
  jobEnded(id: string): void;
}) {
  const dispatcher = new Dispatcher(db, options.now, options.roles);
  const stopped=new WeakSet<object>();
  const machine = (viewer: Viewer) => {
    if (viewer.kind !== 'runner' || options.runner(viewer)?.box !== viewer.id) return false;
    const row = db.select().from(boxes).where(eq(boxes.id, viewer.id)).get();
    return !!row && row.revokedAt === null;
  };
  const assigned = (viewer: Viewer, id: string, states?: readonly string[]) => {
    if (!machine(viewer)) return false;
    const job = db.select({ box: jobs.box, state: jobs.state }).from(jobs).where(eq(jobs.id, id)).get();
    return job?.box === viewer.id && (!states || states.includes(job.state));
  };
  const runner = (viewer: Viewer) => {
    if (viewer.kind !== 'runner' || options.runner(viewer)?.box !== viewer.id) throw new OperationError('denied', 'Worker required');
    return viewer.id;
  };
  operations.register({ name: 'runtime.health', write: true, recheckPolicy: true, doors: ['http'],
    input: z.object({ facts: machineFacts.optional() }).strict(), output: ack, may: machine,
    validateReplay() { throw new OperationError('conflict', 'Report with a new operation id'); },
    run(ctx, input) {
      const box = runner(ctx.viewer); dispatcher.machines.heartbeat(box, input.facts);
      ctx.changed('box', box); return { ok: true as const };
    },
  });
  operations.register({ name: 'runtime.next', write: true, recheckPolicy: true, doors: ['http'],
    input: z.object({ facts: machineFacts.optional() }).strict(), output: workerAssignment.nullable(), may: machine,
    // The client never retries an uncertain claim. Replaying an old assignment
    // could launch work that is already terminal, so it never releases a body.
    validateReplay() { throw new OperationError('conflict', 'Poll with a new operation id'); },
    run(ctx, input) {
      const box = runner(ctx.viewer), assignment = dispatcher.next(box, input.facts);
      ctx.changed('box', box); if (assignment) ctx.changed('job', assignment.id);
      return assignment ?? null;
    },
  });
  operations.register({ name: 'runtime.started', write: true, recheckPolicy: true, doors: ['http'],
    input: jobInput.extend({ build: z.string().trim().min(1) }).strict(), output: ack,
    may: (viewer, input) => assigned(viewer, input.job, ['starting', 'running', 'waiting']),
    run(ctx, input) {
      const result = dispatcher.started(runner(ctx.viewer), input.job, input.build);
      ctx.changed('job', input.job); ctx.changed('box', ctx.viewer.id); return result;
    },
  });
  operations.register({ name: 'runtime.heartbeat', write: true, recheckPolicy: true, doors: ['http'],
    input: jobInput.extend({ state: z.enum(['starting', 'running']) }).strict(),
    output: z.object({ active: z.boolean() }).strict(), may: (viewer, input) => assigned(viewer, input.job),
    // A cached active:true cannot restore authority after a terminal transition.
    validateReplay() { throw new OperationError('conflict', 'Report with a new operation id'); },
    run(ctx, input) {
      const result = dispatcher.heartbeat(runner(ctx.viewer), input.job, input.state);
      if(result.stopped)stopped.add(input);
      ctx.changed('job', input.job); ctx.changed('box', ctx.viewer.id); return {active:result.active};
    },
    after(input){if(stopped.delete(input))options.jobEnded(input.job);},
  });
  operations.register({ name: 'runtime.finish', write: true, recheckPolicy: true, doors: ['http'],
    input: jobInput.extend({ exitCode: z.number().int(), logTail: z.string().max(16_384) }).strict(), output: ack,
    may: (viewer, input) => assigned(viewer, input.job),
    inputHash(canonical, { input }) {
      const job = db.select({ conversation: jobs.conversation }).from(jobs).where(eq(jobs.id, input.job)).get();
      const conversation = job?.conversation ? db.select({ venue: conversations.venue, member: conversations.member }).from(conversations)
        .where(eq(conversations.id, job.conversation)).get() : undefined;
      // Private/dangling conversation output is discarded by Jobs.finish. Do
      // not retain even a guessable fingerprint of those words in a receipt.
      const privateOutput = job?.conversation !== null && job?.conversation !== undefined
        && !keepJobText(conversation);
      return createHash('sha256').update(privateOutput
        ? JSON.stringify({ job: input.job, exitCode: input.exitCode, logTail: '' }) : canonical).digest('hex');
    },
    run(ctx, input) {
      dispatcher.finish(runner(ctx.viewer), input.job, input.exitCode, input.logTail);
      ctx.changed('job', input.job); ctx.changed('box', ctx.viewer.id); return { ok: true as const };
    },
    after: input => options.jobEnded(input.job),
  });
}
