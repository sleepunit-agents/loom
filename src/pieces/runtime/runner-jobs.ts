/** Metadata protocol only: claiming never dispatches a body or discloses inputs. */
import { z } from 'zod';
import { operation, OperationError, mayAct, type Db, type Operations, type Sharing, type Viewer } from '../../core/index.js';
import { canHost } from './boxes.js';
import { jobRecord, type RuntimeRecords } from './records.js';
import { runtimeStore } from './store.js';
import type { RuntimeCredentials } from './credentials.js';
const input = z.object({ job: z.string().min(1).max(200) }).strict();
const output = z.object({ job: z.string(), state: jobRecord.shape.state });
export function installRunnerJobs(db: Db, operations: Operations, sharing: () => Sharing, credentials?: RuntimeCredentials) {
  const store = runtimeStore(db);
  function assigned(viewer: Viewer, id: string): boolean {
    const job = store.read('job', id), box = job && store.read('box', job.box);
    return viewer.kind === 'runner' && !!job && !!box && box.id === viewer.id && box.revokedAt === undefined
      && mayAct(viewer, { ...job, type: 'runtime.job' }, sharing(), 'report-job');
  }
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
      return save(ctx, id, 'starting');
    },
  }));
  operations.register(operation({
    name: 'runtime.finishJob', write: true,
    input: input.extend({ state: z.enum(['done', 'failed']) }).strict(), output,
    may: (viewer, { job }) => assigned(viewer, job),
    run(ctx, { job: id, state }) {
      const { changedAt: _, ...job } = store.read('job', id)!;
      if (!['starting', 'running', 'waiting'].includes(job.state)) throw new OperationError('conflict', 'Job has not been claimed or has ended');
      if (!credentials) throw new OperationError('unavailable', 'Central credential revocation is not installed');
      const result = credentials.revokeJob(db, { job: id, now: ctx.now });
      if ((result as unknown) instanceof Promise) {
        // Reject async roles without leaving a later rejection unhandled.
        (result as unknown as Promise<unknown>).catch(() => {});
        throw new Error('Credential revocation must be synchronous');
      }
      ctx.changed('core.access', 'credentials');
      if (store.put('job', { ...job, state, endedAt: ctx.now }, ctx.now)) ctx.changed('runtime.job', id);
      return { job: id, state };
    },
  }));
  operations.register(operation({
    name: 'runtime.reportJob', write: true,
    input: input.extend({ state: z.enum(['running', 'waiting']) }).strict(), output,
    may: (viewer, { job }) => assigned(viewer, job),
    run(ctx, { job: id, state }) {
      const before = store.read('job', id)!;
      if (!['starting', 'running', 'waiting'].includes(before.state)) throw new OperationError('conflict', 'Job has not been claimed or has ended');
      return save(ctx, id, state);
    },
  }));
}
