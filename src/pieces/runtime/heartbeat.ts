/** Body/runner liveness is separate from administrative job writes. */
import type { Db } from '../../core/index.js';
export function hearJob(db:Db,job:string,now:number) {
 if(!db.inTransaction)throw new Error('Job heartbeat requires the caller transaction');
 db.prepare('INSERT INTO runtime_job_heartbeats(job,heard_at) VALUES (?,?) ON CONFLICT(job) DO UPDATE SET heard_at=excluded.heard_at').run(job,now);
}
export function jobHeard(db:Db,job:string):number|undefined {
 return (db.prepare('SELECT heard_at FROM runtime_job_heartbeats WHERE job=?').get(job) as {heard_at:number}|undefined)?.heard_at;
}
