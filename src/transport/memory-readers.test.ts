/** Typed Memory ports on the real shared data door, with no legacy registries. */
import {it,expect} from 'vitest';
import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {eq} from 'drizzle-orm';
import {FakeClock} from '../core/clock.js';
import type {Sharing} from '../policy.js';
import {createDataSchema} from '../core/data/database.js';
import {members,agents,tokens,memberAgents,tasks} from '../core/data/schema.js';
import {Conversations} from '../core/conversations/index.js';
import {nextData} from '../next-data.js';
import {SqliteKnowledgeBackend} from '../backends/sqlite-knowledge.js';
import {PeopleStore} from '../backends/people.js';
import {ProjectsStore} from '../backends/projects.js';
import {peopleReader} from '../pieces/mind/people.js';
import {createProjectsReader} from '../pieces/mind/projects.js';
import {createActivityReader} from '../pieces/mind/activity.js';
import {sharedActivityConversations} from '../pieces/mind/activity-conversations.js';
import {memoryQueryFields} from './memory-queries.js';
it('serves all four Memory projections without legacy tables and rereads current shared membership',async()=>{
 const home=mkdtempSync(join(tmpdir(),'memory-readers-')),client=new Database(':memory:'),db=createDataSchema(client),clock=new FakeClock(),at=new Date(clock.now()).toISOString(),raw='f'.repeat(64);
 db.insert(members).values({id:'owner',role:'owner',joinedAt:at}).run();db.insert(agents).values({id:'fiction',about:'',markBg:'',markFg:'',faceShape:'pebble',faceEyes:'dot'}).run();
 db.insert(tokens).values({fingerprint:createHash('sha256').update(raw).digest('hex'),label:'Fictional bearer',kind:'owner',member:'owner',createdAt:at}).run();
 db.insert(tasks).values({id:'work',title:'Fictional task',ownerKind:'household',createdByKind:'member',createdBy:'owner',createdAt:at,changedAt:at}).run();
 const commons=join(home,'commons'),directory=join(home,'agents/fiction'),memories=join(directory,'memories.db');mkdirSync(commons,{recursive:true});mkdirSync(directory,{recursive:true});
 const knowledge=new SqliteKnowledgeBackend({dbPath:join(commons,'knowledge.db')});await knowledge.writePage({slug:'pump',title:'Fictional pump',domain:'fiction',body:'Fictional knowledge'});
 const peopleStore=new PeopleStore({dbPath:memories,actor:'fiction'});peopleStore.write({slug:'friend',name:'Private fictional friend',where:{pond:{value:'Fictional relationship'}}});peopleStore.close();
 const projectsStore=new ProjectsStore({dbPath:memories});projectsStore.write({slug:'pond',name:'Private fictional pond'});projectsStore.close();
 // This callback is the root's required current-facts seam, not a mirrored
 // legacy fixture. Demotion and revocation below mutate only shared columns.
 const sharing=():Sharing=>({members:Object.fromEntries(db.select().from(members).all().map(m=>[m.id,{owner:m.role==='owner',agents:db.select().from(memberAgents).where(eq(memberAgents.member,m.id)).all().map(a=>a.agent)}])),projects:{},services:{}});
 const sources={commons:{directory:commons,knowledge:join(commons,'knowledge.db'),people:join(commons,'people.db')},agents:[{agent:'fiction',directory,memories}]};
 const tables=()=>client.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all(),before=tables();
 const people=peopleReader({...sources.commons,directory:sources.commons.people,agents:sources.agents,sharing,now:()=>clock.now()});
 const projects=createProjectsReader(clock,{agents:sources.agents,sharing,people});
 const conversations=new Conversations(db,()=>new Date(clock.now()).toISOString());conversations.open({agent:'fiction',venue:'wake',place:'fiction',label:'Private fictional session'});
 const activity=createActivityReader(clock,{agents:sources.agents,sharing,timezone:'America/Chicago',conversations:sharedActivityConversations(db,{sharing})});
 const queries=memoryQueryFields(db,{sources,sharing,now:()=>clock.now(),projects,activity,conversationHref:id=>'/conversation/'+id,projectHref:(_agent,slug)=>'/project/'+slug});
 const data=nextData(db,clock,()=>true,undefined,queries.fields);
 try{
  const query='{ tasks { title } memoryKnowledge { pages { title } } memoryPerson(id:"fiction:friend") { name } memoryProject(id:"fiction:pond") { name sections { key available items { title } } } memoryActivity { entries { title } } }';
  const read=async()=>{const response=await data.http.request('http://loom/graphql',{method:'POST',headers:{authorization:'Bearer '+raw,'content-type':'application/json'},body:JSON.stringify({query})});expect(response.status).toBe(200);const result=await response.json();expect(result.errors).toBeUndefined();return result.data;};
  expect(await read()).toMatchObject({tasks:[{title:'Fictional task'}],memoryKnowledge:{pages:[{title:'Fictional pump'}]},memoryPerson:{name:'Private fictional friend'},memoryProject:{name:'Private fictional pond',sections:expect.arrayContaining([{key:'people',available:true,items:[{title:'Private fictional friend'}]}])},memoryActivity:{entries:[{title:'Private fictional session'}]}});
  expect(tables()).toEqual(before);
  db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run();data.changed();
  expect(await read()).toEqual({tasks:[],memoryKnowledge:null,memoryPerson:null,memoryProject:null,memoryActivity:null});
  db.insert(memberAgents).values({member:'owner',agent:'fiction'}).run();data.changed();
  expect(await read()).toMatchObject({tasks:[],memoryKnowledge:null,memoryPerson:{name:'Private fictional friend'},memoryProject:{name:'Private fictional pond'},memoryActivity:{entries:[{title:'Private fictional session'}]}});
  db.delete(memberAgents).run();data.changed();expect(await read()).toEqual({tasks:[],memoryKnowledge:null,memoryPerson:null,memoryProject:null,memoryActivity:null});
  expect(tables()).toEqual(before);
 }finally{await data.close();queries.close();activity.close();projects.close();people.close();knowledge.close();client.close();rmSync(home,{recursive:true,force:true});}
});
