/** Home job metadata using the outside composition's current SQL policy. */
import {and,asc,eq,inArray,is,SQL,sql,getTableColumns} from 'drizzle-orm';
import type {DataDatabase} from './database.js';
import type {QueryVisibility} from './queries.js';
import {jobs} from './schema.js';
export function readCurrentJobs(db:DataDatabase,visibility:QueryVisibility,agent:string){
 const allowed=visibility.jobs?.(getTableColumns(jobs));
 if(!is(allowed,SQL))throw new Error('SQL visibility required for jobs');
 return db.query.jobs.findMany({columns:{id:true,agent:true,title:true,state:true,box:true,queuedAt:true},where:f=>and(sql`${{getSQL:()=>allowed}}`,eq(f.agent,agent),inArray(f.state,['queued','starting','running','waiting'])),orderBy:f=>[asc(f.queuedAt),asc(f.id)]}).sync();
}
