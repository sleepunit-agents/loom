/** Ports installed only by the exclusive fictitious example-home command. */
import type {SharedStartupFactory} from './shared-startup.js';
import {taskService} from './apps/tasks.js';
import {exampleModelRoles} from './example-runtime.js';
const exampleAdapters:SharedStartupFactory=({db,clock})=>{
 const tasks=taskService(db,()=>new Date(clock.now()).toISOString());
 return {
  modelRoles:()=>exampleModelRoles,
  approvedOperations:new Map([['example.discardDraft',card=>{
   const id=/^example:discard-draft:(t-[1-9][0-9]*)$/.exec(card.target)?.[1];
   if(card.kind!=='dangerous'||!id||card.changeSummary!==`Draft ${id}: open → cancelled`||tasks.get(id).status!=='open')throw Error('Example draft changed; request a fresh card');
   tasks.close(id,'cancelled');
  }]]),
 };
};
export default exampleAdapters;
