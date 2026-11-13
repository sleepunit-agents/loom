/** Durable requests only. No executable work is released by this operation. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { operation, mayAct, mayCreate, type Db, type Operations, type Sharing } from '../../core/index.js';
import { placeBody } from './placement.js';
import { runtimeStore } from './store.js';
const id = z.string().min(1).max(200);
export function installQueueBody(db: Db, operations: Operations, sharing: () => Sharing) {
  const store = runtimeStore(db);
  operations.register(operation({
    name: 'runtime.queueBody', write: true,
    input: z.object({ agent: id, project: id.optional(), member: id.optional(), title: z.string().min(1).max(200),
      brief: z.string().min(1).max(100_000), box: id.optional(), needs: z.array(id).max(32).optional() }).strict(),
    output: z.object({ job: id, state: z.literal('queued') }),
    may(viewer, input) {
      const scope = { type: 'runtime.job', agent: input.agent, project: input.project, member: input.member };
      const held = sharing();
      return mayAct(viewer, scope, held, 'give-work') && mayCreate(viewer, scope, held, 'runtime.queueBody');
    },
    run(ctx, input) {
      const box = placeBody(store, sharing(), input.agent, input, ctx.now), job = randomUUID();
      store.put('job', { id: job, agent: input.agent, ...(input.project === undefined ? {} : { project: input.project }),
        ...(input.member === undefined ? {} : { member: input.member }), title: input.title, runner: box, box,
        state: 'queued', createdAt: ctx.now }, ctx.now);
      db.prepare('INSERT INTO runtime_inputs (job, brief, needs) VALUES (?, ?, ?)').run(job, input.brief, JSON.stringify(input.needs ?? []));
      ctx.changed('runtime.job', job);
      return { job, state: 'queued' as const };
    },
  }));
}
