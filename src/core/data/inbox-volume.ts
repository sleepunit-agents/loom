import { and, inArray, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { rules, type Viewer } from '../../policy.js';
import { sqlRule } from '../../policy-sql.js';
import type { DataDatabase } from './database.js';
import type { inbox } from './schema.js';

/** Batched display of the Tempo volume authority: policy.ts's inboxVolume rule as a
 * list filter, with the caller's question-source constraint. */
export function readInboxVolume(db:DataDatabase,viewer:Viewer,items:(typeof inbox.$inferSelect)[],source:(fields:Record<string,AnyColumn>)=>SQL):Set<string>{
  if(viewer.kind!=='member'&&viewer.kind!=='agent'||!items.length)return new Set();
  const rows=db.query.inbox.findMany({columns:{id:true},where:f=>{
    const allowed=sql`${sqlRule(rules.inboxVolume,viewer,f)} and ${source(f)}`;
    return and(inArray(f.id,items.map(row=>row.id)),sql`${{getSQL:()=>allowed}}`);
  }}).sync();
  return new Set(rows.map(row=>row.id));
}
