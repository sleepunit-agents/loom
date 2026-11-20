import { parseProgramResult, type ProgramResult } from './runtime/house-program.js';
import type { Job } from './runtime/jobs.js';
import {keepJobText} from './runtime/job-text.js';
/** Worker operations on the shared connection. No body executes in this root. */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from './core/data/database.js';
import { jobs, conversations, changeReviewRounds, jobUsage } from './core/data/schema.js';
import { canonical as canonicalJson, OperationError, type Operations } from './core/operations/index.js';
import type { Viewer } from './policy.js';
import type { WorkRole } from './runtime/work-roles.js';
import { Dispatcher } from './runtime/dispatcher.js';
import { harnessCannotRun, harnesses } from './runtime/body-harnesses.js';
import type { ModelRole } from './runtime/placement.js';
import { liveWorker } from './shared-worker.js';
import { WORKER_EXIT_BY } from './runtime/job-exit.js';
import { SLOTS_MAX } from './runtime/worker-limits.js';
import { machineFacts } from './runtime/machine-facts.js';
import { workerAssignment } from './runtime/worker-http.js';
import { claimedJobStates } from './core/data/job-states.js';
import { LOG_TAIL_MAX } from './runtime/log-tail.js';

import { changeReviewStore } from './apps/change-reviews.js';
import { coldReviewReport, reviewOutcome } from './runtime/cold-review-report.js';

