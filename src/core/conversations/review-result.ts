import { DAY_MS } from '../day.js';
import { and, eq, gte, inArray, like } from 'drizzle-orm';
import { commsKeepDays } from '../data/comms-days.js';
import { conversations, frozenReviewResults, jobs, messages } from '../data/schema.js';
import type { CommsMessages } from './messages.js';
import { MESSAGE_WORDS_MAX } from './words.js';
import { jobMatchesConversation,reviewRequest,reviewThread,reviewBriefExpired,REVIEW_ROLE_CHANGED } from './review-place.js';
import { exitStage, LOOM_EXIT } from '../../runtime/job-exit.js';
import { failureOf, failureWords } from '../../runtime/job-failure.js';
import { householdTimezone } from '../data/household-settings.js';
import { frozenReview, type ReviewTarget } from './review-place.js';
import { changeReviewStore, replyVerdict, NO_VERDICT, TREE_CHANGED } from '../../apps/change-reviews.js';
import { FROZEN_REVIEW_REPLY } from './review-confinement.js';
import { OperationError } from '../operations/index.js';

/** Why a frozen review has no verdict, in loom's fixed words, for the round and the asking thread. */
export const FROZEN_NO_TREE = 'The worker did not report the reviewed files at the end of the round, so loom cannot say the reviewer read the commit it was given.';
export const FROZEN_NO_ANSWER = 'The reviewer gave no answer.';
/** What a frozen review's round records in place of the reviewer's words, which are kept only sealed (finding 9). */
export const FROZEN_FINDINGS_SEALED = 'The reviewer\'s findings are kept sealed with the conversation that asked for this review.';

type EndedJob = Pick<typeof jobs.$inferSelect,'state'|'exitCode'|'exitBy'|'failedReason'|'failedDetail'|'endedNote'>;
/** How a frozen review ended, by one rule: a verdict exists only when its job ended with exit 0, the worker reported
 * the copy's fingerprints equal, and the body program's final answer ends with a verdict line. Every other ending is
 * no verdict, with the reason. Decided only once the job has ended (reportFrozenReviewEnd). */
export function frozenReviewEnding(job: EndedJob, tree: string | null, answer: string | undefined, zone: string):
  { verdict: 'CLEAR' | 'BLOCKING' } | { verdict: 'NONE'; reason: string } {
  if (job.state !== 'done' || job.exitCode !== 0) {
    const unplaced = job.exitBy === 'loom' && job.exitCode === LOOM_EXIT.unplaced && job.endedNote;
    return { verdict: 'NONE', reason: unplaced ? job.endedNote! : `The review job did not finish (${reviewEndReason(job, zone)}).` };
  }
  if (tree === 'changed') return { verdict: 'NONE', reason: TREE_CHANGED };
  if (tree !== 'same') return { verdict: 'NONE', reason: FROZEN_NO_TREE };
  if (answer === undefined) return { verdict: 'NONE', reason: FROZEN_NO_ANSWER };
  const verdict = replyVerdict(answer);
  return verdict ? { verdict } : { verdict: 'NONE', reason: NO_VERDICT };
}

/** What the asking thread is told of a frozen review, once it has ended: what was reviewed and the verdict loom filed,
 * then the reviewer's answer. With no verdict, the reason first, and the answer, if any, said to be none. Bounded like a
 * reply: the answer is cut by its end, never the line. */
export function frozenReviewWords(target: Pick<ReviewTarget,'repository'|'head'>, ending: ReturnType<typeof frozenReviewEnding>, answer?: string): string {
  const what = `${target.repository}@${target.head.slice(0, 12)}`;
  const words = ending.verdict !== 'NONE' ? `Frozen review of ${what}: VERDICT ${ending.verdict}.\n\n${answer ?? ''}`
    : `Frozen review of ${what}: NO VERDICT. ${ending.reason}` + (answer !== undefined ? `\n\nThe reviewer's answer, which loom did not take as a verdict:\n\n${answer}` : '');
  return words.slice(0, MESSAGE_WORDS_MAX);
}

/** A frozen review's reply (conversation.message, body-output.ts): the body program's final answer, under the one
 * clientId it is sent with. It is no verdict yet: it is sealed and held, and filed and relayed only once the job has
 * ended (reportFrozenReviewEnd). Held once: another answer for the same job is refused. */
export async function prepareFrozenAnswer(service: CommsMessages, job: string, clientId: string, words: string, model?: string) {
  if (clientId !== FROZEN_REVIEW_REPLY) throw new OperationError('invalid', 'A frozen review answers once, with its final answer');
  const { db } = service, sealed = await service.key.seal(words);
  return () => {
    const held = db.select({ answeredAt: frozenReviewResults.answeredAt, filedAt: frozenReviewResults.filedAt }).from(frozenReviewResults).where(eq(frozenReviewResults.job, job)).get();
    if (held?.answeredAt || held?.filedAt) throw new OperationError('conflict', 'This review has already answered');
    db.insert(frozenReviewResults).values({ job, answer: sealed, model: model ?? null, answeredAt: service.now() })
      .onConflictDoUpdate({ target: frozenReviewResults.job, set: { answer: sealed, model: model ?? null, answeredAt: service.now() } }).run();
    return { seq: 0 };
  };
}

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

