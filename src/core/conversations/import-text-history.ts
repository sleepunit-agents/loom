import { pendingThreadDeletions } from './archive-deletions.js';
import Database from 'better-sqlite3';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from '../data/database.js';
import { commsKeepDays } from '../data/comms-days.js';
import { conversations, messages, threadRefs, threads } from '../data/schema.js';
import { expireMessageWords } from './messages.js';
import { ageCutoff, keepUntilFor, validKeepDays, wordsKept } from './retention.js';
import type { WordsKey } from './words.js';

import { legacyCommsRefs, validLegacyCommsRef } from './legacy-comms-refs.js';
import { recordThreadRef } from './thread-ref-store.js';

import { legacyCardSummary, legacyToolCard, legacyStepWords } from './legacy-tool-card.js';

import { legacyNotice } from './legacy-notice.js';

const id=z.string().min(1);
const oldText=z.object({
  thread:id, seq:z.number().int().positive(), kind:z.enum(['message','reply','card','error']), sender:id, id,
  at:z.iso.datetime({offset:true}).transform(v=>new Date(v).toISOString()), run:id.nullable(),
  text:z.instanceof(Buffer).nullable(), card_json:z.string().nullish(), step:z.instanceof(Buffer).nullish(), delivered:z.union([z.literal(0),z.literal(1)]).nullable(),
});
const oldThread=z.object({id,conversation:id,agent:id,member:id,project:id.nullable()});

interface HistoryInput {
  archive:Database.Database; household:Database.Database; destination:DataDatabase;
  key:WordsKey; sourceDays:number; github?:string; kind?:'text'|'cards'|'notices'; now:()=>string;
}

/** Import historical rows without replaying delivery or generating turns.
 * Stage only sealed reasons. SQLite can spill large imports to a temporary file. */
export async function importTextHistory(input: HistoryInput) {
  const reasons = input.kind === 'notices' ? new Database('') : null;
  try {
    return await importRows(input, reasons);
  } finally {
    reasons?.close();
  }
}

