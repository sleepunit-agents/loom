/** Current consent for public agent-to-agent work, at enqueue and release. */
import {and,eq,inArray} from 'drizzle-orm';
import type {DataDatabase} from '../data/database.js';
import {memberAgents,projectAgents} from '../data/schema.js';
export function handoffPeersAssigned(db:DataDatabase,from:string,to:string,project:string|null):boolean {
 if(project!==null)return [from,to].every(agent=>!!db.select().from(projectAgents).where(and(eq(projectAgents.project,project),eq(projectAgents.agent,agent))).get());
 return !!db.select().from(memberAgents).where(and(eq(memberAgents.agent,to),inArray(memberAgents.member,db.select({member:memberAgents.member}).from(memberAgents).where(eq(memberAgents.agent,from))))).get();
}
