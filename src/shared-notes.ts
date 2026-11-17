/** Own-source Notes through the same query and operation doors as Memory. */
import {existsSync} from 'node:fs';
import {z} from 'zod';
import {GraphQLObjectType,GraphQLString,GraphQLNonNull,GraphQLInt,GraphQLList} from 'graphql/index.js';
import {Notes,notesDbPath,NOTE_PATH,MAX_NOTE_BYTES} from './notes.js';
import {mindReceipts,mindReceiptsReady} from './pieces/mind/receipt-schema.js';
import type {MindSources} from './pieces/mind/sources.js';
import {maySee,type Sharing,type Viewer} from './policy.js';
import {OperationError,RecoveredWrite,type Operations,type WriteReceipt,type Context} from './core/operations/index.js';
const path=z.string().max(300).regex(NOTE_PATH);
const noteType=new GraphQLObjectType({name:'MemoryNote',fields:Object.fromEntries(['path','body','lifespan','created','updated','by'].map(name=>[name,{type:new GraphQLNonNull(GraphQLString)}]))});
/** A listing carries no words: path, lifetime and size only. */
const noteSummary=new GraphQLObjectType({name:'MemoryNoteSummary',fields:{
 ...Object.fromEntries(['path','lifespan','created','updated','by'].map(name=>[name,{type:new GraphQLNonNull(GraphQLString)}])),
 bytes:{type:new GraphQLNonNull(GraphQLInt)},files:{type:new GraphQLNonNull(GraphQLInt)},expires:{type:GraphQLString},
}});
type Receipt=WriteReceipt;
export function sharedNotes(options:{sources?:MindSources;sharing():Sharing;now():number}){
 const sources=new Map<string,Notes>();
 try{for(const source of options.sources?.agents??[])if(existsSync(notesDbPath(source.directory)))sources.set(source.agent,new Notes(source.directory,options.now,{prepared:true}));}
 catch(error){for(const notes of sources.values())notes.close();throw error;}
 const close=()=>{for(const notes of sources.values())notes.close();sources.clear();};
 const receipt=(notes:Notes,identity:Readonly<Receipt>,now:number)=>notes.atomicWrite(db=>{
  if(!mindReceiptsReady(db))throw new OperationError('unavailable','Notes are not prepared for commands');
  const prior=mindReceipts.find(db,identity,now);
  if(!prior)return;
  return new RecoveredWrite(JSON.parse(prior.result),prior.expires);
 });
 return {close,fields:{memoryNote:{type:noteType,args:{agent:{type:new GraphQLNonNull(GraphQLString)},path:{type:new GraphQLNonNull(GraphQLString)}},resolve(_s:unknown,args:{agent:string;path:string},context:{viewer:Viewer}){
  if(!context?.viewer||!maySee(context.viewer,{type:'memory',agent:args.agent},options.sharing())||!path.safeParse(args.path).success)return null;
  try{return sources.get(args.agent)?.read(args.path)??null;}catch{throw new Error('Note unavailable');}
 }},memoryNotes:{type:new GraphQLList(new GraphQLNonNull(noteSummary)),args:{agent:{type:new GraphQLNonNull(GraphQLString)},prefix:{type:GraphQLString},first:{type:GraphQLInt}},resolve(_s:unknown,args:{agent:string;prefix?:string|null;first?:number|null},context:{viewer:Viewer}){
  if(!context?.viewer||!maySee(context.viewer,{type:'memory',agent:args.agent},options.sharing()))return null;
  const first=args.first??100;if(!Number.isInteger(first)||first<1||first>500)throw new Error('first must be 1 to 500');
  try{return sources.get(args.agent)?.list({prefix:args.prefix??undefined,limit:first})??null;}catch{throw new Error('Notes unavailable');}
 }}},register(operations:Operations,commands:{body(viewer:Viewer):Readonly<{agent:string}>|undefined;hash(words:string):string;committed():void}){
  const selected=(viewer:Viewer)=>{const own=commands.body(viewer);return own?sources.get(own.agent):undefined;};
  const recover=(ctx:Context)=>{const notes=selected(ctx.viewer),prior=notes&&ctx.receipt?receipt(notes,ctx.receipt,ctx.now):undefined;if(prior)ctx.changed('memory',ctx.viewer.id);return prior;};
  operations.register({name:'memory.noteWrite',write:true,recheckPolicy:true,doors:['http'],input:z.object({path,body:z.string().refine(value=>Buffer.byteLength(value)<=MAX_NOTE_BYTES),lifespan:z.enum(['keep','while','short']).optional()}).strict(),output:z.object({saved:z.literal(true)}).strict(),inputHash:words=>commands.hash(words),may:viewer=>!!selected(viewer),recover,
   run(ctx,input){const notes=selected(ctx.viewer),identity=ctx.receipt;if(!notes||!identity)throw new OperationError('denied','Authenticated agent required');
    const result=notes.atomicWrite(db=>{const previous=receipt(notes,identity,ctx.now);if(previous)return previous;mindReceipts.expire(db,ctx.now);
     notes.write(input.path,input.body,{lifespan:input.lifespan,by:ctx.viewer.id});const value={saved:true};
     mindReceipts.save(db,identity,value,identity.expires);return value;
    });commands.committed();ctx.changed('memory',ctx.viewer.id);return result;
   },
  });
 }};
}
