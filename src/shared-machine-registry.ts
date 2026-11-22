/** Machine registry metadata; credentials are issued only by canonical Sign-in. */
import {randomUUID} from 'node:crypto';
import {and,eq,isNull} from 'drizzle-orm';
import {z} from 'zod';
import {mayCreate} from './policy.js';
import {sharedSharing} from './shared-sharing.js';
import type {DataDatabase} from './core/data/database.js';
import {boxes} from './core/data/schema.js';
import {OperationError,type Operations} from './core/operations/index.js';
import {machineName} from './core/line-name.js';
export function createReportOnlyMachine(db:DataDatabase,name:string,owner:string,sameMachineAsLoom:boolean,enrolledAt:string){
   if(db.select({id:boxes.id}).from(boxes).where(and(eq(boxes.name,name),isNull(boxes.revokedAt))).get())throw new OperationError('conflict','Machine name is already in use');
   const id='box-'+randomUUID();
   db.insert(boxes).values({id,name,owner,sameMachineAsLoom,hostsAny:false,reportOnly:true,alwaysOn:false,enrolledAt}).run();
   return id;
}
export function registerMachineRegistry(operations:Operations,db:DataDatabase,options:{now():string;changed():void}){
 const fresh=new WeakSet<object>();
 const after=(input:object)=>{if(fresh.delete(input))options.changed();};
 operations.register({name:'runtime.boxCreate',write:true,recheckPolicy:true,doors:['http'],
  input:z.object({name:machineName,sameMachineAsLoom:z.boolean()}).strict(),
  output:z.object({id:z.string()}).strict(),
  may:viewer=>viewer.kind==='member'&&mayCreate(viewer,{type:'runtime.box',member:viewer.id},sharedSharing(db)),
  run(ctx,input){
   const id=createReportOnlyMachine(db,input.name,ctx.viewer.id,input.sameMachineAsLoom,options.now());
   fresh.add(input);ctx.changed('boxes',id);return{id};
  },after(input){after(input);},
 });
}
