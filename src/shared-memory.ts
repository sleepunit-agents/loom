import type {EmbeddingProvider} from './backends/types.js';
import {Notes,notesDbPath} from './notes.js';
import {sharedNotes} from './shared-notes.js';
/** Memory stays in declared source files. Existing store/action modules own
 * their schema and retry receipts; this creates no legacy loom tables. */
import {mkdirSync,openSync,closeSync,fsyncSync,linkSync,rmSync,statSync} from 'node:fs';
import Database from 'better-sqlite3';
import {basename,dirname,join} from 'node:path';
import type {DataDatabase} from './core/data/database.js';
import {eq} from 'drizzle-orm';
import type {Clock} from './core/clock.js';
import type {Operations} from './core/operations/index.js';
import {household,agents as agentRows} from './core/data/schema.js';
import {householdTimezone} from './core/data/household-settings.js';
import {installTouched} from './core/touched/index.js';
import {mindTouchSources,mindTouchResolver} from './pieces/mind/binding.js';
import type {MindSources} from './pieces/mind/sources.js';
import {peopleReader} from './pieces/mind/people.js';
import {createProjectsReader} from './pieces/mind/projects.js';
import {createActivityReader} from './pieces/mind/activity.js';
import {sharedActivityConversations} from './pieces/mind/activity-conversations.js';
import type {ProjectSectionRole} from './pieces/mind/projects-roles.js';
import {memoryQueryFields} from './transport/memory-queries.js';
import {installMindKnowledgeActions} from './pieces/mind/actions.js';
import {installMindPeopleActions} from './pieces/mind/people-actions.js';
import {SqliteKnowledgeBackend} from './backends/sqlite-knowledge.js';
import {verifyKnowledgePages} from './backends/knowledge-verification.js';
import {PeopleStore} from './backends/people.js';
import {ProjectsStore} from './backends/projects.js';
import {createPersonHalf} from './backends/people-creation.js';
import type {TaskService} from './apps/tasks.js';
import {sharedProjectSections} from './shared-memory-projects.js';
import {sharedSharing} from './shared-sharing.js';
import {migrateMindReceipts} from './pieces/mind/receipt-schema.js';
import {prepareSemanticMemory} from './pieces/mind/semantic-schema.js';
import {registerSemanticMemory} from './pieces/mind/semantic-commands.js';
export interface SharedMemoryOptions {
 sources:MindSources;
 checkingAgent:string;
 sections?:{tasks?:ProjectSectionRole;notes?:ProjectSectionRole;conversations?:ProjectSectionRole;changes?:ProjectSectionRole};
}
/** Fresh declared files only. Existing precious files, including their schema,
 * are left to their existing owner. Run before readers and touch listeners.
 *
 * A file is made whole under a temporary name beside it and given its real name
 * last, so a start that is killed part-way leaves nothing a later start would
 * take for a prepared file. What such a start leaves behind is its temporary
 * directory, which the next start removes before it begins again. */
