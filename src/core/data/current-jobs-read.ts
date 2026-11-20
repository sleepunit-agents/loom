/** The current job summaries visible to this caller, in stable queue order. */
import {and,asc,eq,inArray,isNotNull,ne,or,sql,type SQL} from 'drizzle-orm';
import type {DataDatabase} from './database.js';
import {unendedJobStates} from './job-states.js';

export function readCurrentJobs(db:DataDatabase,allowed:SQL,agent:string,cutoff:string){
 return db.query.jobs.findMany({
  columns:{id:true,agent:true,title:true,state:true,box:true,queuedAt:true},
  extras:fields=>({kind:sql<string>`case when ${fields.startedByKind} = 'terminal' then 'terminal' else 'job' end`.as('current_job_kind')}),
  where:fields=>and(sql`${{getSQL:()=>allowed}}`,eq(fields.agent,agent),inArray(fields.state,unendedJobStates),
   or(ne(fields.startedByKind,'terminal'),and(isNotNull(fields.conversation),sql`julianday(${fields.heardAt}) > julianday(${cutoff})`))),
  orderBy:fields=>[asc(fields.queuedAt),asc(fields.id)],
 }).sync();
}
