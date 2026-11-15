/** Machine registry metadata; credentials are issued only by canonical Sign-in. */
import {randomUUID} from 'node:crypto';
import {and,eq,isNull} from 'drizzle-orm';
import {z} from 'zod';
import {mayAct,mayCreate,type Viewer} from './policy.js';
import {sharedSharing} from './shared-sharing.js';
import type {DataDatabase} from './core/data/database.js';
import {boxes} from './core/data/schema.js';
import {OperationError,type Operations} from './core/operations/index.js';
export function registerMachineRegistry(operations:Operations,db:DataDatabase,options:{now():string;changed():void}){
 const fresh=new WeakSet<object>();
 const after=(input:object)=>{if(fresh.delete(input))options.changed();};
 const owner=(viewer:Viewer,id:string)=>{const box=db.select().from(boxes).where(eq(boxes.id,id)).get();return viewer.kind==='member'&&!!box&&mayAct(viewer,{type:'runtime.box',member:box.owner},sharedSharing(db));};
 operations.register({name:'runtime.boxCreate',write:true,recheckPolicy:true,doors:['http'],
  input:z.object({name:z.string().min(1).max(200).refine(value=>value===value.trim()&&!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)),sameMachineAsLoom:z.boolean()}).strict(),
  output:z.object({id:z.string()}).strict(),
  may:viewer=>viewer.kind==='member'&&mayCreate(viewer,{type:'runtime.box',member:viewer.id},sharedSharing(db)),
  run(ctx,input){
   if(db.select({id:boxes.id}).from(boxes).where(and(eq(boxes.name,input.name),isNull(boxes.revokedAt))).get())throw new OperationError('conflict','Machine name is already in use');
   const id='box-'+randomUUID();db.insert(boxes).values({id,name:input.name,owner:ctx.viewer.id,sameMachineAsLoom:input.sameMachineAsLoom,hostsAny:false,reportOnly:true,alwaysOn:false,enrolledAt:options.now()}).run();
   fresh.add(input);ctx.changed('boxes',id);return{id};
  },after(input){after(input);},
 });
 operations.register({name:'runtime.boxRevoke',write:true,recheckPolicy:true,doors:['http'],
  input:z.object({box:z.string().min(1).max(200)}).strict(),output:z.object({saved:z.literal(true)}).strict(),may:(viewer,input)=>owner(viewer,input.box),
  run(ctx,input){const box=db.select().from(boxes).where(eq(boxes.id,input.box)).get()!;if(!box.revokedAt){db.update(boxes).set({revokedAt:options.now()}).where(eq(boxes.id,box.id)).run();fresh.add(input);ctx.changed('boxes',box.id);}return{saved:true as const};},after(input){after(input);},
 });
}
