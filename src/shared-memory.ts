import type {Viewer} from './policy.js';
import type {EmbeddingProvider} from './backends/types.js';
import {Notes,notesDbPath} from './notes.js';
import {sharedNotes} from './shared-notes.js';
/** Memory stays in declared source files. The store and action modules own
 * their schema and retry receipts; this file runs them at each start, and creates no tables of its own. */
import {mkdirSync,openSync,closeSync,fsyncSync,linkSync,rmSync,statSync} from 'node:fs';
import Database from 'better-sqlite3';
import {basename,dirname,join} from 'node:path';
import type {DataDatabase} from './core/data/database.js';
import {eq} from 'drizzle-orm';
import type {Clock} from './core/clock.js';
import type {Operations} from './core/operations/index.js';
import {agents as agentRows} from './core/data/schema.js';
import {householdSettings,householdTimezone} from './core/data/household-settings.js';
import type {AgentSource,MindSources} from './pieces/mind/sources.js';
import {householdId} from './slug.js';
import {peopleReader} from './pieces/mind/people.js';
import {createProjectsReader} from './pieces/mind/projects.js';
import {createActivityReader} from './pieces/mind/activity.js';
import {sharedActivityConversations} from './pieces/mind/activity-conversations.js';
import type {ProjectSectionRole} from './pieces/mind/projects-roles.js';
import {memoryQueryFields} from './transport/memory-queries.js';
import {installMindKnowledgeActions} from './pieces/mind/actions.js';
import {installMindPeopleActions} from './pieces/mind/people-actions.js';
import {upgradeKnowledgeStore} from './backends/sqlite-knowledge.js';
import {upgradeMemoryTables} from './backends/migrations.js';
import {StartupRefusal} from './core/startup-refusal.js';
import {verifyKnowledgePages} from './backends/knowledge-verification.js';
import {PeopleStore} from './backends/people.js';
import {ProjectsStore} from './backends/projects.js';
import {createPersonHalf} from './backends/people-creation.js';
import {sharedProjectSections} from './shared-memory-projects.js';
import {sharedSharing} from './shared-sharing.js';
import {migrateMindReceipts,upgradeMindReceipts} from './pieces/mind/receipt-schema.js';
import {prepareSemanticMemory,checkSemanticMemory} from './pieces/mind/semantic-schema.js';
import {registerSemanticMemory} from './pieces/mind/semantic-commands.js';
export interface SharedMemoryOptions {
 sources:MindSources;
 checkingAgent:string;
 noteSweepAgent?:string;
 alternateCheckingAgent?:string;
 sections?:{tasks?:ProjectSectionRole;notes?:ProjectSectionRole;conversations?:ProjectSectionRole;changes?:ProjectSectionRole};
}
/** Memory's files for a household. Where the commons are is declared; which agents have files is the
 * household's `agents` table, read each time the list is asked for, so the two cannot disagree. Each agent's
 * files are in a directory named after it. A removed agent keeps its row, and so its place in this list and
 * its files: nothing here deletes anything. */
export function householdMemorySources(db:DataDatabase,commons:MindSources['commons'],agentsDirectory:string):MindSources{
 const ids=db.$client.prepare('SELECT id FROM agents ORDER BY id').pluck();
 let listed:AgentSource[]=[];
 return {commons,get agents(){
  // An id is a directory name here, so only ids the household itself would accept are given one.
  const now=(ids.all() as string[]).filter(id=>householdId.safeParse(id).success);
  if(now.length!==listed.length||now.some((id,at)=>id!==listed[at].agent))listed=now.map(agent=>{const directory=join(agentsDirectory,agent);return {agent,directory,memories:join(directory,'memories.db')};});
  return listed;
 }};
}
/** Every start checks and brings up to date every Memory file it will open, fresh or not, before any
 * reader or command has it: the store's own version check (a file a newer program has changed is refused
 * and left as it is) and the store's upgrade steps. The door's retry and command tables are made with a
 * fresh file; in a file that was already there they are checked and brought up to date if the file has
 * them, and not added if it never did (docs/accepted-tradeoffs.md, "A Memory file the program did not
 * make is not given its retry tables").
 *
 * A fresh file is made whole under a temporary name beside it and given its real name
 * last, so a start that is killed part-way leaves nothing a later start would
 * take for a prepared file. What such a start leaves behind is its temporary
 * directory, which the next preparation removes before it begins again.
 *
 * An existing file is brought up to date where it is. Each step is one transaction and is found pending
 * from the file's shape, so a start killed between two steps is finished by the next one, and a file
 * that is already up to date is not written to. */
