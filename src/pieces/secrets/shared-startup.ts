/** Trusted runtime startup seam. Alias configuration selects delivery names;
 * explicit at_start rules grant them. A durable use id prevents ambiguous or
 * failed starts from automatically handing the same value out twice. */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DataDatabase } from '../../core/data/database.js';
import { jobs, agentHouseSecrets } from '../../core/data/schema.js';
import type { SecretRequests } from './requests.js';
import type { SecretDelivery } from './delivery.js';
export class SecretStartup {
 private closed=false;
 constructor(private db:DataDatabase,private requests:SecretRequests,private delivery:SecretDelivery,
  private commit:<T>(write:()=>T)=>T){}
 async handTo(jobId:string){
  if(this.closed||this.db.$client.inTransaction)throw Error('Secret startup unavailable');
  const names=this.commit(()=>{
   const job=this.db.select({agent:jobs.agent}).from(jobs).where(eq(jobs.id,jobId)).get();
   if(!job)throw Error('Secret startup needs an existing job');
   const selected=new Set(this.db.select({secret:agentHouseSecrets.secret}).from(agentHouseSecrets).where(eq(agentHouseSecrets.agent,job.agent)).all().map(row=>row.secret));
   return this.requests.grantAtStart(jobId).filter(grant=>selected.has(grant.secret)).map(grant=>grant.secret);
  });
  const results=[];
  for(const secret of names){
   if(this.closed)throw Error('Secret startup unavailable');
   const id='use-start-'+createHash('sha256').update(JSON.stringify([jobId,secret])).digest('hex');
   results.push(await this.delivery.handTo(secret,jobId,id));
  }
  return results;
 }
 close(){this.closed=true;}
}
