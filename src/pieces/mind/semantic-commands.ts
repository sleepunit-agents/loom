/** Native commands use the authenticated body's declared private source.
 * Content stays there: shared retry results contain opaque IDs, never titles, paths or words. */
import Database from 'better-sqlite3';
import {existsSync} from 'node:fs';
import {z} from 'zod';
import {OperationError,RecoveredWrite,type Operations,type Context,type WriteReceipt} from '../../core/operations/index.js';
import type {Viewer} from '../../policy.js';
import {SqliteVecBackend} from '../../backends/sqlite-vec.js';
import type {EmbeddingProvider} from '../../backends/types.js';
import {createEmbeddingProvider} from '../../backends/index.js';
import {semanticMemoryReady,semanticCardsReady} from './semantic-schema.js';
import {opaqueCardReference} from './card-references.js';
import {prepareMemoryInput} from '../../tools/remember.js';
import {proposeOnConnection,ratifyOnConnection} from '../../backends/proposals.js';
import type {MindSources} from './sources.js';
import {PeopleStore} from '../../backends/people.js';
import {ProjectsStore} from '../../backends/projects.js';
import {CardError,type CardConnection} from '../../backends/cards.js';
type Identity={name:string;input_hash:string;expires:number};
type Stored=Identity&{result:string};
const category=z.enum(['user','project','self','feedback','reference','pursuit','episode']);
const authored=z.string().refine(value=>value.trim().length>0,'Authored text cannot be blank');
const remember=z.object({category,title:authored.max(200),content:authored.max(65536),project:z.string().min(1).max(200).optional(),ttl:z.string().max(50).optional(),metadata:z.record(z.string(),z.json()).refine(value=>JSON.stringify(value).length<=32768).optional(),
 sourcing:z.enum(['observed','relayed','inferred','system']).optional().describe('How the memory was produced: observed first-hand, relayed by someone, inferred, or written by the system.'),provenance:z.string().max(2000).optional().describe('Where it came from: a surface, session, lane or person.')}).strict();
