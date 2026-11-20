/** Machine registry metadata; credentials are issued only by canonical Sign-in. */
import {randomUUID} from 'node:crypto';
import {and,eq,isNull} from 'drizzle-orm';
import {z} from 'zod';
import {mayAct,mayCreate,type Viewer} from './policy.js';
import {sharedSharing} from './shared-sharing.js';
import type {DataDatabase} from './core/data/database.js';
import {boxes} from './core/data/schema.js';
import {OperationError,type Operations} from './core/operations/index.js';
import {machineName} from './core/line-name.js';
export function registerMachineRegistry(operations:Operations,db:DataDatabase,options:{now():string;changed():void}){
 const fresh=new WeakSet<object>();
 const after=(input:object)=>{if(fresh.delete(input))options.changed();};
 operations.register({name:'runtime.boxCreate',write:true,recheckPolicy:true,doors:['http'],
  input:z.object({name:machineName,sameMachineAsLoom:z.boolean()}).strict(),
  output:z.object({id:z.string()}).strict(),
  may:viewer=>viewer.kind==='member'&&mayCreate(viewer,{type:'runtime.box',member:viewer.id},sharedSharing(db)),
  run(ctx,input){
   if(db.select({id:boxes.id}).from(boxes).where(and(eq(boxes.name,input.name),isNull(boxes.revokedAt))).get())throw new OperationError('conflict','Machine name is already in use');
   const id='box-'+randomUUID();db.insert(boxes).values({id,name:input.name,owner:ctx.viewer.id,sameMachineAsLoom:input.sameMachineAsLoom,hostsAny:false,reportOnly:true,alwaysOn:false,enrolledAt:options.now()}).run();
   fresh.add(input);ctx.changed('boxes',id);return{id};
  },after(input){after(input);},
 });
}
