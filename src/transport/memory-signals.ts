/** Read-only Memory convergence for either composition root. The caller sends
 * committed source/operation changes here and owns closing this before data. */
import type {Clock} from '../core/clock.js';
export interface MemoryDeadlines {
 nextDeadline():number|undefined;
 observeDeadlines(changed:()=>void):()=>void;
}
export function installMemorySignals(clock:Clock,memory:MemoryDeadlines|undefined,changed:()=>void){
 let closed=false,stopTimer:(()=>void)|undefined,stopObserver:(()=>void)|undefined;
 const close=()=>{if(closed)return;closed=true;stopObserver?.();stopTimer?.();stopObserver=stopTimer=undefined;};
 const schedule=()=>{
  if(closed)return;
  stopTimer?.();stopTimer=undefined;
  const at=memory?.nextDeadline();
  if(at!==undefined)stopTimer=clock.at(at,()=>{
   stopTimer=undefined;if(closed)return;
   changed();schedule();
  });
 };
 try{stopObserver=memory?.observeDeadlines(schedule);schedule();}
 catch(error){close();throw error;}
 return {changed(){if(closed)return;changed();schedule();},rearm:schedule,close};
}