async function importRows(input: HistoryInput, reasons: Database.Database | null) {
  const {archive,household,destination:db,key,sourceDays,now}=input;
  if (!archive.readonly || !household.readonly || !validKeepDays(sourceDays)) throw Error('Invalid Comms archive');
  const deleted=pendingThreadDeletions(household, db);
  const oldThreads=new Map(household.prepare('SELECT id,conversation,agent,member,project FROM comms_threads').all()
    .map(raw=>{const row=oldThread.parse(raw);return [row.id,row] as const;}));
  const text=input.kind==='notices'
    ?archive.prepare("SELECT * FROM comms_messages WHERE kind='error' ORDER BY thread,seq")
    :input.kind==='cards'
    ?archive.prepare("SELECT * FROM comms_messages WHERE kind='card' ORDER BY thread,seq")
    :archive.prepare("SELECT thread,seq,kind,sender,id,at,run,text,delivered FROM comms_messages WHERE kind IN ('message','reply') ORDER BY thread,seq");
  const inspected=now(), initialDays=commsKeepDays(db);
  const kept=(row:z.infer<typeof oldText>,days:number,at:string)=>
    wordsKept({at:row.at,keepUntil:keepUntilFor(row.at,sourceDays)},days,at);
  const readScopes=()=>new Map(db.select({id:threads.id,conversation:threads.conversation,agent:conversations.agent,
      member:conversations.member,project:conversations.project,place:conversations.place,venue:conversations.venue})
      .from(threads).innerJoin(conversations,eq(threads.conversation,conversations.id)).all().map(t=>[t.id,t]));
  const checkScope=(row:z.infer<typeof oldText>, staged:ReturnType<typeof readScopes>)=>{
    const source=oldThreads.get(row.thread), target=staged.get(row.thread);
    if (!source || !target || target.venue!=='loom' || target.place!==row.thread ||
        target.agent!==source.agent || target.member!==source.member || target.project!==source.project ||
        target.conversation!==source.conversation) throw Error('Staged message thread differs');
    if (row.kind==='error' ? row.sender!=='loom' : row.kind!=='message' ? row.sender!==source.agent : row.sender!==source.member && row.sender!==source.agent)
      throw Error('Message sender differs from the archived thread');
  };
  const initialScopes=readScopes();
  const hasIndex=Boolean(household.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='comms_refs'").get());
  const complete=hasIndex && Boolean(household.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='comms_meta'").get()
    && household.prepare("SELECT 1 FROM comms_meta WHERE key='refs_backfilled'").get());
  // Older households can predate the reference index. Reconstruct their latest 200
  // distinct references per thread in the v1 writer's message and mention order.
  type Mention={seq:number;pos:number};
  const rebuilt=new Map<string,Map<string,Mention>>();
  // The CLI holds the home lock and owns this private read-only snapshot throughout
  // both passes. Validate retained envelopes without buffering household history.
  reasons?.exec('CREATE TABLE reasons(thread TEXT, seq INTEGER, words BLOB, PRIMARY KEY(thread,seq))');
  const saveReason = reasons?.prepare('INSERT INTO reasons VALUES(?,?,?)');
  const findReason = reasons?.prepare('SELECT words FROM reasons WHERE thread=? AND seq=?');
  for (const raw of text.iterate()) {
    if (deleted.has((raw as {thread:string}).thread)) continue;
    const row=oldText.parse(raw);
    checkScope(row,initialScopes);
    if (row.kind === 'error') {
      if (row.text || row.step || row.delivered !== null) throw Error('Unexpected legacy notice payload');
      const { reason } = legacyNotice(row.card_json ?? 'null');
      if (kept(row,initialDays,inspected)) {
        const prior = db.select({words: messages.words}).from(messages)
          .where(and(eq(messages.thread,row.thread),eq(messages.seq,row.seq))).get();
        if (prior?.words && await key.open(prior.words) !== reason) throw Error('Conflicting staged notice reason');
        if (reason !== undefined && (!prior || prior.words)) {
          saveReason!.run(row.thread,row.seq,prior?.words ?? await key.seal(reason));
        }
      }
      continue;
    }
    const card=row.kind==='card'?legacyToolCard.parse(JSON.parse(row.card_json??'null')):null;
    if (row.step && !row.text) throw Error('Private tool details without a retained summary');
    if (row.text && kept(row,initialDays,inspected)) {
      const words=await key.open(row.text);
      if (card) legacyCardSummary.parse(words);
      if (card && row.step) legacyStepWords(await key.open(row.step),card.tool);
      if (!card && !complete) {
        const refs=rebuilt.get(row.thread)??new Map<string,Mention>();
        for (const [pos,ref] of legacyCommsRefs(words,input.github).entries()) {
          refs.delete(ref);
          refs.set(ref,{seq:row.seq,pos});
          if (refs.size>200) refs.delete(refs.keys().next().value!);
        }
        rebuilt.set(row.thread,refs);
      }
    }
  }
  return db.transaction(()=>{
    const days=commsKeepDays(db),at=now();
    const staged=readScopes();
    let total=0, inserted=0;
    for (const raw of text.iterate()) {
      if (deleted.has((raw as {thread:string}).thread)) continue;
      const row=oldText.parse(raw);
      checkScope(row,staged);
      const keepUntil=keepUntilFor(row.at,sourceDays);
      const notice = row.kind === 'error' ? legacyNotice(row.card_json ?? 'null').info : null;
      const reason = notice ? findReason!.get(row.thread,row.seq) as {words:Buffer}|undefined : undefined;
      const words=kept(row,initialDays,inspected)&&kept(row,days,at)?(reason?.words ?? row.text):null;
      const delivery=row.delivered===1?'delivered':row.delivered===0?'failed':row.kind==='message'?'sending':null;
      const card=row.kind==='card'?legacyToolCard.parse(JSON.parse(row.card_json??'null')):null;
      const extra=words&&card?row.step??null:null;
      const identity={thread:row.thread,seq:row.seq,kind:row.kind==='error'?'notice':row.kind,archivedNotice:notice?JSON.stringify(notice):null,sender:row.sender,at:row.at,run:row.run,
        clientId:row.id,delivery,keepUntil,tool:card?.tool??null,cardState:card?.state??null,archivedStepMeta:card?JSON.stringify(card):null} as const;
      const match=and(eq(messages.thread,row.thread),eq(messages.seq,row.seq));
      const prior=db.select().from(messages).where(match).get();
      if (!prior) {
        db.insert(messages).values({...identity,words,archivedStepWords:extra}).run();
        inserted++;
      } else {
        if (Object.entries(identity).some(([k,v])=>prior[k as keyof typeof identity]!==v) ||
            prior.inboxItem!==null || prior.verdict!==null || (prior.archivedStepWords && extra && !prior.archivedStepWords.equals(extra)) ||
            (prior.words && words && !prior.words.equals(words))) throw Error('Conflicting staged message');
        if (prior.words && !words) db.update(messages).set({words:null,archivedStepWords:null}).where(match).run();
        else if(prior.archivedStepWords && !extra) db.update(messages).set({archivedStepWords:null}).where(match).run();
      }
      total++;
    }
    if(input.kind==='cards' || input.kind==='notices')return {inserted,total};
    // The old durable index also contains references to erased words. Overlay its
    // saved positions after removing reconstructed mentions whose bodies expired.
    for (const [thread,refs] of rebuilt) for (const [ref,{seq}] of refs) {
      const msg=db.select({present:sql<number>`${messages.words} IS NOT NULL`}).from(messages)
        .where(and(eq(messages.thread,thread),eq(messages.seq,seq))).get();
      if (!msg?.present) refs.delete(ref);
    }
    if (hasIndex) {
      const reference=z.object({thread:id,ref:id.max(200),seq:z.number().int().positive(),pos:z.number().int().nonnegative(),at:z.iso.datetime({offset:true})});
      const parent=archive.prepare("SELECT at FROM comms_messages WHERE thread=? AND seq=? AND kind IN ('message','reply')");
      for (const raw of household.prepare('SELECT thread,ref,seq,pos,at FROM comms_refs').iterate()) {
        if (deleted.has((raw as {thread:string}).thread)) continue;
        const row=reference.parse(raw), msg=parent.get(row.thread,row.seq) as {at:string}|undefined;
        if (!msg || Date.parse(msg.at)!==Date.parse(row.at) || !validLegacyCommsRef(row.ref))
          throw Error('Unrecognized archived thread reference');
        const refs=rebuilt.get(row.thread)??new Map<string,Mention>();
        if ((refs.get(row.ref)?.seq??0)<=row.seq) refs.set(row.ref,{seq:row.seq,pos:row.pos});
        rebuilt.set(row.thread,refs);
      }
    }
    for (const [thread,refs] of rebuilt) {
      const prior=new Map(db.select().from(threadRefs).where(eq(threadRefs.thread,thread)).all().map(r=>[r.ref,r.messageSeq]));
      const newest=[...refs].sort(([,a],[,b])=>b.seq-a.seq || b.pos-a.pos).slice(0,200);
      for (const [ref,{seq}] of newest) {
        const existing=prior.get(ref);
        if (existing===seq) continue;
        if (complete && existing!==undefined) throw Error('Conflicting staged thread reference');
        // On retry the last known mention may already have lost its words.
        if ((existing!==undefined && existing>seq) || (existing===undefined && prior.size>=200)) continue;
        recordThreadRef(db,thread,ref,seq);
        prior.set(ref,seq);
      }
    }
    const finished=now();
    expireMessageWords(db,finished,ageCutoff(finished,days));
    return {inserted,total};
  });
}