const jobInput = z.object({ job: z.string().min(1) });
const ack = z.object({ ok: z.literal(true) }).strict();
export function registerSharedRuntime(operations: Operations, db: DataDatabase, options: {
  now(): string; roles(): readonly ModelRole[]; workRoles?:readonly WorkRole[];
  runner(viewer: Viewer): Readonly<{ box: string }> | undefined;
  /** Called after the effect AND receipt commit, including successful replay. */
  jobEnded(id: string): void;
  applyProgram(job: Job, result: ProgramResult, changed: (table: string, id: string) => void): void;
}) {
  const dispatcher = new Dispatcher(db, options.now, options.roles, harnessCannotRun, options.workRoles, new Set(Object.keys(harnesses)));
  const reviewStore = changeReviewStore(db, options.now);
  const roundFor = (job: string) => db.select().from(changeReviewRounds).where(eq(changeReviewRounds.job, job)).get();
  const stopped=new WeakSet<object>();
  /** The jobs a poll ended as ones no harness can hold, by the poll's input: told of once the write is committed. */
  const unplaced=new WeakMap<object,string[]>();
  const machine = (viewer: Viewer) => !!liveWorker(db, viewer, options.runner(viewer));
  const assigned = (viewer: Viewer, id: string, states?: readonly string[]) => {
    if (!machine(viewer)) return false;
    const job = db.select({ box: jobs.box, state: jobs.state }).from(jobs).where(eq(jobs.id, id)).get();
    return job?.box === viewer.id && (!states || states.includes(job.state));
  };
  const runner = (viewer: Viewer) => {
    const box = liveWorker(db, viewer, options.runner(viewer));
    if (!box) throw new OperationError('denied', 'Worker required');
    return box;
  };
  operations.register({ name: 'runtime.health', write: true, recheckPolicy: true, doors: ['http'],
    input: z.object({ facts: machineFacts.optional(), slots: z.number().int().min(0).max(SLOTS_MAX).optional() }).strict(), output: ack, may: machine,
    validateReplay() { throw new OperationError('conflict', 'Report with a new operation id'); },
    run(ctx, input) {
      const box = runner(ctx.viewer);
      // Told at once only when the report changed more than the machine's last-seen time.
      if (dispatcher.machines.report(box, input.facts, input.slots ?? null).stampOnly) ctx.stampOnly?.();
      else ctx.changed('box', box);
      return { ok: true as const };
    },
  });
  operations.register({ name: 'runtime.next', write: true, recheckPolicy: true, doors: ['http'],
    input: z.object({ execution: z.enum(['container', 'host']).optional(), reviewResults:z.literal(true).optional(), coldReviews:z.literal(true).optional(), programs: z.literal(true).optional(), facts: machineFacts.optional(), slots: z.number().int().min(1).max(SLOTS_MAX).optional() }).strict(), output: workerAssignment.nullable(), may: machine,
    // The client never retries an uncertain claim. Replaying an old assignment
    // could launch work that is already terminal, so it never releases a body.
    validateReplay() { throw new OperationError('conflict', 'Poll with a new operation id'); },
    run(ctx, input) {
      // The machine credential authenticates a trusted worker. This protocol version
      // distinguishes old binaries that could run jobs directly on the host.
      if (input.execution !== 'container') throw new OperationError('denied',
        'This server gives jobs only to container workers. Update the worker and configure container.socket.');
      const ended: string[] = [], poll: { stampOnly?: boolean } = {};
      const box = runner(ctx.viewer), assignment = dispatcher.next(box, input.facts, ended, input.slots, input.programs, poll, input.reviewResults, input.coldReviews);
      // An idle worker asks about once a second. A poll that gave no work and moved only the machine's
      // last-seen time is not a change to tell every open window of.
      if (poll.stampOnly && !ended.length) ctx.stampOnly?.();
      else ctx.changed('box', box);
      if (assignment) ctx.changed('job', assignment.id);
      for (const id of ended) ctx.changed('job', id);
      if (ended.length) unplaced.set(input, ended);
      return assignment ?? null;
    },
    after(input) { const ended = unplaced.get(input); unplaced.delete(input); for (const id of ended ?? []) options.jobEnded(id); },
  });
  operations.register({ name: 'runtime.started', write: true, recheckPolicy: true, doors: ['http'],
    input: jobInput.extend({ build: z.string().trim().min(1) }).strict(), output: ack,
    may: (viewer, input) => assigned(viewer, input.job, claimedJobStates),
    validateReplay(viewer, input) {
      // A start acknowledgement can arrive after a long outage. Renew the
      // existing claim without starting another body or changing its build.
      if (!dispatcher.heartbeat(runner(viewer), input.job, 'running').active)
        throw new OperationError('denied', 'Job has ended');
    },
    run(ctx, input) {
      const result = dispatcher.started(runner(ctx.viewer), input.job, input.build);
      ctx.changed('job', input.job); ctx.changed('box', ctx.viewer.id); return result;
    },
  });
  operations.register({ name: 'runtime.heartbeat', write: true, recheckPolicy: true, doors: ['http'],
    input: jobInput.extend({ state: z.enum(claimedJobStates) }).strict(),
    output: z.object({ active: z.boolean() }).strict(), may: (viewer, input) => assigned(viewer, input.job),
    // A cached active:true cannot restore authority after a terminal transition.
    validateReplay() { throw new OperationError('conflict', 'Report with a new operation id'); },
    run(ctx, input) {
      const report:{stampOnly?:boolean}={};
      const result = dispatcher.heartbeat(runner(ctx.viewer), input.job, input.state, report);
      if(result.stopped)stopped.add(input);
      if(report.stampOnly)ctx.stampOnly?.();
      else {ctx.changed('job', input.job);ctx.changed('box', ctx.viewer.id);}
      return {active:result.active};
    },
    after(input){if(stopped.delete(input))options.jobEnded(input.job);},
  });
  operations.register({ name: 'runtime.finish', write: true, recheckPolicy: true, doors: ['http'],
    // exitBy: whose code it is, as the worker says. A worker from before it was asked leaves it out, and the row then says nobody's.
    input: jobInput.extend({ exitCode: z.number().int(), logTail: z.string().max(LOG_TAIL_MAX), exitBy: z.enum(WORKER_EXIT_BY).optional(), programResult: z.json().optional(), coldReview: coldReviewReport.optional() }).strict(), output: ack,
    may: (viewer, input) => assigned(viewer, input.job),
    inputHash(canonical, { input }) {
      if (input.coldReview || roundFor(input.job)) {
        // The findings belong only to the protected round. Check their stored value on replay.
        const report = input.coldReview;
        const evidence = report && [report.change, report.headCommit, report.before, report.after];
        const usage = report?.usage && canonicalJson(report.usage);
        return createHash('sha256').update(JSON.stringify({ job: input.job, exit: input.exitCode, by: input.exitBy, evidence, usage })).digest('hex');
      }
      const job = db.select({ conversation: jobs.conversation }).from(jobs).where(eq(jobs.id, input.job)).get();
      const conversation = job?.conversation ? db.select({ venue: conversations.venue, member: conversations.member, direct: conversations.direct }).from(conversations)
        .where(eq(conversations.id, job.conversation)).get() : undefined;
      // Private/dangling conversation output is discarded by Jobs.finish. Do
      // not retain even a guessable fingerprint of those words in a receipt.
      const privateOutput = job?.conversation !== null && job?.conversation !== undefined
        && !keepJobText(conversation);
      return createHash('sha256').update(privateOutput
        ? JSON.stringify({ job: input.job, exitCode: input.exitCode, logTail: '', exitBy: input.exitBy ?? null }) : canonical).digest('hex');
    },
    validateReplay(_viewer, input) {
      if (!input.coldReview) {
        if (input.programResult !== undefined && roundFor(input.job)) throw new OperationError('invalid', 'Incompatible job result');
        return;
      }
      const round = roundFor(input.job), result = reviewOutcome(input.exitCode, input.coldReview, input.exitBy);
      if (input.programResult !== undefined || !round || round.verdict !== result.verdict || round.findings !== result.findings)
        throw new OperationError('conflict', 'Review report differs from the filed result');
    },
    run(ctx, input) {
      const box = runner(ctx.viewer), job = dispatcher.jobs.get(input.job);
      let exitCode = input.exitCode;
      const round = roundFor(input.job);
      if (input.coldReview && (!round || job.state !== 'running' || input.coldReview.change !== round.change ||
          input.coldReview.headCommit !== round.headCommit))
        throw new OperationError('invalid', 'Report does not match a running review assignment');
      if (round) {
        if (job.startedByKind === 'program' || input.programResult !== undefined) throw new OperationError('invalid', 'Incompatible job result');
        const result = reviewOutcome(exitCode, input.coldReview, input.exitBy);
        if (result.verdict === 'NONE' && exitCode === 0) exitCode = 1;
        const usage = input.coldReview?.usage;
        if (usage) db.insert(jobUsage).values({ ...usage, job: job.id, harness: usage.harness ?? job.harness,
          model: usage.model ?? job.model }).run();
        reviewStore.finish({ job: input.job, change: round.change, headCommit: round.headCommit, ...result });
        ctx.changed('change', round.change);
      } else if (job.startedByKind === 'program') {
        if (job.state === 'running' && exitCode === 0) {
          let result: ProgramResult | undefined;
          try { result = parseProgramResult(JSON.stringify(input.programResult) ?? ''); }
          catch { exitCode = 1; }
          if (result) {
            const changes: [string, string][] = [];
            try {
              const valid = result;
              db.transaction(() => options.applyProgram(job, valid, (type, id) => changes.push([type, id])));
              for (const [type, id] of changes) ctx.changed(type, id);
            } catch (error) {
              // An inadmissible result is final. Storage failures leave the receipt open for retry.
              if (!(error instanceof OperationError)) throw error;
              exitCode = 1;
            }
          }
        }
      } else if (input.programResult !== undefined) throw new OperationError('invalid', 'Program result requires a program job');
      dispatcher.finish(box, input.job, exitCode, round || job.startedByKind === 'program' ? '' : input.logTail, input.exitBy);
      ctx.changed('job', input.job); ctx.changed('box', ctx.viewer.id); return { ok: true as const };
    },
    after: input => options.jobEnded(input.job),
  });
  return dispatcher;
}
