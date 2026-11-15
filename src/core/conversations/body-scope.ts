/** Fresh assigned-body provenance. This confers no general registry read or
 * member identity. Only the root's exact authenticated Viewer proof qualifies. */
import { eq } from 'drizzle-orm';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from '../data/database.js';
import { conversations, jobs } from '../data/schema.js';
export type BodyProof = (viewer: Viewer) => Readonly<{job:string;agent:string;box:string}> | undefined;
export function conversationBodyScope(db:DataDatabase,proof:BodyProof,privateAssignment:(scope:{member:string;agent:string;project?:string})=>boolean) {
 return (viewer:Viewer)=>{
  const body=proof(viewer);if(!body)return;
  const job=db.select().from(jobs).where(eq(jobs.id,body.job)).get();
  if(!job?.conversation||job.state!=='running'||job.agent!==body.agent||job.box!==body.box)return;
  const cv=db.select().from(conversations).where(eq(conversations.id,job.conversation)).get();
  if(!cv||cv.job!==job.id||cv.agent!==job.agent||cv.member!==job.member||cv.project!==job.project)return;
  if(cv.member&&!privateAssignment({member:cv.member,agent:cv.agent,project:cv.project??undefined}))return;
  return {job,cv};
 };
}
