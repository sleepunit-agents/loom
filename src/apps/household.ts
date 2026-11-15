/** Trusted household membership and agent appearance over the shared schema. */
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from '../core/data/database.js';
import { agents, members, memberAgents, projects, projectMembers, projectAgents, projectRepositories, agentAccounts } from '../core/data/schema.js';
const id = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100);
export const memberInput = z.object({
  id, role: z.enum(['owner', 'member']), fullOwner: z.boolean().default(false),
  agents: z.array(id).max(1000).transform(values => [...new Set(values)].sort()),
}).strict().refine(value => !value.fullOwner || value.role === 'owner', 'Only an owner can own every agent');
export const agentInput = z.object({
  id, about: z.string().max(600), markBg: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  markFg: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  faceShape: z.enum(['pebble', 'trefoil', 'clover', 'drop']), faceEyes: z.enum(['dot', 'oval']),
}).strict();
export class HouseholdError extends Error {
  constructor(readonly code: 'invalid' | 'conflict', message: string) { super(message); }
}
export function householdService(db: DataDatabase, now: () => string) {
  return {
    /** Trusted setup for the sharing labels used by work apps. Callers from
     * outside still go through owner-controlled household administration. */
    setProject(input: {id:string;name:string;members:string[];agents:string[];repositories:string[]}) {
      const value=z.object({id,name:z.string().trim().min(1),members:z.array(id),agents:z.array(id),
        repositories:z.array(z.string().regex(/^(?:github:)?[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/).transform(v=>v.replace(/^github:/,'').toLowerCase()))}).strict().parse(input);
      return db.transaction(()=>{
        for(const member of value.members)if(!db.select().from(members).where(eq(members.id,member)).get())throw new HouseholdError('invalid','Unknown member');
        for(const agent of value.agents)if(!db.select().from(agents).where(eq(agents.id,agent)).get())throw new HouseholdError('invalid','Unknown agent');
        for(const repository of value.repositories)if(db.select().from(projectRepositories).all().some(row=>row.project!==value.id&&row.repository.replace(/^github:/,'').toLowerCase()===repository))throw new HouseholdError('conflict','Repository already belongs to another project');
        db.insert(projects).values({id:value.id,name:value.name}).onConflictDoUpdate({target:projects.id,set:{name:value.name}}).run();
        db.delete(projectMembers).where(eq(projectMembers.project,value.id)).run();
        db.delete(projectAgents).where(eq(projectAgents.project,value.id)).run();
        db.delete(projectRepositories).where(eq(projectRepositories.project,value.id)).run();
        for(const member of new Set(value.members))db.insert(projectMembers).values({project:value.id,member}).run();
        for(const agent of new Set(value.agents))db.insert(projectAgents).values({project:value.id,agent}).run();
        for(const repository of new Set(value.repositories))db.insert(projectRepositories).values({project:value.id,repository}).run();
        return {id:value.id};
      });
    },
    setGithubAccounts(input:{agent:string;logins:string[]}) {
      const value=z.object({agent:id,logins:z.array(z.string().regex(/^[A-Za-z0-9-]+$/).max(100).transform(v=>v.toLowerCase()))}).strict().parse(input);
      return db.transaction(()=>{
        if(!db.select().from(agents).where(eq(agents.id,value.agent)).get())throw new HouseholdError('invalid','Unknown agent');
        for(const login of value.logins)if(db.select().from(agentAccounts).all().some(row=>row.agent!==value.agent&&row.service==='github'&&row.login.toLowerCase()===login))throw new HouseholdError('conflict','GitHub login already belongs to another agent');
        db.delete(agentAccounts).where(and(eq(agentAccounts.agent,value.agent),eq(agentAccounts.service,'github'))).run();
        for(const login of new Set(value.logins))db.insert(agentAccounts).values({agent:value.agent,service:'github',login}).run();
        return {id:value.agent};
      });
    },
    setMember(input: z.input<typeof memberInput>) {
      const value = memberInput.parse(input);
      return db.transaction(() => {
        const old = db.select().from(members).where(eq(members.id, value.id)).get();
        if (old?.role === 'owner' && value.role !== 'owner' && !db.select({ id: members.id }).from(members)
          .where(sql`${members.role} = 'owner' and ${members.id} <> ${value.id}`).get())
          throw new HouseholdError('conflict', 'At least one household owner must remain');
        for (const agent of value.agents) if (!db.select({ id: agents.id }).from(agents).where(eq(agents.id, agent)).get())
          throw new HouseholdError('invalid', 'Unknown agent');
        db.insert(members).values({ id: value.id, role: value.role, fullOwner: value.fullOwner, joinedAt: old?.joinedAt ?? now() })
          .onConflictDoUpdate({ target: members.id, set: { role: value.role, fullOwner: value.fullOwner } }).run();
        db.delete(memberAgents).where(eq(memberAgents.member, value.id)).run();
        for (const agent of value.agents) db.insert(memberAgents).values({ member: value.id, agent }).run();
        return { id: value.id };
      });
    },
    setAgent(input: z.input<typeof agentInput>) {
      const value = agentInput.parse(input);
      const old = db.select().from(agents).where(eq(agents.id, value.id)).get();
      const visualChanged = old && (['markBg', 'markFg', 'faceShape', 'faceEyes'] as const).some(key => old[key] !== value[key]);
      db.insert(agents).values(value).onConflictDoUpdate({ target: agents.id, set: {
        about: value.about, markBg: value.markBg, markFg: value.markFg, faceShape: value.faceShape, faceEyes: value.faceEyes,
        ...(visualChanged ? { spriteVersion: null } : {}),
      } }).run();
      return { id: value.id };
    },
    members() {
      return db.select().from(members).orderBy(asc(members.position), asc(members.id)).all().map(member => ({ ...member,
        agents: db.select({ id: memberAgents.agent }).from(memberAgents).where(eq(memberAgents.member, member.id)).orderBy(asc(memberAgents.agent)).all().map(row => row.id),
      }));
    },
  };
}
