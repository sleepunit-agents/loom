/** Owner-only setup metadata. Exact Viewer witnesses survive asynchronous
 * query completion; the ordinary program query schema excludes this field. */
import {GraphQLObjectType,GraphQLString,GraphQLBoolean,GraphQLList,type GraphQLFieldConfigMap} from 'graphql/index.js';
import {z} from 'zod';
import type {Viewer} from './policy.js';
import type {DataDatabase} from './core/data/database.js';
import type {Operations} from './core/operations/index.js';
import {sharedTokenOwner} from './core/signin/shared-tokens.js';
import {programEditInput,type sharedProgramSetup} from './shared-program-setup.js';
export type ProgramSetup=ReturnType<typeof sharedProgramSetup>;
export function programSetupQueries(db:DataDatabase,service:ProgramSetup|undefined){
 const seen=new WeakSet<object>();
 const list=new GraphQLList(GraphQLString);
 const scope=new GraphQLObjectType({name:'ProgramGrantCatalogue',fields:{records:{type:list},operations:{type:list}}});
 const token=new GraphQLObjectType({name:'ProgramTokenMetadata',fields:{fingerprint:{type:GraphQLString},label:{type:GraphQLString},member:{type:GraphQLString},createdAt:{type:GraphQLString},expiresAt:{type:GraphQLString},revokedAt:{type:GraphQLString},ended:{type:GraphQLBoolean},records:{type:list},operations:{type:list}}});
 const setup=new GraphQLObjectType({name:'ProgramOwnerSetup',fields:{owner:{type:GraphQLString},catalogue:{type:scope},tokens:{type:new GraphQLList(token)}}});
 const fields:GraphQLFieldConfigMap<unknown,{viewer:Viewer}>={programSetup:{type:setup,resolve(_row,_input,{viewer}){
  if(!service||!sharedTokenOwner(db,viewer))return null;seen.add(viewer);return{owner:viewer.id,catalogue:service.catalogue(),tokens:service.list()};
 }}};
 return{fields,valid:(viewer:Viewer)=>!seen.has(viewer)||sharedTokenOwner(db,viewer)};
}
export function registerProgramSetup(operations:Operations,db:DataDatabase,service:ProgramSetup){
 operations.register({name:'program.setGrants',write:true,recheckPolicy:true,input:programEditInput,output:z.object({saved:z.literal(true)}).strict(),may:viewer=>sharedTokenOwner(db,viewer),run(ctx,input){const result=service.set(input);ctx.changed('programGrants',input.fingerprint);return result;}});
}
