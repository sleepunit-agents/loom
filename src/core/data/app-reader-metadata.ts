import {and,eq,sql} from 'drizzle-orm';
import {rules,type Viewer} from '../../policy.js';
import {sqlRule} from '../../policy-sql.js';
import type {DataDatabase} from './database.js';

/** Resolve the same policy used at the door, projecting just the current ID and management capability. */
export function readAppMember(db:DataDatabase,viewer:Viewer){
 const current=sqlRule(rules.currentMember,viewer,{});
 const owner=sqlRule(rules.householdOwner,viewer,{});
 return db.query.members.findFirst({
  columns:{id:true},
  where:f=>and(eq(f.id,viewer.id),sql`${{getSQL:()=>current}}`),
  extras:()=>({manage:sql`${{getSQL:()=>owner}}`.mapWith(Boolean).as('reader_manages')}),
 }).sync();
}
