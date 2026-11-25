import {and,desc,eq} from 'drizzle-orm';
import type {DataDatabase} from './database.js';
import {projectClaimDirections as directions} from './schema.js';

export function projectClaimDirection(db:DataDatabase,project:string,agent:string) {
  return db.select().from(directions).where(and(eq(directions.project,project),eq(directions.agent,agent)))
    .orderBy(desc(directions.seq)).limit(1).get();
}
