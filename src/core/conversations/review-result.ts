import { DAY_MS } from '../day.js';
import { and, eq, gte, inArray, like } from 'drizzle-orm';
import { commsKeepDays } from '../data/comms-days.js';
import { conversations, jobs, messages } from '../data/schema.js';
import type { CommsMessages } from './messages.js';
import { jobMatchesConversation,reviewRequest,reviewThread,REVIEW_BRIEF_EXPIRED,REVIEW_ROLE_CHANGED } from './review-place.js';
import { exitStage, LOOM_EXIT } from '../../runtime/job-exit.js';

/** Seal the thread reply before entering the operation transaction. Retries and concurrent
 * attempts use one result per child. Only the originating private thread can receive it. */
export async function prepareReviewResult(service: CommsMessages, cv: typeof conversations.$inferSelect,
  run: string, words: string, model?: string) {
  const { db } = service, thread = reviewThread(db, cv);
  if (!thread || !cv.member) throw Error('Review destination unavailable');
  const clientId = 'review:' + cv.id;
  const message = await service.prepareSend({thread: thread.id, kind: 'reply', sender: cv.agent,
    run, clientId, words, turn: {model}});
  return () => {
    if (reviewThread(db, cv)?.id !== thread.id) throw Error('Review destination changed');
    const prior = db.select().from(messages).where(and(eq(messages.thread, thread.id), eq(messages.sender, cv.agent), eq(messages.clientId, clientId))).get();
    if (prior) return prior;
    const row = message();
    const item=service.threads.conversations.send({conversation:thread.conversation,toKind:'agent',to:cv.agent,
      source:'handoff',sourceId:clientId,fromKind:'agent',fromId:cv.agent,onWordKind:'member',onWord:cv.member!,thread:thread.id,messageSeq:row.seq});
    return service.attach(row,item);
  };
}

// Restart may interrupt result encryption after the terminal job transaction committed.
export function recentReviewEnds(service: CommsMessages) {
  const cutoff = new Date(Date.parse(service.now()) - commsKeepDays(service.db) * DAY_MS).toISOString();
  return service.db.select({id: jobs.id}).from(conversations)
    .innerJoin(jobs, eq(jobs.conversation, conversations.id))
    .where(and(eq(conversations.venue, 'handoff'), like(conversations.place, '["codex-review",%'),
      inArray(jobs.state, ['done','failed','lost','stopped']), gte(jobs.endedAt, cutoff))).all();
}

export async function reportReviewEnd(service:CommsMessages, id:string, allowed:(member:string,agent:string,project:string|null)=>boolean,
  commit:(write:()=>void)=>void) {
  const db=service.db;
  const ended=db.select({job:jobs,cv:conversations}).from(jobs).innerJoin(conversations,eq(jobs.conversation,conversations.id)).where(eq(jobs.id,id)).get();
  if(!ended || !ended.cv.member || !jobMatchesConversation(ended.job,ended.cv) || !reviewThread(db,ended.cv))return;
  const {job,cv}=ended;
  if(!job.endedAt || Date.parse(service.now())-Date.parse(job.endedAt)>=commsKeepDays(db)*DAY_MS)return;
  const pending=()=>db.select({id:jobs.id}).from(jobs).where(eq(jobs.retryOf,id)).get();
  const thread=reviewThread(db,cv)!;
  if(pending() || !allowed(cv.member!,cv.agent,cv.project) || db.select({seq:messages.seq}).from(messages).where(and(eq(messages.thread,thread.id),eq(messages.sender,cv.agent),eq(messages.clientId,'review:'+cv.id))).get())return;
  const stage=exitStage(job.exitCode,job.exitBy);
  const reason=job.state==='lost'?'worker contact was lost':job.state==='stopped'?'the job was stopped':stage??'the job ended without returning findings';
  const worker=reviewRequest(cv)?.role?.id??'Codex';
  const placementReason = job.exitBy === 'loom' && job.exitCode === LOOM_EXIT.unplaced &&
    (job.endedNote === REVIEW_ROLE_CHANGED || job.endedNote === REVIEW_BRIEF_EXPIRED) ? job.endedNote : undefined;
  const words = worker+' returned no result for “'+cv.label+'”'+(placementReason ? '. '+placementReason : ' ('+reason+').');
  const deliver=await prepareReviewResult(service,cv,id,words);
  commit(()=>{if(!pending() && allowed(cv.member!,cv.agent,cv.project) && reviewThread(db,cv)?.id===thread.id)deliver();});
}
