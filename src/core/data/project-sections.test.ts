import Database from 'better-sqlite3';
import {afterEach,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {createDataSchema} from './database.js';
import {members,agents,projects,projectMembers,taskLinks,changes} from './schema.js';
import {taskService} from '../../apps/tasks.js';
import {sharedProjectSections} from '../../shared-memory-projects.js';
import type {ProjectQuery} from '../../pieces/mind/projects-roles.js';
const clients:Database.Database[]=[];
afterEach(()=>{for(const client of clients.splice(0))client.close();});
it('bounds Project task and change batches while hidden dependencies still block visible work',()=>{
 const statements:string[]=[],client=new Database(':memory:',{verbose:s=>statements.push(s)});clients.push(client);
 const now='2026-11-14T18:00:00.000Z',db=createDataSchema(client,()=>now);
 db.insert(members).values([{id:'owner',role:'owner',joinedAt:now},{id:'peer',role:'member',joinedAt:now}]).run();
 db.insert(agents).values({id:'art',about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble',faceEyes:'dot'}).run();
 db.insert(projects).values({id:'pond',name:'Pond'}).run();db.insert(projectMembers).values({project:'pond',member:'peer'}).run();
 const service=taskService(db,()=>now),sections=sharedProjectSections(db),viewer={kind:'member' as const,id:'peer'};
 const q={names:['pond'],card:{links:{}},since:'2026-11-07T00:00:00.000Z',now:Date.parse(now)} as ProjectQuery;
 const hidden=service.create({title:'PRIVATE BLOCKER',goal:'Private',why:'Private',owner:{kind:'member',id:'owner'}},{kind:'member',id:'owner'});
 let taskCount=0,changeCount=0,blocked='';
 for(let n=0;n<10;n++){
  const task=service.create({title:'Work '+n,goal:'Goal',why:'Why',project:'pond',owner:{kind:'member',id:'peer'}},viewer);service.comment(task.id,'Private prose is not needed for the project tally',viewer);
  if(n===0){blocked=task.id;service.link(task.id,hidden.id,'blocks');}
  db.insert(changes).values({id:'change-'+n,repository:'owner/repo',number:n+1,title:'Change '+n,body:'',url:'https://example.invalid/change/'+n,state:'open',draft:false,authorLogin:'writer',project:'pond',branch:'next',headCommit:'head',baseBranch:'next',checks:'passing',review:'approved',mergeable:'yes',waitingOn:'agent',openedAt:now,updatedAt:now}).run();
  if(n===1||n===9){
   statements.length=0;const tasks=sections.tasks.read(viewer,q);const reads=statements.filter(s=>/^select|^with/i.test(s.trim())).length;
   if(n===1)taskCount=reads;else expect(reads).toBe(taskCount);
   expect(JSON.stringify(tasks)).not.toContain('PRIVATE BLOCKER');expect(tasks.groups?.find(g=>g.title==='Blocked or in progress')?.items.map(i=>i.ref)).toContain(blocked);
   statements.length=0;const result=sections.changes.read(viewer,q),count=statements.filter(s=>/^select|^with/i.test(s.trim())).length;
   if(n===1)changeCount=count;else expect(count).toBe(changeCount);
   expect(result.groups?.flatMap(g=>g.items)).toHaveLength(n+1);
  }
 }
 expect(taskCount).toBe(4);expect(changeCount).toBe(1);
 service.close(hidden.id,'done');expect(sections.tasks.read(viewer,q).groups?.find(g=>g.title==='Ready')?.items.map(i=>i.ref)).toContain(blocked);
 db.delete(projectMembers).where(eq(projectMembers.member,'peer')).run();expect(sections.tasks.read(viewer,q).groups).toEqual([]);expect(sections.changes.read(viewer,q).groups).toEqual([]);
 expect(db.select().from(taskLinks).all()).toHaveLength(1);
});
