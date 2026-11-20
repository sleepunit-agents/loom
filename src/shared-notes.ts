/** Own-source Notes through the same query and operation doors as Memory. */
import {existsSync} from 'node:fs';
import {z} from 'zod';
import {GraphQLObjectType,GraphQLString,GraphQLNonNull,GraphQLInt,GraphQLBoolean,GraphQLList} from 'graphql/index.js';
import {Notes,NoteError,notesDbPath,NOTE_PATH,NOTE_PATH_MAX,LIFESPAN_NAMES,MAX_NOTE_BYTES} from './notes.js';
import {mindReceipts,mindReceiptsReady} from './pieces/mind/receipt-schema.js';
import {AgentFiles,type AgentSource,type MindSources} from './pieces/mind/sources.js';
import {maySee,type Sharing,type Viewer} from './policy.js';
import {OperationError,RecoveredWrite,type Operations,type WriteReceipt,type Context} from './core/operations/index.js';
const path=z.string().max(NOTE_PATH_MAX).regex(NOTE_PATH);
const noteBody=z.string().refine(value=>Buffer.byteLength(value)<=MAX_NOTE_BYTES);
const requiredText={type:new GraphQLNonNull(GraphQLString)};
const requiredInt={type:new GraphQLNonNull(GraphQLInt)};
const noteFileType=new GraphQLObjectType({name:'MemoryNoteFile',fields:{
 name:requiredText,sha256:requiredText,bytes:requiredInt,type:{type:GraphQLString},added:requiredText,
}});
const summaryFields={
 path:requiredText,lifespan:requiredText,created:requiredText,updated:requiredText,by:requiredText,
 pinned:{type:new GraphQLNonNull(GraphQLBoolean)},bytes:requiredInt,files:requiredInt,expires:{type:GraphQLString},
};
const noteType=new GraphQLObjectType({name:'MemoryNote',fields:{
 ...summaryFields,body:requiredText,fileList:{type:new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(noteFileType)))},
}});
/** A listing carries no words or attachment names. */
const noteSummary=new GraphQLObjectType({name:'MemoryNoteSummary',fields:summaryFields});
type Receipt=WriteReceipt;
export function sharedNotes(options:{sources?:MindSources;sharing():Sharing;now():number}){
 const sources=new AgentFiles<AgentSource,Notes>(()=>options.sources?.agents??[],source=>existsSync(notesDbPath(source.directory))?new Notes(source.directory,options.now,{prepared:true}):undefined);
 const close=()=>{for(const notes of sources.end())notes.close();};
 try{sources.follow();}catch(error){close();throw error;}
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
 }}},
 /** `addsOnly` names a caller that writes a new note and overwrites none (the body of a job on anybody else's word),
  * with the words that refuse an overwrite and what loom records as the note's writer in place of the agent alone. */
 register(operations:Operations,commands:{body(viewer:Viewer):Readonly<{agent:string}>|undefined;hash(words:string):string;committed():void;addsOnly?(viewer:Viewer):Readonly<{overwrite:string;by:string}>|undefined}){
  const selected=(viewer:Viewer)=>{const own=commands.body(viewer);return own?sources.get(own.agent):undefined;};
  const recover=(ctx:Context)=>{const notes=selected(ctx.viewer),prior=notes&&ctx.receipt?receipt(notes,ctx.receipt,ctx.now):undefined;if(prior)ctx.changed('memory',ctx.viewer.id);return prior;};
  const write=<T>(ctx:Context,apply:(notes:Notes)=>T)=>{
   const notes=selected(ctx.viewer),identity=ctx.receipt;
   if(!notes||!identity)throw new OperationError('denied','Authenticated agent required');
   const result=notes.atomicWrite(db=>{
    const previous=receipt(notes,identity,ctx.now);if(previous)return previous;
    mindReceipts.expire(db,ctx.now);
    const value=apply(notes);
    mindReceipts.save(db,identity,value,identity.expires);
    return value;
   });
   commands.committed();ctx.changed('memory',ctx.viewer.id);return result;
  };
  const common={write:true,recheckPolicy:true,doors:['http'] as ['http'],inputHash:(words:string)=>commands.hash(words),recover};
  const mayManage=(viewer:Viewer)=>!!selected(viewer)&&!commands.addsOnly?.(viewer);
  operations.register({...common,name:'memory.notePin',input:z.object({path,pinned:z.boolean()}).strict(),
   output:z.union([z.object({path,pinned:z.boolean(),expires:z.string().nullable()}).strict(),z.object({missing:z.literal(true)}).strict()]),may:mayManage,
   run:(ctx,input)=>write(ctx,notes=>{
    try{
     const {path,pinned,expires}=notes.pin(input.path,input.pinned);
     return {path,pinned,expires};
    }catch(error){
     if(error instanceof NoteError&&error.status===404)return {missing:true as const};
     throw error;
    }
   }),
  });
  operations.register({...common,name:'memory.noteDelete',input:z.object({path}).strict(),
   output:z.object({deleted:z.boolean()}).strict(),may:mayManage,
   run:(ctx,input)=>write(ctx,notes=>({deleted:notes.delete(input.path)})),
  });
  operations.register({...common,name:'memory.noteWrite',input:z.object({path,body:noteBody,expectedBody:noteBody.nullable().optional(),lifespan:z.enum(LIFESPAN_NAMES).optional()}).strict(),output:z.object({saved:z.literal(true)}).strict(),may:viewer=>!!selected(viewer),
   run:(ctx,input)=>write(ctx,notes=>{
     const only=commands.addsOnly?.(ctx.viewer);
     if(only&&(input.expectedBody!==undefined||input.path.startsWith('lane-state/')||input.path.startsWith('alert-verdicts/')))
      throw new OperationError('denied','Only an owner-authorized job can claim or install lane state');
     if(only||input.expectedBody!==undefined){
      const current=notes.read(input.path);
      if(only&&current)throw new OperationError('denied',only.overwrite);
      if(input.expectedBody!==undefined&&(current?.body??null)!==input.expectedBody)throw new OperationError('conflict','The note has changed');
     }
     notes.write(input.path,input.body,{lifespan:input.lifespan,by:only?.by??ctx.viewer.id});return {saved:true as const};
   }),
  });
 }};
}
