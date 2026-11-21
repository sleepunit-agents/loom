/** Offline phase of a household move. Thread identities and the old Comms key must already be staged. */
import type Database from 'better-sqlite3';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { archivedQuestions, conversations, threads } from '../core/data/schema.js';
import type { DataDatabase } from '../core/data/database.js';
import { commsKeepDays } from '../core/data/comms-days.js';
import { keepUntilFor, validKeepDays, wordsKept } from '../core/conversations/retention.js';
import type { WordsKey } from '../core/conversations/words.js';
import { archivedQuestionBody } from '../core/conversations/archived-questions.js';

const id=z.string().min(1);
const timestamp=z.iso.datetime({offset:true}).transform(date=>new Date(date).toISOString());
const sourceQuestion=z.object({thread:id,ref:id,approval:id.nullable(),raised:timestamp,seen:timestamp,
  words:z.instanceof(Buffer).nullable(),answer_json:z.string().nullable()});
const answer=z.object({verdict:id,by:id.optional(),at:timestamp.optional()}).strict();
const scope=z.object({id,agent:id,member:id,conversation:id});

export async function importArchivedQuestions(input:{
  archive:Database.Database; household:Database.Database; destination:DataDatabase; key:WordsKey;
  sourceDays:number; now:()=>string;
}) {
  const {archive,household,destination:db,sourceDays,key,now}=input;
  if(!archive.readonly||!household.readonly||!validKeepDays(sourceDays))throw Error('Expected a read-only archive with its original Comms retention');
  const oldThreads=new Map(household.prepare('select id,agent,member,conversation from comms_threads').all()
    .map(raw=>{const t=scope.parse(raw);return [t.id,t] as const;}));
  const prepared: (typeof archivedQuestions.$inferSelect)[]=[];
  for(const raw of archive.prepare('select thread,ref,approval,raised,seen,words,answer_json from comms_asks order by thread,ref').iterate()){
    const q=sourceQuestion.parse(raw);
    if(!oldThreads.has(q.thread))throw Error('Archived question has no source thread');
    const outcome=q.answer_json===null?null:answer.parse(JSON.parse(q.answer_json));
    const keepUntil=keepUntilFor(q.seen,sourceDays);
    let words=null;
    if(q.words&&wordsKept({at:q.seen,keepUntil},commsKeepDays(db),now())){
      // Validate with the destination key. Keep the original authenticated envelope byte for byte.
      try {archivedQuestionBody.parse(JSON.parse(await key.open(q.words)));} catch {throw Error('Archived question envelope could not be verified');}
      words=q.words;
    }
    prepared.push({thread:q.thread,ref:q.ref,approval:q.approval,raisedAt:q.raised,seenAt:q.seen,keepUntil,words,
      verdict:outcome?.verdict??null,answeredBy:outcome?.by??null,answeredAt:outcome?.at??null});
  }
  return db.transaction(()=>{
    const currentThreads=new Map(db.select({id:threads.id,conversation:threads.conversation,agent:conversations.agent,
      member:conversations.member,venue:conversations.venue}).from(threads).innerJoin(conversations,eq(threads.conversation,conversations.id))
      .all().map(t=>[t.id,t]));
    const days=commsKeepDays(db),at=now();
    let inserted=0;
    for(const row of prepared){
      const source=oldThreads.get(row.thread)!,target=currentThreads.get(row.thread);
      if(!target||target.venue!=='loom'||target.member!==source.member||target.agent!==source.agent||target.conversation!==source.conversation)
        throw Error('Archived question destination thread differs');
      const words=wordsKept({at:row.seenAt,keepUntil:row.keepUntil},days,at)?row.words:null;
      const result=db.insert(archivedQuestions).values({...row,words}).onConflictDoNothing().run();
      if(result.changes){inserted++;continue;}
      const prior=db.query.archivedQuestions.findFirst({where:(q,{and,eq})=>and(eq(q.thread,row.thread),eq(q.ref,row.ref))}).sync();
      if(!prior||prior.raisedAt!==row.raisedAt||prior.seenAt!==row.seenAt||prior.keepUntil!==row.keepUntil||
        prior.approval!==row.approval||prior.verdict!==row.verdict||prior.answeredBy!==row.answeredBy||prior.answeredAt!==row.answeredAt||
        (prior.words&&words&&!prior.words.equals(words)))throw Error('Conflicting archived question');
      // An expired source or shorter policy may remove bytes on retry; no retry restores purged words.
      if(prior.words&&!words)db.update(archivedQuestions).set({words:null}).where(
        and(eq(archivedQuestions.thread,row.thread),eq(archivedQuestions.ref,row.ref))).run();
    }
    return {total:prepared.length,inserted};
  });
}