/** Why a handed-off job returned nothing, for the line its parent thread is told: how it ended, the stage its exit
 * code names, and, where the job's row says why it failed (runtime/job-failure.ts), that in plain words. Those words
 * are built from a fixed reason and its numbers, never from anything the harness printed. Times are said in `zone`. */
export function reviewEndReason(job:Pick<typeof jobs.$inferSelect,'state'|'exitCode'|'exitBy'|'failedReason'|'failedDetail'>,zone:string):string{
  const stage=exitStage(job.exitCode,job.exitBy),failure=failureOf(job),why=failure?failureWords(failure,zone):undefined;
  return job.state==='lost'?'worker contact was lost':job.state==='stopped'?'the job was stopped':stage?(why?stage+': '+why:stage):why??'the job ended without returning findings';
}

export async function reportReviewEnd(service:CommsMessages, id:string, allowed:(member:string,agent:string,project:string|null)=>boolean,
  commit:(write:()=>void)=>void) {
  const db=service.db;
  const ended=db.select({job:jobs,cv:conversations}).from(jobs).innerJoin(conversations,eq(jobs.conversation,conversations.id)).where(eq(jobs.id,id)).get();
  if(!ended || !ended.cv.member || !jobMatchesConversation(ended.job,ended.cv))return;
  if(!frozenReview(ended.cv) && !reviewThread(db,ended.cv))return;
  const {job,cv}=ended;
  const frozen=frozenReview(cv);
  if(frozen)return reportFrozenReviewEnd(service,job,cv,frozen,allowed,commit);
  if(!job.endedAt || Date.parse(service.now())-Date.parse(job.endedAt)>=commsKeepDays(db)*DAY_MS)return;
  const pending=()=>db.select({id:jobs.id}).from(jobs).where(eq(jobs.retryOf,id)).get();
  const thread=reviewThread(db,cv)!;
  if(pending() || !allowed(cv.member!,cv.agent,cv.project) || db.select({seq:messages.seq}).from(messages).where(and(eq(messages.thread,thread.id),eq(messages.sender,cv.agent),eq(messages.clientId,'review:'+cv.id))).get())return;
  const reason=reviewEndReason(job,householdTimezone(db));
  const worker=reviewRequest(cv)?.role?.id??'Codex';
  const placementReason = job.exitBy === 'loom' && job.exitCode === LOOM_EXIT.unplaced &&
    (job.endedNote === REVIEW_ROLE_CHANGED || job.endedNote === reviewBriefExpired(cv)) ? job.endedNote : undefined;
  const words = worker+' returned no result for “'+cv.label+'”'+(placementReason ? '. '+placementReason : ' ('+reason+').');
  const deliver=await prepareReviewResult(service,cv,id,words);
  commit(()=>{if(!pending() && allowed(cv.member!,cv.agent,cv.project) && reviewThread(db,cv)?.id===thread.id)deliver();});
}

/** A frozen review's ending, filed and relayed once its job has ended, whichever way it ended (Jobs.end tells loom of
 * every one: shared-root.ts, jobEnded; and recentReviewEnds after a restart). Its verdict is decided here and nowhere
 * else (frozenReviewEnding), filed on its round when it has one and on its own record always, and relayed to the asking
 * thread in the same write. Once: a record already filed is left as it is, and the relay is keyed by its conversation.
 * The round is filed even when the thread can no longer be told (it is gone, or past its keep time). */
async function reportFrozenReviewEnd(service:CommsMessages,job:typeof jobs.$inferSelect,cv:typeof conversations.$inferSelect,target:ReviewTarget,
  allowed:(member:string,agent:string,project:string|null)=>boolean,commit:(write:()=>void)=>void){
  const db=service.db;
  if(!job.endedAt)return;
  const record=()=>db.select().from(frozenReviewResults).where(eq(frozenReviewResults.job,job.id)).get();
  const before=record();
  if(before?.filedAt)return;
  const answer=before?.answer?await service.key.open(before.answer):undefined;
  const ending=frozenReviewEnding(job,before?.tree??null,answer,householdTimezone(db));
  const thread=reviewThread(db,cv);
  const fresh=Date.parse(service.now())-Date.parse(job.endedAt)<commsKeepDays(db)*DAY_MS;
  const tell=()=>!!thread&&!!cv.member&&fresh&&allowed(cv.member,cv.agent,cv.project)&&reviewThread(db,cv)?.id===thread.id;
  const relay=tell()?await prepareReviewResult(service,cv,job.id,frozenReviewWords(target,ending,answer),before?.model??undefined):undefined;
  commit(()=>{
    const now=record();
    if(now?.filedAt || (now?.answeredAt??null)!==(before?.answeredAt??null) || (now?.tree??null)!==(before?.tree??null))return;
    const at=service.now();
    db.insert(frozenReviewResults).values({job:job.id,verdict:ending.verdict,filedAt:at,answer:null})
      .onConflictDoUpdate({target:frozenReviewResults.job,set:{verdict:ending.verdict,filedAt:at,answer:null}}).run();
    changeReviewStore(db,service.now).fileFrozen(job.id,ending.verdict,ending.verdict==='NONE'?ending.reason:`VERDICT ${ending.verdict}. ${FROZEN_FINDINGS_SEALED}`);
    if(relay&&tell())relay();
  });
}
