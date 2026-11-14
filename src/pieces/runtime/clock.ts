/** Clock waits for the assigned runner's confirmation, outside any transaction. */
import type { Foundation } from '../../core/app.js';
import type { OutsideEffects } from '../../core/effects.js';
import type { Runtime, StartResult } from '../clock/role.js';
import { runtimeRole } from './role.js';
import { runtimeStore } from './store.js';
import { configuredHouse } from './builds.js';
import { startJobId } from './start.js';
import { clockRoute, type ClockDestinationReader } from '../clock/role.js';
export const START_CONFIRM_MS = 60_000;
export function clockRuntime(app: Foundation, effects: Pick<OutsideEffects,'status'>, destination?: ClockDestinationReader): Runtime {
  const store=runtimeStore(app.db), waiting=new Set<(result:StartResult)=>void>();
  let closed=false;
  app.onClose(()=>{closed=true;for(const finish of [...waiting]) finish({state:'uncertain',reason:'Runtime closed before start confirmation'});});
  return {async startBody({wake,viewer}) {
    if(closed) return {state:'uncertain',reason:'Runtime is closed'};
    const existing=()=>store.read('job',startJobId(viewer,wake.agent,{kind:'wake',id:wake.id}));
    const hold=(reason:string):StartResult=>({state:existing()?'uncertain':'held',reason});
    // A matching, current Runtime destination is necessary for lane reuse. The
    // startBody path cannot feed an existing conversation; never silently turn a
    // verified join into a second body or forward arbitrary caller places.
    const route=clockRoute(wake,destination);
    if(route.kind==='join') return hold('This wake needs conversation delivery; starting another body is unsafe');
    if(!configuredHouse(store.read('settings',wake.agent))) return hold('An owner must configure the agent house before dispatch');
    // These old runner features require their own trusted inputs; never pretend
    // a path is a prompt or confer approval/continuation authority from text.
    if(!wake.prompt || wake.file || wake.laneVersion || wake.continuation || wake.slot || wake.approval || wake.prompt.includes('<!-- house: local -->'))
      return hold('This wake requires a runtime feature that is not installed');
    const answer=runtimeRole(app.operations).startBody(viewer,{
      agent:wake.agent,project:wake.project,member:wake.member,title:'Scheduled work',brief:wake.prompt,
      model:wake.model,source:{kind:'wake',id:wake.id},
    },`runtime:wake:${wake.id}`);
    if(!answer.ok) return existing()
      ? {state:'uncertain',reason:'This wake already has an accepted start intent; reconcile it before retrying'}
      : {state:'not-started',reason:answer.message};
    const {job}=answer.value as {job:string};
    return new Promise<StartResult>(resolve=>{
      let settled=false;
      let unobserve=()=>{}, cancel=()=>{};
      const finish=(result:StartResult)=>{if(settled)return;settled=true;unobserve();cancel();waiting.delete(finish);resolve(result);};
      const check=()=>{
        const current=store.read('job',job);
        if(current?.state==='running' || current?.state==='waiting') finish({state:'started',body:job});
        // A terminal report may arrive before this waiter sees running. Without
        // persisted start confirmation it is unsafe to infer a definite failure.
        else if(!current || !['queued','starting'].includes(current.state)) finish({state:'uncertain',reason:'Runner ended without an observed start confirmation'});
      };
      waiting.add(finish);
      unobserve=app.live.observe(changes=>{if(changes.some(c=>c.type==='runtime.job'&&c.id===job))check();});
      cancel=app.operations.clock.at(app.operations.clock.now()+START_CONFIRM_MS,()=>{
        finish(effects.status(`runtime:input:${job}`)==='due'?{state:'held',reason:'Staging holds the runner input'}:{state:'uncertain',reason:'Runner has not confirmed whether this body started'});
      });
      check();
    });
  }};
}
