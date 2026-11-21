import { pendingThreadDeletions } from './archive-deletions.js';
/** Offline phase of a household move. Thread identities and the old Comms key must already be staged. */
import type { ArchiveReader } from './archive-reader.js';
import { and, eq, isNotNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { archivedQuestions, conversations, threads } from '../data/schema.js';
import type { DataDatabase } from '../data/database.js';
import { commsKeepDays } from '../data/comms-days.js';
import { ageCutoff, keepUntilFor, validKeepDays, wordsKept } from './retention.js';
import type { WordsKey } from './words.js';
import { archivedQuestionBody } from './archived-questions.js';

const id=z.string().min(1);
const timestamp=z.iso.datetime({offset:true}).transform(date=>new Date(date).toISOString());
const sourceQuestion=z.object({thread:id,ref:id,approval:id.nullable(),raised:timestamp,seen:timestamp,
  words:z.instanceof(Uint8Array).transform(bytes => Buffer.from(bytes)).nullable(),answer_json:z.string().nullable()});
const answer=z.object({verdict:id,by:id.optional(),at:timestamp.optional()}).strict();
const scope=z.object({id,agent:id,member:id,conversation:id,project:id.nullable().default(null)});

/** The two earliest released Comms layouts had only a message table. An
 * unrelated or newer archive missing its questions must not report success. */
function hasSavedQuestions(archive: ArchiveReader) {
  const tables = archive.prepare("SELECT name,type FROM sqlite_schema WHERE type IN ('table','view') AND name NOT GLOB 'sqlite_*'").all() as {name:string;type:string}[];
  if (tables.some(row => row.name === 'comms_asks' && row.type === 'table')) return true;
  const columns = archive.prepare("SELECT name || ':' || upper(type) || ':' || pk AS signature FROM pragma_table_info('comms_messages') ORDER BY cid").all().map(row => (row as {signature:string}).signature).join(',');
  const original = [
    'thread:TEXT:1', 'seq:INTEGER:2', 'at:TEXT:0', 'kind:TEXT:0', 'sender:TEXT:0', 'id:TEXT:0',
    'hash:TEXT:0', 'text:BLOB:0', 'card_json:TEXT:0', 'run:TEXT:0', 'delivered:INTEGER:0',
  ].join(',');
  if (tables.length === 1 && tables[0].name === 'comms_messages' && tables[0].type === 'table'
    && [original, original + ',sending_at:INTEGER:0,delivery_json:TEXT:0'].includes(columns)) return false;
  throw Error('Unrecognized archive without a saved question table');
}

export async function importArchivedQuestions(input:{
  archive:ArchiveReader; household:ArchiveReader; destination:DataDatabase; key:WordsKey;
  sourceDays:number; now:()=>string;
}) {
  const {archive,household,destination:db,sourceDays,key,now}=input;
  if(!archive.readonly||!household.readonly||!validKeepDays(sourceDays))throw Error('Expected a read-only archive with its original Comms retention');
  const deleted=pendingThreadDeletions(household, db);
  if (!hasSavedQuestions(archive)) return {total:0,inserted:0};
  const oldThreads=new Map(household.prepare('select * from comms_threads').all()
    .map(raw=>{const t=scope.parse(raw);return [t.id,t] as const;}));
  const readThreads = () => new Map(db.select({id:threads.id,conversation:threads.conversation,agent:conversations.agent,
    member:conversations.member,project:conversations.project,place:conversations.place,venue:conversations.venue})
    .from(threads).innerJoin(conversations,eq(threads.conversation,conversations.id)).all().map(t=>[t.id,t]));
  const checkThread = (thread:string, staged:ReturnType<typeof readThreads>) => {
    const source=oldThreads.get(thread), target=staged.get(thread);
    if (!source || !target || target.venue!=='loom' || target.place!==thread || target.member!==source.member ||
      target.project!==source.project || target.agent!==source.agent || target.conversation!==source.conversation)
      throw Error('Archived question destination thread differs');
    return source;
  };
  const initialThreads=readThreads();
  const prepared: (typeof archivedQuestions.$inferSelect)[]=[];
  for(const raw of archive.prepare('select thread,ref,approval,raised,seen,words,answer_json from comms_asks order by thread,ref').iterate()){
    if (deleted.has((raw as {thread:string}).thread)) continue;
    const q=sourceQuestion.parse(raw);
    const source=checkThread(q.thread,initialThreads);
    const outcome=q.answer_json===null?null:answer.parse(JSON.parse(q.answer_json));
    const keepUntil=keepUntilFor(q.seen,sourceDays);
    let words=null;
    if(q.words&&wordsKept({at:q.seen,keepUntil},commsKeepDays(db),now())){
      // Validate with the destination key. Keep the original authenticated envelope byte for byte.
      try {archivedQuestionBody.parse(JSON.parse(await key.open(q.words)));} catch {throw Error('Archived question envelope could not be verified');}
      words=q.words;
    }
    prepared.push({thread:q.thread,sourceMember:source.member,sourceAgent:source.agent,sourceConversation:source.conversation,ref:q.ref,approval:q.approval,raisedAt:q.raised,seenAt:q.seen,keepUntil,words,
      verdict:outcome?.verdict??null,answeredBy:outcome?.by??null,answeredAt:outcome?.at??null});
  }
  return db.transaction(()=>{
    const currentThreads=readThreads();
    const days=commsKeepDays(db),at=now();
    let inserted=0;
    for(const row of prepared){
      checkThread(row.thread,currentThreads);
      const words=wordsKept({at:row.seenAt,keepUntil:row.keepUntil},days,at)?row.words:null;
      const result=db.insert(archivedQuestions).values({...row,words}).onConflictDoNothing().run();
      if(result.changes){inserted++;continue;}
      const prior=db.query.archivedQuestions.findFirst({where:(q,{and,eq})=>and(eq(q.thread,row.thread),eq(q.ref,row.ref))}).sync();
      if(!prior||prior.sourceMember!==row.sourceMember||prior.sourceAgent!==row.sourceAgent||prior.sourceConversation!==row.sourceConversation||prior.raisedAt!==row.raisedAt||prior.seenAt!==row.seenAt||prior.keepUntil!==row.keepUntil||
        prior.approval!==row.approval||prior.verdict!==row.verdict||prior.answeredBy!==row.answeredBy||prior.answeredAt!==row.answeredAt||
        (prior.words&&words&&!prior.words.equals(words)))throw Error('Conflicting archived question');
      // An expired source or shorter policy may remove bytes on retry; no retry restores purged words.
      if(prior.words&&!words)db.update(archivedQuestions).set({words:null}).where(
        and(eq(archivedQuestions.thread,row.thread),eq(archivedQuestions.ref,row.ref))).run();
    }
    const finished=now();
    expireArchivedQuestions(db,finished,ageCutoff(finished,days));
    return {total:prepared.length,inserted};
  });
}

/** Erase private envelopes on the earlier of the original and current household deadlines. */
export function expireArchivedQuestions(db:DataDatabase,at:string,cutoff:string) {
  return db.update(archivedQuestions).set({words:null}).where(and(isNotNull(archivedQuestions.words),
    or(sql`julianday(${archivedQuestions.keepUntil}) <= julianday(${at})`,
       sql`julianday(${archivedQuestions.seenAt}) <= julianday(${cutoff})`))).run().changes;
}
