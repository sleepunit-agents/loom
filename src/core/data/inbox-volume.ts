import { and, inArray, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { Viewer } from '../../policy.js';
import type { DataDatabase } from './database.js';
import { agents, members, memberAgents, type inbox } from './schema.js';

/** Batched display of the existing Tempo volume authority: a current actor,
 * recipient authority, and the existing question-source constraint. */
export function readInboxVolume(db:DataDatabase,viewer:Viewer,items:(typeof inbox.$inferSelect)[],source:(fields:Record<string,AnyColumn>)=>SQL):Set<string>{
  if(viewer.kind!=='member'&&viewer.kind!=='agent'||!items.length)return new Set();
  const owner=viewer.kind==='member'?sql`exists(select 1 from ${members} where ${members.id}=${viewer.id} and ${members.role}='owner')`:sql`false`;
  const actor=viewer.kind==='member'?sql`exists(select 1 from ${members} where ${members.id}=${viewer.id})`:sql`exists(select 1 from ${agents} where ${agents.id}=${viewer.id})`;
  const rows=db.query.inbox.findMany({columns:{id:true},where:f=>{
    const person=sql`exists(select 1 from ${members} where ${members.id}=${f.to}) and (${owner} or ${viewer.kind==='member'?sql`${f.to}=${viewer.id}`:sql`false`})`;
    const agent=sql`exists(select 1 from ${agents} where ${agents.id}=${f.to}) and (${owner} or ${viewer.kind==='agent'?sql`${f.to}=${viewer.id}`:sql`exists(select 1 from ${memberAgents} where ${memberAgents.member}=${viewer.id} and ${memberAgents.agent}=${f.to})`})`;
    const allowed=sql`${actor} and (case when ${f.toKind}='agent' then ${agent} else ${person} end) and ${source(f)}`;
    return and(inArray(f.id,items.map(row=>row.id)),sql`${{getSQL:()=>allowed}}`);
  }}).sync();
  return new Set(rows.map(row=>row.id));
}