const recall=z.object({query:z.string().min(1).max(4000),category:category.optional(),project:z.string().min(1).max(200).optional(),limit:z.number().int().min(1).max(50).default(10)}).strict();
export function registerSemanticMemory(operations:Operations,options:{sources?:MindSources;now():number;embedding?():EmbeddingProvider;hash(words:string):string;body(viewer:Viewer):Readonly<{agent:string}>|undefined;committed():void}){
 const sources=new Map<string,{path:string;db:Database.Database}>();let closed=false;
 try{for(const source of options.sources?.agents??[]){if(sources.has(source.agent))throw Error('Duplicate Memory source agent');if(existsSync(source.memories))sources.set(source.agent,{path:source.memories,db:new Database(source.memories,{readonly:true,fileMustExist:true,timeout:0})});}}
 catch(error){for(const source of sources.values())source.db.close();throw error;}
 const close=()=>{if(closed)return;closed=true;for(const source of sources.values())source.db.close();sources.clear();};
 const selected=(viewer:Viewer)=>{if(closed)return;const body=options.body(viewer);return body?sources.get(body.agent):undefined;};
 const author=(viewer:Viewer)=>{const body=options.body(viewer);if(!body)throw new OperationError('denied','Current body required');return body.agent;};
 const current=(viewer:Viewer)=>{const source=selected(viewer);return source&&semanticMemoryReady(source.db)?source:undefined;};
 // Keep lookups at their owning snapshot: recovery filters expiry, admission
 // deletes expired rows under its lock, execution retains the original deadline.
 // The shared identity check applies equally to preparations and receipts.
 const check=(prior:Identity,receipt:Readonly<WriteReceipt>)=>{if(prior.name!==receipt.name||prior.input_hash!==receipt.inputHash)throw new OperationError('conflict','Operation id already used for different input');};
 const recover=(ctx:Context)=>{
  if(closed||!ctx.receipt||ctx.viewer.kind!=='agent')return;
  const own=sources.get(ctx.viewer.id);if(!own)return;
  for(const {db} of [own]){
   if(!semanticMemoryReady(db))continue;
   const args=[ctx.receipt.viewer,ctx.receipt.id,ctx.now];
   const done=db.prepare('SELECT name,input_hash,result,expires FROM memory_command_receipts WHERE viewer=? AND id=? AND expires>?').get(...args) as Stored|undefined;
   if(done){check(done,ctx.receipt);const value=JSON.parse(done.result) as {ids:string[]};for(const id of value.ids)ctx.changed('memory',id);return new RecoveredWrite(value,done.expires);}
   const pending=db.prepare('SELECT name,input_hash,expires FROM memory_command_preparations WHERE viewer=? AND id=? AND expires>?').get(...args) as Identity|undefined;
   if(pending)check(pending,ctx.receipt);
  }
 };
 const reserve=(ctx:Context)=>{
  const source=current(ctx.viewer),receipt=ctx.receipt;if(!source||!receipt)throw new OperationError('unavailable','Memory is not prepared for commands');
  const db=new Database(source.path,{fileMustExist:true,timeout:0});
  try{db.transaction(()=>{
   db.prepare('DELETE FROM memory_command_preparations WHERE expires<=?').run(ctx.now);
   db.prepare('DELETE FROM memory_command_receipts WHERE expires<=?').run(ctx.now);
   const done=db.prepare('SELECT name,input_hash,expires FROM memory_command_receipts WHERE viewer=? AND id=? AND expires>?').get(receipt.viewer,receipt.id,ctx.now) as Identity|undefined;
   if(done){check(done,receipt);return;}
   const old=db.prepare('SELECT name,input_hash,expires FROM memory_command_preparations WHERE viewer=? AND id=?').get(receipt.viewer,receipt.id) as Identity|undefined;
   if(old){check(old,receipt);return;}
   db.prepare('INSERT INTO memory_command_preparations (viewer,id,name,input_hash,expires) VALUES(?,?,?,?,?)').run(receipt.viewer,receipt.id,receipt.name,receipt.inputHash,receipt.expires);
  }).immediate();}finally{db.close();}
 };
 const execute=async(viewer:Viewer,receipt:Readonly<WriteReceipt>|undefined,run:(backend:SqliteVecBackend,db:Database.Database)=>Promise<{ids:string[];matches?:Array<{id:string;score:number}>}>)=>{
  const source=current(viewer);if(!source||!receipt)throw new OperationError('denied','Current body required');
  // Never use the process-cached helper connection: no other caller can join
  // this command's transaction while its embedding computation awaits.
  const backend=new SqliteVecBackend({dbPath:source.path,notifyWrites:false,busyTimeout:0,deferSchema:true},(options.embedding??createEmbeddingProvider)());
  try{await backend.atomicWrite(async db=>{
   const done=db.prepare('SELECT name,input_hash,result,expires FROM memory_command_receipts WHERE viewer=? AND id=?').get(receipt.viewer,receipt.id) as Stored|undefined;
   if(done){check(done,receipt);return;}
   const pending=db.prepare('SELECT name,input_hash,expires FROM memory_command_preparations WHERE viewer=? AND id=?').get(receipt.viewer,receipt.id) as Identity|undefined;
   if(!pending)throw new OperationError('conflict','Memory command reservation ended');check(pending,receipt);
   const raw=await run(backend,db),agent=options.body(viewer)?.agent;
   const result={ids:raw.ids.map(id=>`${agent}:${id}`),...(raw.matches?{matches:raw.matches.map(match=>({...match,id:`${agent}:${match.id}`}))}:{})};
   if(current(viewer)?.path!==source.path||pending.expires<=options.now())throw new OperationError('denied','Memory access ended');
   db.prepare('INSERT INTO memory_command_receipts (viewer,id,name,input_hash,result,expires) VALUES(?,?,?,?,?,?)').run(receipt.viewer,receipt.id,receipt.name,receipt.inputHash,JSON.stringify(result),pending.expires);
   db.prepare('DELETE FROM memory_command_preparations WHERE viewer=? AND id=?').run(receipt.viewer,receipt.id);
  });}finally{backend.close();}
  // The source fact is committed even if the later shared receipt fails.
  // Publish that fact independently so active readers cannot remain stale.
  options.committed();
 };
 const base={write:true,recheckPolicy:true,doors:['http'] as const,inputHash:(words:string)=>options.hash(words),recover,admit:reserve,may:(viewer:Viewer)=>!!selected(viewer),run(){throw new OperationError('unavailable','Memory command did not commit');}};
 const opaque=(db:Database.Database,ref:string)=>{const row=db.prepare('SELECT uuid FROM memories WHERE ref=?').get(ref) as {uuid:string}|undefined;if(!row)throw new OperationError('unavailable','Memory result is absent');return row.uuid;};
 const scopedId=z.string().regex(/^[^:]+:[a-f0-9-]{36}$/);
 const proposalId=z.string().regex(/^[^:]+:proposal:[a-f0-9-]{36}$/);
 const ids=z.array(scopedId).describe('Opaque scoped memory IDs. Read words through memoryProjectMemory(id: id) on GraphQL.');
 operations.register({...base,doors:[...base.doors],name:'memory.remember',input:remember.describe('Remember in your own declared source. Returns opaque IDs; select memoryProjectMemory(id: id) on GraphQL to read words.'),output:z.object({ids}).strict(),prepare:async(input,{viewer,receipt})=>execute(viewer,receipt,async(backend,db)=>({ids:[opaque(db,(await backend.remember(prepareMemoryInput(input))).ref)]}))});
 // Recall is a read: no operation id, no reservation, no receipt. It warms what it finds, which the
 // store records in its own short transaction after the embedding has been computed, so nothing is
 // locked while that runs. Asking twice simply recalls twice.
 operations.register({name:'memory.recall',doors:['http'],recheckPolicy:true,may:(viewer:Viewer)=>!!selected(viewer),
  input:recall.describe('Recall your memories by meaning, adding heat. Returns opaque IDs and scores; select memoryProjectMemory(id: id) on GraphQL for title and content.'),output:z.object({ids,matches:z.array(z.object({id:scopedId,score:z.number()}))}).strict(),
  prepare:async(input,{viewer})=>{
   const source=current(viewer),agent=options.body(viewer)?.agent;
   // A source that has not been prepared is left exactly as it is.
   if(!source||!agent)throw new OperationError(selected(viewer)?'unavailable':'denied',selected(viewer)?'Memory is not prepared for commands':'Current body required');
   // The memory tables are made by the first write, in its transaction. Until then there is nothing to recall.
   if(!source.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memories'").get())return {ids:[],matches:[]};
   const backend=new SqliteVecBackend({dbPath:source.path,notifyWrites:false,deferSchema:true},(options.embedding??createEmbeddingProvider)());
   try{
    const matches=(await backend.recall(input)).map(row=>({id:`${agent}:${opaque(source.db,row.path)}`,score:row.relevance}));
    if(current(viewer)?.path!==source.path)throw new OperationError('denied','Memory access ended');
    return {ids:matches.map(row=>row.id),matches};
   }finally{backend.close();options.committed();}
  },
  run(_ctx,_input,prepared){return prepared;}});
 const cardValue=z.union([z.string(),z.number(),z.boolean(),z.array(z.string())]);
 const stamp={verified_at:z.string().optional(),source:z.string().optional(),stale_after_days:z.number().optional()};
 const person=z.object({slug:z.string().min(1).max(64),name:z.string().optional(),summary:z.string().optional(),where:z.record(z.string(),z.object({value:cardValue,...stamp,label:z.string().optional()}).strict().nullable()).optional(),how:z.record(z.string(),cardValue.nullable()).optional(),may:z.array(z.object({text:z.string(),source:z.string()}).strict()).optional(),merge:z.boolean().optional()}).strict();
 const project=z.object({slug:z.string().min(1).max(32),name:z.string().optional(),status:z.enum(['active','paused','done']).optional(),summary:z.string().optional(),goal:z.string().optional(),where:z.record(z.string(),z.object({value:z.string(),...stamp}).strict().nullable()).optional(),links:z.object({aliases:z.array(z.string()).nullable().optional(),notes:z.array(z.string()).nullable().optional(),epic:z.string().nullable().optional(),repos:z.array(z.string()).nullable().optional(),venues:z.array(z.string()).nullable().optional()}).strict().optional(),merge:z.boolean().optional()}).strict();
 const cardIds=z.object({ids:z.array(z.string().regex(/^[^:]+:(person|project):[a-f0-9-]{36}$/))}).strict();
 const cardBase={...base,admit(ctx:Context){const source=current(ctx.viewer);if(!source||!semanticCardsReady(source.db))throw new OperationError('unavailable','Private cards are not prepared for commands');reserve(ctx);}};
 const withCard=<Store extends {close():void}>(db:Database.Database,viewer:Viewer,kind:'person'|'project',open:(connection:CardConnection)=>Store,change:(store:Store)=>{card:{slug:string}})=>{
  try{const store=open({database:db,actor:author(viewer),now:options.now});try{return {ids:[opaqueCardReference(db,kind,change(store).card.slug)]};}finally{store.close();}}
  catch(error){if(error instanceof CardError)throw new OperationError('invalid',`Invalid ${kind} card`);throw error;}
 };
 operations.register({...cardBase,doors:[...base.doors],name:'memory.personWrite',input:person.describe('Write a person card in your own declared private Memory source. Read the returned opaque ID with memoryPerson(id:) on GraphQL. Card claims never grant permission.'),output:cardIds,
  prepare:async(input,{viewer,receipt})=>execute(viewer,receipt,async(_backend,db)=>withCard(db,viewer,'person',config=>new PeopleStore(config),store=>store.write(input)))});
 operations.register({...cardBase,doors:[...base.doors],name:'memory.projectWrite',input:project.describe('Write a project card in your own declared private Memory source. Read the returned opaque ID with memoryProject(id:) on GraphQL. Links do not grant sharing.'),output:cardIds,
  prepare:async(input,{viewer,receipt})=>execute(viewer,receipt,async(_backend,db)=>withCard(db,viewer,'project',config=>new ProjectsStore(config),store=>store.write(input)))});
 operations.register({...cardBase,doors:[...base.doors],name:'memory.personRestoreRevision',input:z.object({slug:z.string().min(1).max(64),revision_id:z.number().int().positive().max(2147483647)}).strict().describe('Restore one retained person-card revision in your own source. Read revision IDs with memoryPerson(id:){history{id}}.'),output:cardIds,
  prepare:async(input,{viewer,receipt})=>execute(viewer,receipt,async(_backend,db)=>withCard(db,viewer,'person',config=>new PeopleStore(config),store=>store.revisionRestore(input)))});
 operations.register({...base,doors:[...base.doors],name:'memory.propose',input:remember.omit({sourcing:true,provenance:true}).extend({category:authored.max(100),source:authored.max(200).optional()}).describe('Stage a private draft in your own source. Recall cannot see it until ratification.'),output:z.object({ids:z.array(proposalId)}).strict(),prepare:async(input,{viewer,receipt})=>execute(viewer,receipt,async(_backend,db)=>({ids:['proposal:'+proposeOnConnection(db,input).uuid]}))});
 const overrides=remember.pick({title:true,content:true,category:true,project:true,ttl:true}).partial();
 operations.register({...base,doors:[...base.doors],name:'memory.ratify',input:z.object({id:proposalId,overrides:overrides.optional()}).strict().describe('Ratify one own draft by opaque proposal ID. Optional authored edits apply before it becomes recallable.'),output:z.object({ids}).strict(),prepare:async(input,{viewer,receipt})=>execute(viewer,receipt,async(backend,db)=>{
  const prefix=viewer.id+':proposal:';if(viewer.kind!=='agent'||!input.id.startsWith(prefix))throw new OperationError('denied','Current body draft required');
  const row=db.prepare("SELECT id FROM proposals WHERE uuid=? AND status='pending'").get(input.id.slice(prefix.length)) as {id:number}|undefined;
  if(!row)throw new OperationError('not-found','Draft is absent');
  const ref=await ratifyOnConnection(db,row.id,input.overrides??{},async raw=>{const parsed=remember.safeParse(raw);if(!parsed.success)throw new OperationError('invalid','Draft needs authored edits');return backend.remember(prepareMemoryInput(parsed.data));});
  return {ids:[opaque(db,ref.ref)]};
 })});
 const target=z.object({id:scopedId}).strict();
 const ownTarget=(db:Database.Database,viewer:Viewer,id:string)=>{
  if(viewer.kind!=='agent'||!id.startsWith(viewer.id+':'))throw new OperationError('denied','Current body Memory required');
  const uuid=id.slice(viewer.id.length+1),row=db.prepare('SELECT ref FROM memories WHERE uuid=?').get(uuid) as {ref:string}|undefined;
  if(!row)throw new OperationError('not-found','Memory is absent');return {uuid,ref:row.ref};
 };
 operations.register({...base,doors:[...base.doors],name:'memory.update',
  input:target.extend({content:authored.max(65536).optional(),metadata:remember.shape.metadata,observation:z.enum(['confirm','contradict']).optional()}).refine(input=>input.content!==undefined||input.metadata!==undefined||input.observation!==undefined,'A change is required').describe('Edit one memory in your own declared source. A changed body saves its prior revision first.'),output:z.object({ids}).strict(),
  prepare:async(input,{viewer,receipt})=>execute(viewer,receipt,async(backend,db)=>{
   const row=ownTarget(db,viewer,input.id),result=await backend.update({ref:row.ref,content:input.content,metadata:input.metadata,observation:input.observation});
   if(!result.updated)throw new OperationError('not-found','Memory is absent');return {ids:[row.uuid]};
  })});
 operations.register({...base,doors:[...base.doors],name:'memory.restoreRevision',
  input:target.extend({revision_id:z.number().int().positive().max(2147483647)}).describe('Restore a saved body revision of your own memory. Read retained revisions with memoryHistory(id:) on GraphQL.'),output:z.object({ids}).strict(),
  prepare:async(input,{viewer,receipt})=>execute(viewer,receipt,async(backend,db)=>{
   const row=ownTarget(db,viewer,input.id),result=await backend.restoreRevision({ref:row.ref,revision_id:input.revision_id});
   if(!result.restored)throw new OperationError('not-found','Memory revision is absent');return {ids:[row.uuid]};
  })});
 for(const action of ['archive','restore','forget'] as const)operations.register({...base,doors:[...base.doors],name:`memory.${action}`,
  input:(action==='archive'?target.extend({note:z.string().max(4000).optional()}):target).describe(`${action} one memory in your own declared source by its opaque scoped ID.`),output:z.object({ids}).strict(),
  prepare:async(input,{viewer,receipt})=>execute(viewer,receipt,async(backend,db)=>{
   const row=ownTarget(db,viewer,input.id);
   const result=action==='archive'?(await backend.archive({ref:row.ref,note:'note' in input?input.note as string|undefined:undefined})).archived:action==='restore'?(await backend.restore({ref:row.ref})).restored:(await backend.forget({ref:row.ref})).deleted;
   return {ids:result.length?[row.uuid]:[]};
  })});
 return {close};
}
