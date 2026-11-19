/** Outside metadata administration. The private program owns provider sign-in;
 * these commands record its result, never provider credentials. */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { mayAct, mayCreate, type Viewer } from './policy.js';
import { sharedSharing } from './shared-sharing.js';
import type { DataDatabase } from './core/data/database.js';
import { boxes, modelAccounts } from './core/data/schema.js';
import type { Operations, Door } from './core/operations/index.js';
import { accountBoxes } from './runtime/account-boxes.js';
import { AccountLogins } from './runtime/account-logins.js';
import type { ModelRole } from './runtime/placement.js';
import { lineName as name } from './core/line-name.js';
export function registerModelAccountAdmin(operations:Operations,db:DataDatabase,roles:()=>readonly ModelRole[],now:()=>string){
 const account=(id:string)=>db.select().from(modelAccounts).where(eq(modelAccounts.id,id)).get();
 const owns=(viewer:Viewer,id:string)=>{
  const row=account(id);
  return viewer.kind==='member'&&!!row&&mayAct(viewer,{type:'runtime.model-account',member:row.owner},sharedSharing(db));
 };
 const signedIn=(viewer:Viewer,input:{account:string;box:string})=>{
  if(!owns(viewer,input.account))return false;
  const box=db.select().from(boxes).where(and(eq(boxes.id,input.box),isNull(boxes.revokedAt))).get();
  return !!box&&mayAct(viewer,{type:'runtime.box',member:box.owner},sharedSharing(db));
 };
 // The one writer of which machines an account is signed in on, with the rule that follows each change.
 const signIns=accountBoxes(db),committed=(input:{account:string;box:string})=>signIns.committed(input);
 const common:{write:boolean;recheckPolicy:boolean;doors:Door[]}={write:true,recheckPolicy:true,doors:['http']};
 operations.register({...common,name:'runtime.accountCreate',
  input:z.object({provider:name,label:name}).strict(),output:z.object({id:z.string()}).strict(),
  may:(viewer,input)=>viewer.kind==='member'&&mayCreate(viewer,{type:'runtime.model-account',member:viewer.id},sharedSharing(db))&&roles().some(role=>role.provider===input.provider),
  run(ctx,input){
   const id='account-'+randomUUID();
   db.insert(modelAccounts).values({id,owner:ctx.viewer.id,provider:input.provider,label:input.label,usage:0,hasRoom:false}).run();
   ctx.changed('modelAccount',id);return{id};
  },
 });
 operations.register({...common,name:'runtime.accountRename',
  input:z.object({account:name,label:name}).strict(),output:z.object({saved:z.literal(true)}).strict(),
  may:(viewer,input)=>owns(viewer,input.account),
  run(ctx,input){db.update(modelAccounts).set({label:input.label}).where(eq(modelAccounts.id,input.account)).run();ctx.changed('modelAccount',input.account);return{saved:true as const};},
 });
 const binding=z.object({account:name,box:name}).strict(),saved=z.object({saved:z.literal(true)}).strict();
 operations.register({...common,name:'runtime.accountSignedIn',input:binding,output:saved,may:signedIn,
  run(ctx,input){
   // A fresh sign-in event invalidates older readers even when the association
   // was already present. Cached receipt replay must not do this again.
   signIns.signedIn(input,input.account,input.box);ctx.changed('modelAccount',input.account);return{saved:true as const};
  },
  after:committed,
 });
 operations.register({...common,name:'runtime.accountSignedOut',input:binding,output:saved,
  may:(viewer,input)=>owns(viewer,input.account),
  run(ctx,input){
   // What was learned about its sign-ins there goes with it, and any notice about them closes.
   const forgot=new AccountLogins(db,now).forget(input.account,input.box);
   if(signIns.signedOut(input,input.account,input.box)||forgot)ctx.changed('modelAccount',input.account);
   return{saved:true as const};
  },
  // Membership changes share the existing observation generation. A remove/
  // re-add cannot make a pre-sign-in read current again, including identical data.
  after:committed,
 });
}
