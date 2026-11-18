import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { DataDatabase } from './database.js';
import { conversations, threads } from './schema.js';
import { commsKeepDays } from './comms-days.js';

function visibleThread(id:SQL,allowed:SQL){return sql`exists(select 1 from ${threads} inner join ${conversations} on ${conversations.id}=${threads.conversation} where ${threads.id}=${id} and ${allowed})`;}
/** Generated metadata page: filter current conversation authority in SQL,
 * before pagination. Nested relations carry only labels, never ciphertext. */
export function readCommsPage(db:DataDatabase,thread:string,allowed:SQL,before:number|undefined,count:number){
  const rows=db.query.messages.findMany({columns:{words:false},
    with:{threadRow:{columns:{conversation:true},with:{conversationRow:{columns:{id:true,agent:true,project:true,member:true}}}}},
    where:f=>and(eq(f.thread,thread),before===undefined?undefined:lt(f.seq,before),sql`${{getSQL:()=>visibleThread(sql`${f.thread}`,allowed)}}`),
    orderBy:f=>desc(f.seq),limit:count,
  }).sync();
  return rows.flatMap(({threadRow,...row})=>{
    const scope=threadRow?.conversationRow;
    return scope?[{...row,conversation:scope.id,agent:scope.agent,project:scope.project,member:scope.member}]:[];
  }).reverse();
}
/** A private message read set lives only for one selection. Both reads use
 * the same current SQL authority; compare again after every decrypt batch. */
export function readCommsSet(db:DataDatabase,thread:string,seqs:number[],allowed:SQL,words:boolean){
  const scope=db.query.threads.findFirst({columns:{id:true,conversation:true},
    with:{conversationRow:{columns:{id:true,agent:true,project:true,member:true}}},
    where:f=>{const visible=sql`exists(select 1 from ${conversations} where ${conversations.id}=${f.conversation} and ${allowed})`;return and(eq(f.id,thread),sql`${{getSQL:()=>visible}}`);},
  }).sync();
  const rows=db.query.messages.findMany({columns:words?undefined:{words:false},
    where:f=>and(eq(f.thread,thread),inArray(f.seq,seqs),sql`${{getSQL:()=>visibleThread(sql`${f.thread}`,allowed)}}`),orderBy:f=>asc(f.seq),
  }).sync().map(row=>({...row,words:words?row.words:null}));
  const days=commsKeepDays(db);
  const entries=new Map(rows.flatMap(message=>{
    const cv=scope?.conversationRow;
    return cv?[[message.seq,{message,conversation:cv.id,agent:cv.agent,project:cv.project,member:cv.member}] as const]:[];
  }));
  return {days,fingerprint:JSON.stringify([scope,rows,days]),entry:(seq:number)=>entries.get(seq)};
}
export type CommsReadSet=ReturnType<typeof readCommsSet>;

function visibleConversation(id: SQL, allowed: SQL) {
  return sql`exists(select 1 from ${conversations} where ${conversations.id}=${id} and ${allowed})`;
}
export function readCommsThreads(db: DataDatabase, allowed: SQL, input: { id?: string; member?: string; agent?: string; archived?: boolean; search?: string; count: number; offset: number }) {
  return db.query.threads.findMany({
    with: { conversationRow: { columns: { agent: true, project: true, member: true, venue: true } } },
    where: f => {
      const scope = sql`exists(select 1 from ${conversations} where ${conversations.id}=${f.conversation} and ${allowed}
        ${input.member ? sql`and ${conversations.member}=${input.member}` : sql``}
        ${input.agent ? sql`and ${conversations.agent}=${input.agent}` : sql``}
        ${input.search?.trim() ? sql`and instr(lower(${f.title} || ' ' || ${conversations.agent} || ' ' || coalesce(${conversations.project},'')), ${input.search.trim().toLowerCase()}) > 0` : sql``})`;
      return and(sql`${{ getSQL: () => scope }}`, input.id !== undefined ? eq(f.id, input.id) : input.archived ? isNotNull(f.archivedAt) : isNull(f.archivedAt));
    },
    orderBy: f => [desc(f.pinned), desc(sql`julianday(${f.lastAt})`), asc(f.id)], limit: input.count, offset: input.offset,
  }).sync().flatMap(({ conversationRow, ...row }) => conversationRow ? [{ ...row, ...conversationRow }] : []);
}
export function readCommsFolders(db: DataDatabase, allowed: SQL, member: string) {
  const rows = db.query.threads.findMany({ columns: { archivedAt: true }, where: f => {
    const scope = visibleConversation(sql`${f.conversation}`, and(allowed, eq(conversations.member, member))!);
    return sql`${{ getSQL: () => scope }}`;
  } }).sync();
  const archived = rows.filter(row => row.archivedAt !== null).length;
  return { threads: rows.length - archived, archived };
}
export function readCommsRefs(db: DataDatabase, allowed: SQL, thread: string, count: number) {
  return db.query.threadRefs.findMany({ columns: { ref: true, messageSeq: true },
    where: f => and(eq(f.thread, thread), sql`${{ getSQL: () => visibleThread(sql`${f.thread}`, allowed) }}`),
    orderBy: f => [desc(f.messageSeq), asc(f.ref)], limit: count,
  }).sync();
}
