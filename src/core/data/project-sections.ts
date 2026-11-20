/** Shared-database Project hub metadata. File-backed cards stay in Memory. */
import { asc, desc, sql } from 'drizzle-orm';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from './database.js';
import { taskReadiness } from './task-readiness.js';
import { taskShelved } from './project-in-use.js';
import { taskVisibility } from './visibility.js';
import { workVisibility } from './work-visibility.js';
export function readProjectTasks(db: DataDatabase, viewer: Viewer) {
 const policy=taskVisibility(viewer);
 const rows=db.query.tasks.findMany({extras:f=>({
  ready:sql`${{getSQL:()=>taskReadiness(f)}}`.mapWith(Boolean).as('project_task_ready'),
  shelved:sql`${{getSQL:()=>taskShelved(f)}}`.mapWith(Boolean).as('project_task_shelved'),
 }),where:f=>sql`${{getSQL:()=>policy.tasks!(f)}}`,orderBy:f=>[asc(f.priority),asc(f.position),asc(f.id)]}).sync();
 const comments=db.query.taskComments.findMany({columns:{task:true,at:true},where:f=>sql`${{getSQL:()=>policy.taskComments!(f)}}`}).sync();
 const links=db.query.taskLinks.findMany({columns:{task:true,dependsOn:true,type:true},where:f=>sql`${{getSQL:()=>policy.taskLinks!(f)}}`}).sync();
 const byTask=new Map<string,Array<{at:string}>>();
 for(const row of comments){const items=byTask.get(row.task)??[];items.push({at:row.at});byTask.set(row.task,items);}
 return {rows,ready:new Set(rows.filter(row=>row.ready).map(row=>row.id)),comments:(id:string)=>byTask.get(id)??[],links:links.map(row=>({id:row.task,dependsOn:row.dependsOn,type:row.type}))};
}
export function readProjectChanges(db: DataDatabase, viewer: Viewer) {
 return db.query.changes.findMany({columns:{id:true,title:true,repository:true,project:true,waitingOn:true,state:true,checks:true,updatedAt:true,authorLogin:true},where:f=>sql`${{getSQL:()=>workVisibility(viewer).changes!(f)}}`,orderBy:f=>[desc(f.updatedAt),asc(f.id)]}).sync();
}