export async function prepareSharedMemorySources(options:SharedMemoryOptions|undefined){
 if(!options)return;
 const {commons,agents}=options.sources;
 const fresh=async(path:string,initialise:(directory:string,path:string)=>void|Promise<void>)=>{
  // An empty file under the real name holds nothing: an earlier program created
  // the file first and prepared it after, and was killed between the two.
  const present=statSync(path,{throwIfNoEntry:false});
  if(present&&(present.size>0||!present.isFile()))return;
  const directory=path+'.preparing',making=join(directory,basename(path));
  rmSync(directory,{recursive:true,force:true});mkdirSync(directory,{mode:0o700});
  closeSync(openSync(making,'wx',0o600));
  await initialise(directory,making);
  // The last connection folds the write-ahead log into the file as it closes,
  // so the one file that is named below is the whole database.
  const db=new Database(making,{fileMustExist:true});
  try{migrateMindReceipts(db);db.pragma('wal_checkpoint(TRUNCATE)');}finally{db.close();}
  if(statSync(making+'-wal',{throwIfNoEntry:false})?.size)throw Error('A prepared Memory file still has unsaved pages');
  const file=openSync(making,'r');try{fsyncSync(file);}finally{closeSync(file);}
  if(present)for(const suffix of ['','-wal','-shm','-journal'])rmSync(path+suffix,{force:true});
  // Linking refuses a name that is taken, so a file that appeared meanwhile is kept.
  try{linkSync(making,path);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  rmSync(directory,{recursive:true,force:true});
 };
 for(const path of [commons.knowledge,commons.people,...agents.map(a=>a.memories)])mkdirSync(dirname(path),{recursive:true});
 await fresh(commons.knowledge,async(_directory,path)=>{
  const knowledge=new SqliteKnowledgeBackend({dbPath:path});
  try{await knowledge.getPage('bootstrap-probe');}finally{knowledge.close();}
 });
 await fresh(commons.people,(_directory,path)=>{new PeopleStore({dbPath:path}).close();});
 for(const agent of agents){await fresh(notesDbPath(agent.directory),directory=>{new Notes(directory).close();});await fresh(agent.memories,(_directory,path)=>{
  new PeopleStore({dbPath:path,actor:agent.agent}).close();
  new ProjectsStore({dbPath:path}).close();
  const db=new Database(path,{fileMustExist:true});try{prepareSemanticMemory(db);}finally{db.close();}
 });}
}
export function validateSharedMemoryOptions(db:DataDatabase,options:SharedMemoryOptions|undefined){
 if(options&&(typeof options.checkingAgent!=='string'||!options.checkingAgent.trim()||!db.select().from(agentRows).where(eq(agentRows.id,options.checkingAgent)).get()))throw new Error('Memory needs an explicit configured checking agent');
}
export function sharedMemory(db:DataDatabase,clock:Clock,options:SharedMemoryOptions|undefined,tasks:Pick<TaskService,'ready'>,embedding?:()=>EmbeddingProvider){
 validateSharedMemoryOptions(db,options);
 const closers:Array<()=>void>=[];let closed=false;
 const close=()=>{if(closed)return;closed=true;const errors:unknown[]=[];for(const stop of closers.splice(0).reverse())try{stop();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'Memory teardown failed');};
 const timezone=()=>householdTimezone(db);
 const sharing=()=>sharedSharing(db),sources=options?.sources,agents=sources?.agents??[];
 const settings=db.select().from(household).get();
 const conversationHref=(id:string)=>'/p/comms-preview/conversation/'+encodeURIComponent(id);
 const projectHref=(agent:string,slug:string)=>'/p/projects-preview/project/'+encodeURIComponent(agent+':'+slug);
 try{
  const people=peopleReader({directory:sources?.commons.people,agents,sharing,now:()=>clock.now(),projectHref});closers.push(people.close);
  const projects=createProjectsReader(clock,{agents,sharing,people,...sharedProjectSections(db,tasks),...options?.sections});closers.push(projects.close);
  const activity=createActivityReader(clock,{agents,sharing,timezone,github:settings?.githubOwner,conversations:sharedActivityConversations(db,{conversationHref})});closers.push(activity.close);
  const queries=memoryQueryFields(db,{sources,sharing,now:()=>clock.now(),projects,activity,conversationHref,projectHref});closers.push(queries.close);
  const notes=sharedNotes({sources,sharing,now:()=>clock.now()});closers.push(notes.close);
  const touches=mindTouchSources(sources);
  return {people,projects,activity,checkingAgent:options?.checkingAgent,fields:{...queries.fields,...notes.fields},nextDeadline:queries.nextDeadline,observeDeadlines:queries.observeDeadlines,sweep:queries.sweep,touches,close,
   register(operations:Operations,commands?:Pick<Parameters<typeof registerSemanticMemory>[1],'body'|'hash'|'committed'>){
    installTouched(operations,mindTouchResolver(touches));
    const knowledge=installMindKnowledgeActions(operations,{path:sources?.commons.knowledge,sharing,verify:verifyKnowledgePages});closers.push(knowledge.close);
    const agent=settings?.defaultAgent??undefined;
    const actions=installMindPeopleActions(operations,{directory:sources?.commons.people,relationship:agents.find(a=>a.agent===agent)?.memories,agent,sharing,create:createPersonHalf});closers.push(actions.close);
    if(commands)notes.register(operations,commands);
    if(commands)closers.push(registerSemanticMemory(operations,{sources,now:()=>clock.now(),embedding,...commands}).close);
   },
  };
 }catch(error){close();throw error;}
}
