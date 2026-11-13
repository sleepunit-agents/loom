/** A start intent is durable work, never evidence that the runner started it. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { operation, OperationError, mayAct, mayCreate, type Db, type Operations, type Sharing, type Viewer } from '../../core/index.js';
import { runtimeStore } from './store.js';
import { enqueueBody } from './queue.js';
import { configuredHouse } from './builds.js';
const id = z.string().min(1).max(200);
export const startInput = z.object({
  agent: id, project: id.optional(), member: id.optional(), title: z.string().min(1).max(200),
  brief: z.string().min(1).max(100_000), box: id.optional(), model: id.optional(), account: id.optional(),
  conversation: id.optional(), source: z.object({kind:z.enum(['wake','spawn','conversation','manual']),id}).strict().optional(),
}).strict();
export function startJobId(viewer: Viewer, agent: string, source: {kind:string;id:string}): string {
  return 'start-'+createHash('sha256').update(JSON.stringify([viewer.kind,viewer.id,agent,source])).digest('hex').slice(0,40);
}
export function installStartBody(db: Db, operations: Operations, sharing: () => Sharing) {
  const store = runtimeStore(db);
  operations.register(operation({name:'runtime.startBody',write:true,input:startInput,
    output:z.object({job:id,state:z.string()}),
    may(viewer,input) {
      const scope={type:'runtime.job',agent:input.agent,project:input.project,member:input.member};
      const access=sharing();
      // Same creation rule as Clock: members must own the target, agents need
      // independently visible agent/project scope, services need central grants.
      return mayCreate(viewer,scope,access,'runtime.startBody')
        && (viewer.kind!=='member' || mayAct(viewer,scope,access,'give-work'));
    },
    run(ctx,input) {
      if(input.account!==undefined) throw new OperationError('unavailable','Model account selection is not installed');
      if(input.member!==undefined) throw new OperationError('unavailable','Private body delivery is not installed');
      // Stable beyond registry receipt expiry and scoped to the actual caller.
      const job=startJobId(ctx.viewer,input.agent,input.source ?? {kind:'manual',id:ctx.receipt!.id});
      const old=store.read('job',job);
      if(old) {
        const words=db.prepare('SELECT brief FROM runtime_inputs WHERE job=?').get(job) as {brief:string}|undefined;
        if(words?.brief!==input.brief || old.title!==input.title || old.project!==input.project || old.member!==input.member
          || old.conversation!==input.conversation || old.model!==input.model || old.account!==input.account
          || old.startRequest===undefined || old.startRequest.box!==input.box)
          throw new OperationError('conflict','Start source already has different work');
        return {job,state:old.state};
      }
      if(!configuredHouse(store.read('settings',input.agent))) throw new OperationError('conflict','Agent has no house configuration');
      return enqueueBody(ctx,sharing(),{id:job,agent:input.agent,project:input.project,member:input.member,title:input.title,
        conversation:input.conversation,model:input.model,account:input.account,startRequest:{box:input.box}},input);
    },
  }));
}
