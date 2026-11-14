import { call, type Call } from '../../data';
import { frozen, idle, createMutationStore } from '../../data/mutation';
export const mutation=createMutationStore();
interface AccountChange { notificationTest:{ref:string} }
const details=new WeakMap<Call,AccountChange>();
export const accountChange=(request?:Call)=>request?details.get(request):undefined;

/** Confirmed forms and test actions keep the shared uncertain request and its metadata. */
export function submitAccountChange(operation:string,input:unknown,reset:()=>void,detail?:AccountChange){
  if(frozen(mutation.getSnapshot().request?.getSnapshot()??idle))return;
  const request=call(operation,input);
  if(detail)details.set(request,detail);
  mutation.set(request,operation);reset();
}
