import { call } from '../../data';
import { frozen, idle, createMutationStore } from '../../data/mutation';
export const mutation=createMutationStore();

/** Both confirmed forms keep the shared uncertain request and reset only on submission. */
export function submitAccountChange(operation:string,input:unknown,reset:()=>void){
  if(frozen(mutation.getSnapshot().request?.getSnapshot()??idle))return;
  mutation.set(call(operation,input),operation);reset();
}
