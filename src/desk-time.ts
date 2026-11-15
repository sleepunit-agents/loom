/** Shared server minute for the desk. This source has no separate connection,
 * credentials or persistent clock rows. */
import {GraphQLFloat,GraphQLNonNull,GraphQLObjectType,GraphQLString,type GraphQLFieldConfigMap} from 'graphql/index.js';
import type {DataDatabase} from './core/data/database.js';
import type {Clock} from './core/clock.js';
import {household} from './core/data/schema.js';
import {maySee,type Viewer} from './policy.js';
import {sharedSharing} from './shared-sharing.js';
export function deskTimeFields(db:DataDatabase,clock:Clock):GraphQLFieldConfigMap<unknown,{viewer:Viewer}>{
 const minute=new GraphQLObjectType({name:'DeskTime',fields:{at:{type:new GraphQLNonNull(GraphQLFloat)},timezone:{type:new GraphQLNonNull(GraphQLString)}}});
 return {deskTime:{type:minute,resolve(_row,_args,{viewer}){
  // The existing personal-row rule, read against current shared household facts.
  if(viewer.kind!=='member'||!maySee(viewer,{member:viewer.id},sharedSharing(db)))return null;
  return {at:Math.floor(clock.now()/60000)*60000,timezone:db.select({timezone:household.timezone}).from(household).get()?.timezone??'UTC'};
 }}};
}
/** A jump publishes the current minute once; queued callbacks stop at close. */
export function startDeskTime(clock:Clock,changed:()=>void,reportError:(error:unknown)=>void){
 let stopped=false,cancel=()=>{};
 const schedule=()=>{cancel=clock.at((Math.floor(clock.now()/60000)+1)*60000,()=>queueMicrotask(()=>{
  if(stopped)return;
  try{changed();}catch(error){try{reportError(error);}catch{/* Reporting cannot retain the minute loop. */}}
  finally{if(!stopped)schedule();}
 }));};
 schedule();return()=>{stopped=true;cancel();};
}
