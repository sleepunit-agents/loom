import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { rules, type Viewer } from '../../policy.js';
import { sqlHolds } from '../../policy-sql.js';
import type { DataDatabase } from './database.js';
import { conversations, messages, threads } from './schema.js';

/** Home's small display projection. Generated table reads load the member,
 * owned agents and visible threads in three statements, independent of rows.
 * The caller supplies its existing conversation predicate; no new policy.
 */
export function readCommsHome(db: DataDatabase, viewer: Viewer, allowed: SQL) {
  if (viewer.kind !== 'member' || !sqlHolds(db, rules.currentMember, viewer)) return null;
  const owned = db.query.memberAgents.findMany({
    columns:{agent:true},where:(f,{eq})=>eq(f.member,viewer.id),
    with:{agentRow:{columns:{id:true}}},orderBy:(f,{asc})=>asc(f.agent),
  }).sync().filter(row=>row.agentRow!==null).map(row=>row.agent);
  // Keep the three statements even for an empty list; the constant-false
  // predicate produces no rows without generating an invalid IN ().
  const rows = db.query.threads.findMany({
    columns:{id:true,title:true,lastAt:true},
    with:{conversationRow:{columns:{agent:true}}},
    where:f=>{
      const visible=and(allowed,eq(conversations.member,viewer.id),owned.length?inArray(conversations.agent,owned):sql`false`);
      // Drizzle aliases every nested Column in a relational predicate. Render
      // inner conversation columns after that pass, just as dataQueries does.
      const scope=sql`exists(select 1 from ${conversations} where ${conversations.id}=${f.conversation} and ${visible})`;
      return and(isNull(f.archivedAt),sql`${{getSQL:()=>scope}}`);
    },
    extras:f=>{
      const unread=sql<boolean>`exists(select 1 from ${messages} where ${messages.thread}=${f.id}
        and ${messages.kind}='reply' and ${messages.seq}>${f.readSeq}
        and exists(select 1 from ${conversations} where ${conversations.id}=${f.conversation} and ${messages.sender}=${conversations.agent}))`;
      return {unread:sql`${{getSQL:()=>unread}}`.mapWith(Boolean).as('home_unread')};
    },
    orderBy:f=>[desc(sql`julianday(${f.lastAt})`),asc(f.id)],
  }).sync();
  const grouped = new Map<string, typeof rows>();
  for(const row of rows){
    const agent=row.conversationRow?.agent;
    if(!agent)continue;
    const group=grouped.get(agent)??[];group.push(row);grouped.set(agent,group);
  }
  return {member:viewer.id,agents:owned,summaries:owned.map(agent=>{
    const entries=grouped.get(agent)??[];
    const display=(row:typeof rows[number]|undefined)=>row?{thread:row.id,title:row.title,at:row.lastAt,unread:row.unread}:null;
    return {agent,unread:entries.filter(row=>row.unread).length,last:display(entries[0]),first:display(entries.find(row=>row.unread))};
  })};
}
