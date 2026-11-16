/** Shared-database Project hub metadata. File-backed cards stay in Memory. */
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from './database.js';
import { tasks, taskLinks } from './schema.js';
import { alias } from 'drizzle-orm/sqlite-core';
import { taskVisibility } from './visibility.js';
import { workVisibility } from './work-visibility.js';
export function readProjectTasks(db: DataDatabase, viewer: Viewer) {
 const policy=taskVisibility(viewer);
 const rows=db.query.tasks.findMany({where:f=>sql`${{getSQL:()=>policy.tasks!(f)}}`,orderBy:f=>[asc(f.priority),asc(f.position),asc(f.id)]}).sync();
 const comments=db.query.taskComments.findMany({columns:{task:true,at:true},where:f=>sql`${{getSQL:()=>policy.taskComments!(f)}}`}).sync();
 const links=db.query.taskLinks.findMany({columns:{task:true,dependsOn:true,type:true},where:f=>sql`${{getSQL:()=>policy.taskLinks!(f)}}`}).sync();
 // Hidden open dependencies still block visible work; only ready visible IDs leave.
 const blocker=alias(tasks,'project_blocker');
 const ready=db.query.tasks.findMany({columns:{id:true},where:f=>and(sql`${{getSQL:()=>policy.tasks!(f)}}`,eq(f.status,'open'),ne(f.type,'epic'),sql`${{getSQL:()=>sql`not exists(select 1 from ${taskLinks} join ${tasks} as ${sql.identifier('project_blocker')} on ${blocker.id}=${taskLinks.dependsOn} where ${taskLinks.task}=${f.id} and ${taskLinks.type}='blocks' and ${blocker.status}<>'closed')`}}`)}).sync();
 const byTask=new Map<string,Array<{at:string}>>();
 for(const row of comments){const items=byTask.get(row.task)??[];items.push({at:row.at});byTask.set(row.task,items);}
 return {rows,ready:new Set(ready.map(row=>row.id)),comments:(id:string)=>byTask.get(id)??[],links:links.map(row=>({id:row.task,dependsOn:row.dependsOn,type:row.type}))};
}
export function readProjectChanges(db: DataDatabase, viewer: Viewer) {
 return db.query.changes.findMany({columns:{id:true,title:true,repository:true,project:true,waitingOn:true,state:true,checks:true,updatedAt:true,authorLogin:true},where:f=>sql`${{getSQL:()=>workVisibility(viewer).changes!(f)}}`,orderBy:f=>[desc(f.updatedAt),asc(f.id)]}).sync();
}
