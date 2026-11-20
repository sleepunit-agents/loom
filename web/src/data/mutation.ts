import type { Call, CallState } from './store';
export const idle:CallState={pending:false,status:'done'};
export function frozen(state:CallState):boolean{return state.pending||state.result?.ok===false&&state.result.code==='unavailable';}
/** An app's window-lifetime request survives navigation so uncertain writes keep their id. */
export function createMutationStore(){
  let current:{request?:Call;label?:string}={};const listeners=new Set<()=>void>();
  return {getSnapshot:()=>current,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};},set(request:Call,label:string){current={request,label};listeners.forEach(fn=>fn());}};
}
