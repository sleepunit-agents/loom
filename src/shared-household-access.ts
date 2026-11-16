import { readHouseholdSetup } from './core/data/household-read.js';
import { reattributeChanges, AttributionConflict, type MergeRuleReader } from './apps/changes.js';
/** Household-wide credential and roster projection, for outside owners only. */
import {eq} from 'drizzle-orm';
import {z} from 'zod';
import {GraphQLObjectType,GraphQLString,GraphQLBoolean,GraphQLList,type GraphQLFieldConfigMap} from 'graphql/index.js';
import type {Viewer} from './policy.js';
import type {DataDatabase} from './core/data/database.js';
import {agents,agentAccounts,sessions} from './core/data/schema.js';
import {OperationError,type Operations} from './core/operations/index.js';
import {sharedTokenOwner} from './core/signin/shared-tokens.js';
import {endBrowser,browserRef} from './core/signin/shared-browser.js';
export function sharedHouseholdAccess(db:DataDatabase,now:()=>string,rule?:MergeRuleReader){
 return{
  read(){ return readHouseholdSetup(db, now()); },
  revokeSession(reference:string){const row=db.select().from(sessions).all().find(row=>browserRef(row.id)===reference);if(!row)throw new OperationError('not-found','Browser not found');endBrowser(db,row.id);return{revoked:true as const};},
  setAccounts(input:{agent:string;github:string[]}){
   if(!db.select().from(agents).where(eq(agents.id,input.agent)).get())throw new OperationError('invalid','Choose an existing agent');
   const logins=[...new Set(input.github.map(login=>login.toLowerCase()))];
   if(db.select().from(agentAccounts).all().some(row=>row.agent!==input.agent&&logins.includes(row.login.toLowerCase())))throw new OperationError('conflict','Login already belongs to another agent');
   db.delete(agentAccounts).where(eq(agentAccounts.agent,input.agent)).run();if(logins.length)db.insert(agentAccounts).values(logins.map(login=>({agent:input.agent,service:'github' as const,login}))).run();
   try{return{saved:true as const,changedChanges:reattributeChanges(db,rule)};}catch(error){if(error instanceof AttributionConflict)throw new OperationError('conflict',error.message);throw error;}
  },
 };
}
export function registerSharedHouseholdAccess(operations:Operations,db:DataDatabase,service:ReturnType<typeof sharedHouseholdAccess>){
 const isOwner=(viewer:Viewer)=>sharedTokenOwner(db,viewer);
 operations.register({name:'sessions.revoke',write:true,recheckPolicy:true,input:z.object({ref:z.string().regex(/^[0-9a-f]{64}$/)}).strict(),output:z.object({revoked:z.literal(true)}).strict(),may:isOwner,run(ctx,input){const result=service.revokeSession(input.ref);ctx.changed('core.access','household');return result;}});
 operations.register({name:'household.setAgentAccounts',write:true,recheckPolicy:true,input:z.object({agent:z.string().min(1),github:z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/)).max(100)}).strict(),output:z.object({saved:z.literal(true)}).strict(),may:isOwner,run(ctx,input){const result=service.setAccounts(input);ctx.changed('agentAccounts',input.agent);for(const id of result.changedChanges)ctx.changed('changes',id);return{saved:result.saved};}});
}
export function householdAccessQueries(db:DataDatabase,service:ReturnType<typeof sharedHouseholdAccess>){
 const ownerReads=new WeakSet<Viewer>();
 const strings=new GraphQLList(GraphQLString);
 const member=new GraphQLObjectType({name:'SetupMember',fields:{id:{type:GraphQLString},role:{type:GraphQLString},fullOwner:{type:GraphQLBoolean},agents:{type:strings}}});
 const agent=new GraphQLObjectType({name:'SetupAgent',fields:{id:{type:GraphQLString},about:{type:GraphQLString},markBg:{type:GraphQLString},markFg:{type:GraphQLString},faceShape:{type:GraphQLString},faceEyes:{type:GraphQLString},github:{type:strings}}});
 const token=new GraphQLObjectType({name:'SetupToken',fields:{fingerprint:{type:GraphQLString},label:{type:GraphQLString},kind:{type:GraphQLString},expired:{type:GraphQLBoolean},identity:{type:GraphQLString},createdAt:{type:GraphQLString},expiresAt:{type:GraphQLString},revokedAt:{type:GraphQLString},lastUsedAt:{type:GraphQLString}}});
 const session=new GraphQLObjectType({name:'SetupBrowser',fields:{ref:{type:GraphQLString},device:{type:GraphQLString},issuedAt:{type:GraphQLString},seenAt:{type:GraphQLString},isAgent:{type:GraphQLBoolean},ended:{type:GraphQLBoolean},member:{type:GraphQLString},tokenLabel:{type:GraphQLString}}});
 const setup=new GraphQLObjectType({name:'HouseholdSetup',fields:{defaultAgent:{type:GraphQLString},members:{type:new GraphQLList(member)},agents:{type:new GraphQLList(agent)},tokens:{type:new GraphQLList(token)},sessions:{type:new GraphQLList(session)}}});
 const fields:GraphQLFieldConfigMap<unknown,{viewer:Viewer}>={householdSetup:{type:setup,resolve(_row,_args,{viewer}){if(!sharedTokenOwner(db,viewer))return null;ownerReads.add(viewer);return service.read();}}};return{fields,valid:(viewer:Viewer)=>!ownerReads.has(viewer)||sharedTokenOwner(db,viewer)};
}
