/** Memory stays in declared source files. Existing store/action modules own
 * their schema and retry receipts; this creates no legacy loom tables. */
import {existsSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import type {DataDatabase} from './core/data/database.js';
import type {Clock} from './core/clock.js';
import type {Operations} from './core/operations/index.js';
import {household} from './core/data/schema.js';
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
import {sharedSharing} from './shared-sharing.js';
export interface SharedMemoryOptions {
 sources:MindSources;
 sections?:{tasks?:ProjectSectionRole;notes?:ProjectSectionRole;conversations?:ProjectSectionRole;changes?:ProjectSectionRole};
}
/** Fresh declared files only. Existing precious files, including their schema,
 * are left to their existing owner. Run before readers and touch listeners. */
export async function prepareSharedMemorySources(options:SharedMemoryOptions|undefined){
 if(!options)return;
 const {commons,agents}=options.sources;
 for(const path of [commons.knowledge,commons.people,...agents.map(a=>a.memories)])mkdirSync(dirname(path),{recursive:true});
 if(!existsSync(commons.knowledge)){
  const knowledge=new SqliteKnowledgeBackend({dbPath:commons.knowledge});
  try{await knowledge.getPage('bootstrap-probe');}finally{knowledge.close();}
 }
 if(!existsSync(commons.people))new PeopleStore({dbPath:commons.people}).close();
 for(const agent of agents)if(!existsSync(agent.memories)){
  new PeopleStore({dbPath:agent.memories,actor:agent.agent}).close();
  new ProjectsStore({dbPath:agent.memories}).close();
 }
}
export function sharedMemory(db:DataDatabase,clock:Clock,options:SharedMemoryOptions|undefined){
 const closers:Array<()=>void>=[];let closed=false;
 const close=()=>{if(closed)return;closed=true;const errors:unknown[]=[];for(const stop of closers.splice(0).reverse())try{stop();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'Memory teardown failed');};
 const sharing=()=>sharedSharing(db),sources=options?.sources,agents=sources?.agents??[];
 const settings=db.select().from(household).get();
 const conversationHref=(id:string)=>'/p/comms-preview/conversation/'+encodeURIComponent(id);
 const projectHref=(agent:string,slug:string)=>'/p/projects-preview/project/'+encodeURIComponent(agent+':'+slug);
 try{
  const people=peopleReader({directory:sources?.commons.people,agents,sharing,now:()=>clock.now(),projectHref});closers.push(people.close);
  const projects=createProjectsReader(clock,{agents,sharing,people,...options?.sections});closers.push(projects.close);
  const activity=createActivityReader(clock,{agents,sharing,timezone:settings?.timezone??'UTC',github:settings?.githubOwner,conversations:sharedActivityConversations(db,{sharing,conversationHref})});closers.push(activity.close);
  const queries=memoryQueryFields(db,{sources,sharing,now:()=>clock.now(),mind:projects,activity,conversationHref,projectHref});closers.push(queries.close);
  const touches=mindTouchSources(sources);
  return {fields:queries.fields,nextDeadline:queries.nextDeadline,observeDeadlines:queries.observeDeadlines,sweep:queries.sweep,touches,close,
   register(operations:Operations){
    installTouched(operations,mindTouchResolver(touches));
    const knowledge=installMindKnowledgeActions(operations,{path:sources?.commons.knowledge,sharing,verify:verifyKnowledgePages,classify:domain=>deriveSlaClass(null,domain)});closers.push(knowledge.close);
    const agent=settings?.defaultAgent??undefined;
    const actions=installMindPeopleActions(operations,{directory:sources?.commons.people,relationship:agents.find(a=>a.agent===agent)?.memories,agent,sharing,create:createPersonHalf});closers.push(actions.close);
   },
  };
 }catch(error){close();throw error;}
}
