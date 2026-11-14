/** Worker-side Claude control consumer. Never import into the daemon. */
import { ClaudeWorkerSession, type SpawnClaude, type WorkerTurn, type TurnResult } from './session.js';
import {connectWorkerControl,type WorkerControlConfig,type WorkerControlRuntime} from './control.js';
export type {WorkerControlConfig,WorkerControlRuntime} from './control.js';
const failed=()=>new Error('Runtime worker authority unavailable');
/** One connection, job and native session owner. No process adoption or caller
 * resume id. A new connection always starts a fresh native session. */
export async function connectClaudeWorker(config:WorkerControlConfig,
  launch:{command:string;env:NodeJS.ProcessEnv;spawn?:SpawnClaude},runtime?:WorkerControlRuntime) {
  const session=new ClaudeWorkerSession(launch.command,{...launch.env},launch.spawn);
  const control=await connectWorkerControl(config,()=>session.close(),runtime);
  return Object.freeze({
    async turn(input:WorkerTurn):Promise<TurnResult> {
      const current=input.current,turn={...input,binding:{...input.binding},rules:structuredClone(input.rules)};
      await control.fresh();
      const result=await session.turn({...turn,current:()=>control.current()&&current()===true});
      await control.fresh();
      let valid=false;try {valid=current()===true;}catch { /* failed local proof revokes */ }
      if(!control.current()||!valid){control.close();throw failed();}
      return result;
    },
    refresh:control.refresh,close:control.close,
  });
}
