/** Durable requests only. No executable work is released by this operation. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { operation, mayAct, mayCreate, type Db, type Operations, type Sharing, type Context } from '../../core/index.js';
import { placeBody } from './placement.js';
import { runtimeStore } from './store.js';
import type { RuntimeRecords } from './records.js';
const id = z.string().min(1).max(200);
/** Caller has authorized the request and owns the operation transaction. */
export function enqueueBody(ctx: Context, sharing: Sharing,
  record: Omit<RuntimeRecords['job'],'box'|'runner'|'state'|'createdAt'>,
  input: {brief:string;box?:string;needs?:string[]}) {
  const store=runtimeStore(ctx.db),box=placeBody(store,sharing,record.agent,input,ctx.now);
  store.put('job',{...record,box,runner:box,state:'queued',createdAt:ctx.now},ctx.now);
  ctx.db.prepare('INSERT INTO runtime_inputs (job,brief,needs) VALUES (?,?,?)').run(record.id,input.brief,JSON.stringify(input.needs??[]));
  ctx.changed('runtime.job',record.id);
  return {job:record.id,state:'queued' as const};
}
export function installQueueBody(db: Db, operations: Operations, sharing: () => Sharing) {
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
      return enqueueBody(ctx,sharing(),{id:randomUUID(),agent:input.agent,project:input.project,member:input.member,title:input.title},input);
    },
  }));
}
