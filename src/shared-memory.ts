/** Memory stays in declared source files. Existing store/action modules own
 * their schema and retry receipts; this creates no legacy loom tables. */
import {mkdirSync,openSync,closeSync} from 'node:fs';
import Database from 'better-sqlite3';
import {dirname} from 'node:path';
import type {DataDatabase} from './core/data/database.js';
import {eq} from 'drizzle-orm';
import type {Clock} from './core/clock.js';
import type {Operations} from './core/operations/index.js';
import {household,agents as agentRows} from './core/data/schema.js';
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
import {verifyKnowledgePages,deriveSlaClass} from './backends/knowledge-verification.js';
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
 * are left to their existing owner. Run before readers and touch listeners. */
export async function prepareSharedMemorySources(options:SharedMemoryOptions|undefined){
 if(!options)return;
 const {commons,agents}=options.sources;
 const prepareReceipts=(path:string)=>{const db=new Database(path,{fileMustExist:true});try{migrateMindReceipts(db);}finally{db.close();}};
 const fresh=async(path:string,initialise:()=>void|Promise<void>)=>{
  try{closeSync(openSync(path,'wx',0o600));}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')return;throw error;}
  await initialise();prepareReceipts(path);
 };
 for(const path of [commons.knowledge,commons.people,...agents.map(a=>a.memories)])mkdirSync(dirname(path),{recursive:true});
 await fresh(commons.knowledge,async()=>{
  const knowledge=new SqliteKnowledgeBackend({dbPath:commons.knowledge});
  try{await knowledge.getPage('bootstrap-probe');}finally{knowledge.close();}
 });
 await fresh(commons.people,()=>{new PeopleStore({dbPath:commons.people}).close();});
 for(const agent of agents)await fresh(agent.memories,()=>{
  new PeopleStore({dbPath:agent.memories,actor:agent.agent}).close();
  new ProjectsStore({dbPath:agent.memories}).close();
  const db=new Database(agent.memories,{fileMustExist:true});try{prepareSemanticMemory(db);}finally{db.close();}
 });
}
export function validateSharedMemoryOptions(db:DataDatabase,options:SharedMemoryOptions|undefined){
 if(options&&(typeof options.checkingAgent!=='string'||!options.checkingAgent.trim()||!db.select().from(agentRows).where(eq(agentRows.id,options.checkingAgent)).get()))throw new Error('Memory needs an explicit configured checking agent');
}
export function sharedMemory(db:DataDatabase,clock:Clock,options:SharedMemoryOptions|undefined,tasks:Pick<TaskService,'ready'>){
 validateSharedMemoryOptions(db,options);
 const closers:Array<()=>void>=[];let closed=false;
 const close=()=>{if(closed)return;closed=true;const errors:unknown[]=[];for(const stop of closers.splice(0).reverse())try{stop();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'Memory teardown failed');};
 const sharing=()=>sharedSharing(db),sources=options?.sources,agents=sources?.agents??[];
 const settings=db.select().from(household).get();
 const conversationHref=(id:string)=>'/p/comms-preview/conversation/'+encodeURIComponent(id);
 const projectHref=(agent:string,slug:string)=>'/p/projects-preview/project/'+encodeURIComponent(agent+':'+slug);
 try{
  const people=peopleReader({directory:sources?.commons.people,agents,sharing,now:()=>clock.now(),projectHref});closers.push(people.close);
  const projects=createProjectsReader(clock,{agents,sharing,people,...sharedProjectSections(db,tasks),...options?.sections});closers.push(projects.close);
  const activity=createActivityReader(clock,{agents,sharing,timezone:()=>db.select().from(household).get()?.timezone??'UTC',github:settings?.githubOwner,conversations:sharedActivityConversations(db,{sharing,conversationHref})});closers.push(activity.close);
  const queries=memoryQueryFields(db,{sources,sharing,now:()=>clock.now(),timezone:()=>db.select().from(household).get()?.timezone??'UTC',projects,activity,conversationHref,projectHref});closers.push(queries.close);
  const touches=mindTouchSources(sources);
  return {people,projects,activity,checkingAgent:options?.checkingAgent,fields:queries.fields,nextDeadline:queries.nextDeadline,observeDeadlines:queries.observeDeadlines,sweep:queries.sweep,touches,close,
   register(operations:Operations,commands?:Pick<Parameters<typeof registerSemanticMemory>[1],'body'|'hash'|'committed'>){
    installTouched(operations,mindTouchResolver(touches));
    const knowledge=installMindKnowledgeActions(operations,{path:sources?.commons.knowledge,sharing,verify:verifyKnowledgePages,classify:domain=>deriveSlaClass(null,domain)});closers.push(knowledge.close);
    const agent=settings?.defaultAgent??undefined;
    const actions=installMindPeopleActions(operations,{directory:sources?.commons.people,relationship:agents.find(a=>a.agent===agent)?.memories,agent,sharing,create:createPersonHalf});closers.push(actions.close);
    if(commands)closers.push(registerSemanticMemory(operations,{sources,now:()=>clock.now(),...commands}).close);
   },
  };
 }catch(error){close();throw error;}
}
