import { assignedRunner } from './control.js';
/** Metadata protocol only: claiming never dispatches a body or discloses inputs. */
import { z } from 'zod';
import { operation, OperationError, type Db, type Operations, type Sharing, type Viewer } from '../../core/index.js';
import { canHost } from './boxes.js';
import { jobRecord, type RuntimeRecords } from './records.js';
import { runtimeStore } from './store.js';
import type { RuntimeCredentials } from './credentials.js';
import { buildTag, configuredHouse } from './builds.js';
import { jobResults, resultFields } from './results.js';
const input = z.object({ job: z.string().min(1).max(200) }).strict();
const output = z.object({ job: z.string(), state: jobRecord.shape.state });
export function installRunnerJobs(db: Db, operations: Operations, sharing: () => Sharing, credentials?: RuntimeCredentials) {
  const store = runtimeStore(db), results = jobResults(db);
  const assigned=(viewer:Viewer,id:string)=>assignedRunner(store,viewer,id,sharing());
  function save(ctx: { now: number; changed(type: string, id: string): void }, id: string, state: RuntimeRecords['job']['state']) {
    const { changedAt: _, ...job } = store.read('job', id)!;
    if (store.put('job', { ...job, state }, ctx.now)) ctx.changed('runtime.job', id);
    return { job: id, state };
  }
  operations.register(operation({
    name: 'runtime.claimJob', write: true, input, output,
    may: (viewer, { job }) => assigned(viewer, job),
    run(ctx, { job: id }) {
      const job = store.read('job', id)!, box = store.read('box', job.box)!;
      if (!canHost(box, job.agent, sharing())) throw new OperationError('denied', 'Box may not host this agent');
      if (job.state !== 'queued') throw new OperationError('conflict', 'Job is not queued');
      const made = configuredHouse(store.read('settings', job.agent));
      if (!made) throw new OperationError('conflict', 'Agent has no house configuration');
      const { changedAt: _, build: _build, buildAt: _buildAt, ...before } = job;
      if (store.put('job', { ...before, state: 'starting', made, claimedAt: ctx.now }, ctx.now)) ctx.changed('runtime.job', id);
      return { job: id, state: 'starting' as const };
    },
  }));
  operations.register(operation({
    name: 'runtime.finishJob', write: true,
    input: input.extend({ state: z.enum(['done', 'failed']), ...resultFields }).strict(), output,
    may: (viewer, { job }) => assigned(viewer, job),
    run(ctx, { job: id, state, exit, log }) {
      const { changedAt: _, ...job } = store.read('job', id)!;
      if (!['starting', 'running', 'waiting'].includes(job.state)) throw new OperationError('conflict', 'Job has not been claimed or has ended');
      if (!credentials) throw new OperationError('unavailable', 'Central credential revocation is not installed');
      const result = credentials.revokeJob(db, { job: id, now: ctx.now });
      if ((result as unknown) instanceof Promise) {
        // Reject async roles without leaving a later rejection unhandled.
        (result as unknown as Promise<unknown>).catch(() => {});
        throw new Error('Credential revocation must be synchronous');
      }
      results.put(id, { exit, log });
      ctx.changed('core.access', 'credentials');
      if (store.put('job', { ...job, state, endedAt: ctx.now }, ctx.now)) ctx.changed('runtime.job', id);
      return { job: id, state };
    },
  }));
  operations.register(operation({
    name: 'runtime.reportJob', write: true,
    input: input.extend({ state: z.enum(['running', 'waiting']), build: z.string().max(120).optional(), ...resultFields }).strict(), output,
    may: (viewer, { job }) => assigned(viewer, job),
    run(ctx, { job: id, state, build, exit, log }) {
      const before = store.read('job', id)!;
      if (!['starting', 'running', 'waiting'].includes(before.state)) throw new OperationError('conflict', 'Job has not been claimed or has ended');
      // Result and metadata writes share the operation's transaction/receipt.
      // Notify only the job id; log words are never in the live payload.
      if (results.put(id, { exit, log })) ctx.changed('runtime.job', id);
      if (build !== undefined) {
        const tag = buildTag(build, before.agent);
        if (state !== 'running' || !tag) throw new OperationError('invalid', 'Build must name this agent image in a running report');
        if (!before.made || before.claimedAt === undefined) throw new OperationError('conflict', 'Job has no claimed house identity');
        if (before.build && before.build !== tag) throw new OperationError('conflict', 'Job already reported another image');
        const { changedAt: _, ...job } = before;
        // Repeated reports and later progress must not make an old image newer.
        // Historical images without a report time remain undated until rebuilt.
        if (store.put('job', { ...job, state, build: tag, ...(!before.build ? { buildAt: ctx.now } : {}) }, ctx.now)) ctx.changed('runtime.job', id);
        return { job: id, state };
      }
      return save(ctx, id, state);
    },
  }));
}
