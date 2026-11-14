import { assignedRunner } from './control.js';
/** Executable input release is asynchronous and outside the registry transaction. */
import { z } from 'zod';
import { operation, OperationError, type Db, type Operations, type Sharing, type Viewer } from '../../core/index.js';
import type { OutsideEffects } from '../../core/effects.js';
import { runtimeStore } from './store.js';
import { canHost } from './boxes.js';
import { configuredHouse, sameHouse } from './builds.js';
import { meets } from './placement.js';
import { buildIdentity } from './records.js';

export function installRunnerInput(db: Db, operations: Operations, sharing: () => Sharing, effects: OutsideEffects, body?: { issue(agent: string, job: string): string; valid(job: string): boolean }) {
  const store = runtimeStore(db);
  const assigned=(viewer:Viewer,id:string)=>{
    const job=store.read('job',id);
    return !!job&&(job.member===undefined||!!body?.valid(id))&&assignedRunner(store,viewer,id,sharing());
  };
  const snapshot = (viewer: Viewer, id: string) => {
    if (!assigned(viewer, id)) throw new OperationError('denied', 'Input unavailable');
    const job = store.read('job', id)!, box = store.read('box', job.box)!;
    if (job.state !== 'starting' || job.claimedAt === undefined) throw new OperationError('conflict', 'Job is not awaiting start');
    if (!canHost(box, job.agent, sharing()) || !sameHouse(job.made, configuredHouse(store.read('settings', job.agent))))
      throw new OperationError('denied', 'Execution configuration changed; reconcile this job');
    if (job.member !== undefined && !body?.valid(id)) throw new OperationError('denied', 'Private binding unavailable');
    const input = db.prepare('SELECT brief, needs FROM runtime_inputs WHERE job=?').get(id) as { brief: string; needs: string } | undefined;
    if (!input) throw new OperationError('conflict', 'Job has no input');
    const needs = z.array(z.string().min(1).max(200)).max(32).parse(JSON.parse(input.needs));
    if (!needs.every(need => meets([...box.facts, ...box.labels], need)))
      throw new OperationError('denied', 'Box capabilities changed; reconcile this job');
    // No login, secret, port, socket or agent credential is conferred by this payload.
      return { job: id, agent: job.agent, house: job.made!, brief: input.brief, needs,
        ...(job.model===undefined?{}:{model:job.model}),
        ...(job.conversation===undefined?{}:{conversation:job.conversation}) };
  };
  operations.register(operation({
    name: 'runtime.takeInput', doors: ['http', 'direct'],
    input: z.object({ job: z.string().min(1).max(200) }).strict(),
    output: z.object({ job: z.string(), agent: z.string(), house: buildIdentity, brief: z.string(), needs: z.array(z.string()), model:z.string().optional(), conversation:z.string().optional(), credential:z.string().optional() }),
    may: (viewer, input) => assigned(viewer, input.job),
    async prepare(input, { viewer }) {
      const value = snapshot(viewer, input.job);
      if (!effects.beforeOutside({ id: `runtime:input:${input.job}`, kind: 'body-start', title: 'Release claimed runtime input' }))
        throw new OperationError('conflict', 'Input is held or already released; reconcile before another start');
      // This consumes the one release before any words can reach the runner.
      // A lost response is uncertain, never an automatic second execution.
      effects.finish(`runtime:input:${input.job}`);
      return value;
    },
    run(ctx, input, prepared) {
      const current = snapshot(ctx.viewer, input.job);
      if (JSON.stringify(current) !== JSON.stringify(prepared)) throw new OperationError('conflict', 'Input changed during release');
      return {...current,...(body?.valid(input.job)?{conversation:store.read('job',input.job)!.conversation,credential:body.issue(current.agent,input.job)}:{})};
    },
  }));
}