function begin(path:string){
 // An empty file under the real name holds nothing: an earlier program created
 // the file first and prepared it after, and was killed between the two.
 const present=statSync(path,{throwIfNoEntry:false});
 if(present&&(present.size>0||!present.isFile()))return;
 const directory=path+'.preparing',making=join(directory,basename(path));
 rmSync(directory,{recursive:true,force:true});mkdirSync(directory,{mode:0o700});
 closeSync(openSync(making,'wx',0o600));
 return {directory,making,replaces:!!present};
}
function finish(path:string,{directory,making,replaces}:NonNullable<ReturnType<typeof begin>>){
 // The last connection folds the write-ahead log into the file as it closes,
 // so the one file that is named below is the whole database.
 const db=new Database(making,{fileMustExist:true});
 try{migrateMindReceipts(db);db.pragma('wal_checkpoint(TRUNCATE)');}finally{db.close();}
 if(statSync(making+'-wal',{throwIfNoEntry:false})?.size)throw Error('A prepared Memory file still has unsaved pages');
 const file=openSync(making,'r');try{fsyncSync(file);}finally{closeSync(file);}
 if(replaces)for(const suffix of ['','-wal','-shm','-journal'])rmSync(path+suffix,{force:true});
 // Linking refuses a name that is taken, so a file that appeared meanwhile is kept.
 try{linkSync(making,path);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 rmSync(directory,{recursive:true,force:true});
}
/** `upgrade` is the store's own check and steps. It is given the file to work on, the directory it is
 * in, and whether the file is being made now. */
function prepare(path:string,upgrade:(directory:string,path:string,fresh:boolean)=>void){
 const made=begin(path);
 if(made){upgrade(made.directory,made.making,true);finish(path,made);return;}
 try{
  upgrade(dirname(path),path,false);
  const db=new Database(path,{fileMustExist:true});try{upgradeMindReceipts(db);}finally{db.close();}
 }catch(error){
  // None of these messages quotes what a file holds: they name a version, a step or a table.
  throw new StartupRefusal(`The Memory file ${path} cannot be used by this program: ${error instanceof Error?error.message:'it could not be opened'}`);
 }
}
/** One agent's notes and memory files: at start for every agent, and for an agent added while the program runs. */
export function prepareAgentMemory(agent:AgentSource){
 for(const directory of [agent.directory,dirname(agent.memories)])mkdirSync(directory,{recursive:true});
 prepare(notesDbPath(agent.directory),directory=>{new Notes(directory).close();});
 prepare(agent.memories,(_directory,path,fresh)=>{
  new PeopleStore({dbPath:path,actor:agent.agent}).close();
  new ProjectsStore({dbPath:path}).close();
  const db=new Database(path,{fileMustExist:true});try{upgradeMemoryTables(db);if(fresh)prepareSemanticMemory(db);else checkSemanticMemory(db);}finally{db.close();}
 });
}
/** Run before readers. */
export async function prepareSharedMemorySources(options:SharedMemoryOptions|undefined){
 if(!options)return;
 const {commons,agents}=options.sources;
 for(const path of [commons.knowledge,commons.people])mkdirSync(dirname(path),{recursive:true});
 prepare(commons.knowledge,(_directory,path)=>{const db=new Database(path,{fileMustExist:true});try{upgradeKnowledgeStore(db);}finally{db.close();}});
 prepare(commons.people,(_directory,path)=>{new PeopleStore({dbPath:path}).close();});
 for(const agent of agents)prepareAgentMemory(agent);
}
export function validateSharedMemoryOptions(db:DataDatabase,options:SharedMemoryOptions|undefined){
 if(options?.noteSweepAgent!==undefined && !options.sources.agents.some(source=>source.agent===options.noteSweepAgent))
  throw new Error('Note retention needs an existing agent with a declared Notes store');
 if(options?.alternateCheckingAgent!==undefined){
  const alternate=db.select().from(agentRows).where(eq(agentRows.id,options.alternateCheckingAgent)).get();
  if(!alternate||alternate.removedAt||alternate.id===options.checkingAgent)throw new Error('Memory needs a different active alternate checking agent');
 }
 if(options&&(typeof options.checkingAgent!=='string'||!options.checkingAgent.trim()||!db.select().from(agentRows).where(eq(agentRows.id,options.checkingAgent)).get()))throw new Error('Memory needs an explicit configured checking agent');
}
export function sharedMemory(db:DataDatabase,clock:Clock,options:SharedMemoryOptions|undefined,embedding?:()=>EmbeddingProvider,report?:(error:unknown)=>void){
 validateSharedMemoryOptions(db,options);
 const closers:Array<()=>void>=[];let closed=false;
 const close=()=>{if(closed)return;closed=true;const errors:unknown[]=[];for(const stop of closers.splice(0).reverse())try{stop();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'Memory teardown failed');};
 const timezone=()=>householdTimezone(db);
 const sharing=()=>sharedSharing(db),given=options?.sources;
 // The files of every agent listed at start were prepared before this (prepareSharedMemorySources). An agent
 // listed later was added while the program runs: its files are made whole in the same way before any
 // reader is given its name. If that fails it is reported once and tried again at the next read, and until
 // it works the agent has no Memory, as before it was added.
 const prepared=new Set(given?.agents.map(source=>source.agent)),reported=new Set<string>();
 const sources:MindSources|undefined=given&&{commons:given.commons,get agents(){
  return given.agents.filter(source=>{
   if(prepared.has(source.agent))return true;
   try{prepareAgentMemory(source);}catch(error){if(!reported.has(source.agent)){reported.add(source.agent);report?.(error);}return false;}
   prepared.add(source.agent);
   return true;
  });
 }};
 // Handed to each reader as a property that is read again each time, never as a copy.
 const listed={get agents(){return sources?.agents??[];}};
 const conversationHref=(id:string)=>'/p/comms-preview/conversation/'+encodeURIComponent(id);
 const projectHref=(agent:string,slug:string)=>'/p/projects-preview/project/'+encodeURIComponent(agent+':'+slug);
 try{
  const people=peopleReader({directory:sources?.commons.people,get agents(){return listed.agents;},sharing,now:()=>clock.now(),projectHref});closers.push(people.close);
  const projects=createProjectsReader(clock,{get agents(){return listed.agents;},sharing,people,...sharedProjectSections(db),...options?.sections});closers.push(projects.close);
  const activity=createActivityReader(clock,{get agents(){return listed.agents;},sharing,timezone,github:()=>householdSettings(db).githubOwner,conversations:sharedActivityConversations(db,{conversationHref})});closers.push(activity.close);
  const queries=memoryQueryFields(db,{sources,sharing,now:()=>clock.now(),projects,activity,conversationHref,projectHref});closers.push(queries.close);
  const notes=sharedNotes({sources,sharing,now:()=>clock.now()});closers.push(notes.close);
  return {people,projects,activity,checkingAgent:options?.checkingAgent,alternateCheckingAgent:options?.alternateCheckingAgent,fields:{...queries.fields,...notes.fields},nextDeadline:queries.nextDeadline,observeDeadlines:queries.observeDeadlines,sweep:queries.sweep,close,
   /** `held` says what the body of a job on anybody else's word is refused and what loom stamps on what it adds
    * (shared-root.ts, from shared-place-mail.ts): such a body adds a memory or a new note, and nothing else here. */
   register(operations:Operations,commands?:Pick<Parameters<typeof registerSemanticMemory>[1],'body'|'hash'|'committed'>&{mayReadFile(viewer:Viewer):boolean},held?:{knowledge(viewer:Viewer):string|undefined;memory:NonNullable<Parameters<typeof registerSemanticMemory>[1]['addsOnly']>;note(viewer:Viewer):Readonly<{overwrite:string;by:string}>|undefined}){
    const knowledge=installMindKnowledgeActions(operations,{path:sources?.commons.knowledge,sharing,verify:verifyKnowledgePages,refused:held?.knowledge});closers.push(knowledge.close);
    // The household's default agent, asked each time: it can be changed in Setup while the program runs.
    const agent=()=>householdSettings(db).defaultAgent??undefined;
    const actions=installMindPeopleActions(operations,{directory:sources?.commons.people,relationship:()=>{const id=agent();return id===undefined?undefined:listed.agents.find(a=>a.agent===id)?.memories;},agent,sharing,create:createPersonHalf,refused:held?.knowledge});closers.push(actions.close);
    if(commands)notes.register(operations,{...commands,addsOnly:held?.note});
    if(commands)closers.push(registerSemanticMemory(operations,{sources,now:()=>clock.now(),embedding,...commands,addsOnly:held?.memory}).close);
   },
  };
 }catch(error){close();throw error;}
}
