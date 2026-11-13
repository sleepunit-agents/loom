/** Only an assigned runner's durable not-started fence permits another attempt.
 * The original accepted caller is retained as intent, not as a credential.
 * Every retry rechecks central creation policy and the exact house configuration.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { operation, mayAct, mayCreate, OperationError, type Context, type Db, type Sharing } from '../../core/index.js';
import type { Foundation } from '../../core/app.js';
import { startInput } from './start.js';
import { runtimeStore } from './store.js';
import { enqueueBody } from './queue.js';
import { configuredHouse, sameHouse } from './builds.js';
const delays = [60_000, 240_000, 600_000] as const;
const caller = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('member'),id:z.string()}),
  z.object({kind:z.literal('agent'),id:z.string()}),
]);
const attempt = z.object({current:z.string(),count:z.number().int().min(0).max(delays.length),
  state:z.enum(['active','due','held','exhausted','settled']),due:z.number().int().optional(),
  by:caller,input:z.unknown()}).strict();
type Attempt = z.infer<typeof attempt>;
function read(db:Db,root:string):Attempt|undefined {
  const row=db.prepare('SELECT record FROM runtime_start_attempts WHERE root=?').get(root) as {record:string}|undefined;
  return row?attempt.parse(JSON.parse(row.record)):undefined;
}
function put(db:Db,root:string,record:Attempt) {
  if(!db.inTransaction)throw Error('Start attempts require the caller transaction');
  db.prepare('INSERT INTO runtime_start_attempts VALUES (?,?) ON CONFLICT(root) DO UPDATE SET record=excluded.record').run(root,JSON.stringify(attempt.parse(record)));
}
export function rememberStart(ctx:Context,root:string,input:z.infer<typeof startInput>) {
  // Conversation/Clock sources have owning generation, notices and bindings.
  // Those mechanisms must adopt retries explicitly; never bypass them here.
  if(input.member!==undefined||input.conversation!==undefined||input.source?.kind==='wake'||input.source?.kind==='conversation'
    ||!['member','agent'].includes(ctx.viewer.kind))return;
  put(ctx.db,root,{current:root,count:0,state:'active',by:ctx.viewer as Attempt['by'],input});
}
export function finishStartAttempt(ctx:Context,job:string,notStarted:boolean) {
  for(const {root} of ctx.db.prepare('SELECT root FROM runtime_start_attempts').all() as {root:string}[]) {
    const row=read(ctx.db,root)!;if(row.current!==job||row.state!=='active')continue;
    const delay=delays[row.count];
    put(ctx.db,root,{...row,...(notStarted&&delay!==undefined?{state:'due',due:ctx.now+delay}:{state:notStarted?'exhausted':'settled',due:undefined})});
    ctx.changed('runtime.job',root);
  }
}
/** A restart schedules durable deadlines. No timeout is interpreted as a fence. */
export function installStartRetries(app:Foundation,sharing:()=>Sharing) {
  const {db,operations,live}=app,store=runtimeStore(db),clock=operations.clock;
  let backoffUntil=0;
  let closed=false,cancel:(()=>void)|undefined;
  operations.register(operation({name:'runtime.startProgress',input:z.object({job:z.string().min(1).max(200)}).strict(),
    output:z.object({job:z.string(),current:z.string(),attempt:z.number(),state:z.string(),due:z.number().optional()}),
    may:(v,{job})=>{const record=store.read('job',job);return !!record&&mayAct(v,{...record,type:'runtime.job'},sharing(),'act','runtime.startProgress');},
    run(_ctx,{job}){const row=read(db,job);if(!row)throw new OperationError('not-found','No automatic start attempts');return {job,current:row.current,attempt:row.count+1,state:row.state,...(row.due===undefined?{}:{due:row.due})};},
  }));
  function tick() {
    if(closed)return;
    const changes:Array<{type:string;id:string}>=[];
    try { db.transaction(()=>{
      for(const {root} of db.prepare('SELECT root FROM runtime_start_attempts').all() as {root:string}[]) {
        const row=read(db,root)!;if(row.state!=='due'||row.due===undefined||row.due>clock.now())continue;
        const previous=store.read('job',row.current),original=store.read('job',root),input=startInput.parse(row.input);
        const scope={type:'runtime.job',agent:input.agent,project:input.project};
        const access=sharing(),house=configuredHouse(store.read('settings',input.agent));
        // Revalidate the entire original intent: administration never authorizes
        // execution, and no imported/unknown/private/service work is eligible.
        if(!previous||!original||previous.state!=='failed'||!previous.startFailed||previous.imported||previous.writtenOff||previous.principalReset
          ||previous.member!==undefined||previous.service!==undefined||previous.conversation!==undefined
          ||input.member!==undefined||input.conversation!==undefined||!house||!sameHouse(previous.made,house)
          ||!mayCreate(row.by,scope,access,'runtime.startBody')||(row.by.kind==='member'&&!mayAct(row.by,scope,access,'give-work'))) {
          put(db,root,{...row,state:'held',due:undefined});changes.push({type:'runtime.job',id:root});continue;
        }
        const job='retry-'+createHash('sha256').update(JSON.stringify([root,row.count+1])).digest('hex').slice(0,40);
        if(store.read('job',job))throw Error('Retry job already exists without its owning attempt');
        const ctx:Context={db,viewer:row.by,now:clock.now(),changed:(type,id)=>changes.push({type,id})};
        try {
          // Selection rechecks current ownership, host policy, facts and lending.
          enqueueBody(ctx,access,{id:job,agent:input.agent,project:input.project,title:input.title,model:input.model,account:input.account,startRequest:{box:input.box}},input);
        } catch(error) {
          if(!(error instanceof OperationError))throw error;
          put(db,root,{...row,state:'held',due:undefined});changes.push({type:'runtime.job',id:root});continue;
        }
        put(db,root,{...row,current:job,count:row.count+1,state:'active',due:undefined});changes.push({type:'runtime.job',id:root});
      }
    })();backoffUntil=0;live.changed(changes); }
    catch { backoffUntil=clock.now()+5000; /* No partial attempt survives. Back off local storage failures. */ }
    schedule();
  }
  function schedule() {
    cancel?.();cancel=undefined;if(closed)return;
    let due:number|undefined;
    for(const {root} of db.prepare('SELECT root FROM runtime_start_attempts').all() as {root:string}[]) {
      const row=read(db,root)!;if(row.state==='due'&&row.due!==undefined)due=Math.min(due??Infinity,Math.max(backoffUntil,clock.now()+1,row.due));
    }
    if(due!==undefined)cancel=clock.at(due,()=>{cancel=undefined;tick();});
  }
  const unobserve=live.observe(changes=>{if(!closed&&changes.some(c=>c.type==='runtime.job'))schedule();});
  schedule();
  app.onClose(()=>{closed=true;cancel?.();unobserve();});
}
