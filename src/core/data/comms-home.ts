import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { holds, mayAct, rules, type Viewer } from '../../policy.js';
import { sharedSharing } from '../../shared-sharing.js';
import type { DataDatabase } from './database.js';
import { agents, conversations, messages, threads } from './schema.js';

/** Home's small display projection: the member's own threads with the agents they may give work to.
 * Which agents those are is policy.ts's answer about the member's own thread with each (mayAct,
 * 'give-work'), the one sending in Comms is held to, so Home never offers an agent the member cannot
 * write to; nothing here reads who has an agent. The caller supplies its existing conversation
 * predicate. The number of statements does not grow with the rows: the household's sharing, the
 * agents, and the visible threads.
 */
export function readCommsHome(db: DataDatabase, viewer: Viewer, allowed: SQL) {
  if (viewer.kind !== 'member') return null;
  const sharing = sharedSharing(db);
  if ( !holds(rules.currentMember, viewer, {}, sharing)) return null;
  const owned = db.select({ id: agents.id }).from(agents).orderBy(asc(agents.id)).all()
    .map(row => row.id).filter(agent => mayAct(viewer, { type: 'conversation', agent, member: viewer.id }, sharing, 'give-work'));
  // Read the threads even for an empty list; the constant-false
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
