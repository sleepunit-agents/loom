import { and, asc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { DataDatabase } from './database.js';
import { inbox } from './schema.js';
import { commsKeepDays } from './comms-days.js';

type Item=typeof inbox.$inferSelect;
/** A bounded read set for one Inbox selection, never a cross-request cache.
 * Re-read the entire set after decryptions, then compare before releasing it.
 * The caller supplies its current SQL predicate, including source visibility.
 */
export function readInboxSet(db:DataDatabase,ids:string[],allowed:SQL,words=true){
  const rows=db.query.inbox.findMany({where:f=>{
    const selected=or(inArray(f.id,ids),and(eq(f.source,'answer'),inArray(f.sourceId,ids)));
    return and(selected,sql`${{getSQL:()=>allowed}}`);
  }}).sync();
  const allIds=rows.map(row=>row.id),threadIds=[...new Set(rows.flatMap(row=>row.thread?[row.thread]:[]))];
  const messageRows=db.query.messages.findMany({columns:words?undefined:{words:false},where:f=>allIds.length?inArray(f.inboxItem,allIds):sql`false`}).sync().map(row=>({...row,words:words?row.words:null}));
  const threadRows=db.query.threads.findMany({where:f=>threadIds.length?inArray(f.id,threadIds):sql`false`}).sync();
  const refs=db.query.inboxRefs.findMany({where:f=>allIds.length?inArray(f.item,allIds):sql`false`,orderBy:(f,{asc})=>asc(f.ref)}).sync();
  const reads=db.query.inboxReads.findMany({where:f=>allIds.length?inArray(f.item,allIds):sql`false`}).sync();
  const days=commsKeepDays(db);
  const items=new Map(rows.map(row=>[row.id,row])),threadMap=new Map(threadRows.map(row=>[row.id,row]));
  const messageKey=(item:string|null,thread:string|null,seq:number|null)=>JSON.stringify([item,thread,seq]);
  const messageMap=new Map(messageRows.map(row=>[messageKey(row.inboxItem,row.thread,row.seq),row]));
  const refsByItem=new Map<string,string[]>();
  for(const row of refs){const list=refsByItem.get(row.item)??[];list.push(row.ref);refsByItem.set(row.item,list);}
  const readKeys=new Set(reads.map(row=>JSON.stringify([row.item,row.member])));
  const answersBySource=new Map<string,typeof rows>();
  for(const row of rows)if(row.source==='answer'&&row.sourceId){const list=answersBySource.get(row.sourceId)??[];list.push(row);answersBySource.set(row.sourceId,list);}
  const message=(item:Item)=>messageMap.get(messageKey(item.id,item.thread,item.messageSeq));
  return {
    fingerprint:JSON.stringify([rows,messageRows,threadRows,refs,reads,days]),days,
    item:(id:string)=>items.get(id),thread:(id:string)=>threadMap.get(id),message,
    refs:(id:string)=>refsByItem.get(id)??[],
    read:(id:string,member:string)=>readKeys.has(JSON.stringify([id,member])),
    answer:(item:Item)=>{
      if(!item.thread||!item.conversation||item.state!=='answered'||!['words','replied'].includes(item.answer??'')||!item.answeredBy||!item.answeredAt)return;
      const mail=answersBySource.get(item.id)?.find(row=>row.toKind==='agent'&&row.conversation===item.conversation&&row.thread===item.thread&&row.fromKind==='person'&&row.fromId===item.answeredBy&&threadMap.get(row.thread!)?.conversation===item.conversation&&message(row)?.kind==='answer'&&message(row)?.sender===item.answeredBy);
      return mail?{mail,message:message(mail)!}:undefined;
    },
  };
}
export type InboxReadSet=ReturnType<typeof readInboxSet>;

/** Counts share one generated metadata scan; the SQL predicate constrains the
 * recipient, source and volume before any row enters the projection. */
export function readInboxFolders(db: DataDatabase, allowed: SQL) {
  const rows = db.query.inbox.findMany({
    columns: { agent: true, state: true, source: true, answers: true },
    where: () => sql`${{ getSQL: () => allowed }}`, orderBy: f => asc(f.agent),
  }).sync();
  const totals = { needs: 0, alerts: 0, answered: 0, fyi: 0, all: rows.length };
  const agents = new Map<string, { id: string; count: number; needs: number }>();
  for (const row of rows) {
    const needs = row.state === 'waiting' && row.answers !== null;
    if (needs) totals.needs++;
    if (row.state === 'waiting' && row.answers === null) {
      totals.fyi++;
      if (row.source === 'notice') totals.alerts++;
    }
    if (['answered', 'resolved', 'done'].includes(row.state)) totals.answered++;
    if (row.agent !== null) {
      const agent = agents.get(row.agent) ?? { id: row.agent, count: 0, needs: 0 };
      agent.count++; if (needs) agent.needs++;
      agents.set(row.agent, agent);
    }
  }
  return { ...totals, agents: [...agents.values()] };
}
