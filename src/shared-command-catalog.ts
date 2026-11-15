/** Code-defined command schemas for a current body; no record projection or grant. */
import { z } from 'zod';
import type { Viewer } from './policy.js';
import { OperationError, type Operations } from './core/operations/index.js';
export function registerSharedCommandCatalog(operations:Operations,current:(viewer:Viewer)=>boolean){
 operations.register({name:'runtime.commandCatalog',write:false,doors:['http'],
  input:z.object({name:z.string().min(1).optional()}).strict(),
  output:z.object({commands:z.array(z.object({name:z.string(),write:z.boolean(),inputSchema:z.json().optional()}).strict())}).strict(),
  may:viewer=>current(viewer),
  run(_ctx,input){
   const offered=operations.offered('http').sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
   if(input.name){
    const command=offered.find(command=>command.name===input.name);
    if(!command)throw new OperationError('not-found','Command not available');
    // Input transforms and refinements remain enforced by the canonical call.
    // This is a structural hint for native tools, never a permission promise.
    return {commands:[{name:command.name,write:command.write,inputSchema:z.toJSONSchema(command.input,{io:'input',unrepresentable:'any'})}]};
   }
   return {commands:offered.map(command=>({name:command.name,write:command.write}))};
  },
 });
}
