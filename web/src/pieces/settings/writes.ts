import { call, type Call, type CallState } from '../../data';
const idle:CallState={pending:false,status:'done'};
/** Window-only mutation state outlives readers, navigation and feed reconnects.
 * Retain only the shared call, never a second copy of its credential input. */
export function createSettingsWrites(dispatch:typeof call=call) {
  let request:Call|undefined,unsubscribe:(()=>void)|undefined;
  const listeners=new Set<()=>void>(),emit=()=>listeners.forEach(fn=>fn());
  const snapshot=()=>request?.getSnapshot()??idle;
  const blocked=()=>{const s=snapshot();return s.pending||(s.result?.ok===false&&s.result.code==='unavailable');};
  return {snapshot,blocked,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};},
    send(name:string,input:unknown){if(blocked())return;unsubscribe?.();request=dispatch(name,input);unsubscribe=request.subscribe(emit);emit();},
    retry(){request?.retry?.();},
    // Explicit disposal is for the owning window/test teardown, never navigation.
    dispose(){unsubscribe?.();request=undefined;emit();},
  };
}
export const settingsWrites=createSettingsWrites();
