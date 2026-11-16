/** Trusted household membership and agent appearance over the shared schema. */
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from '../core/data/database.js';
import { agents, members, memberAgents, household, backupRecipients } from '../core/data/schema.js';
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
const zone = z.string().min(1).max(100).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, 'Unknown time zone');
/** A patch: only the named settings change. An empty backup target turns backups off. */
export const settingsInput = z.object({
  defaultAgent: id.nullable(), timezone: zone, commsDays: z.number().int().min(1).max(14),
  githubOwner: z.string().regex(/^(?:[A-Za-z0-9][A-Za-z0-9-]{0,38})?$/),
  backupTarget: z.string().trim().max(500), backupAt: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  backupKeep: z.number().int().min(1).max(90),
  backupRecipients: z.array(z.string().trim().regex(/^(?:age1[0-9a-z]{20,100}|ssh-(?:ed25519|rsa) [A-Za-z0-9+/=]{40,1000}(?: [^\r\n]{0,100})?)$/)).max(50).transform(values => [...new Set(values)].sort()),
}).partial().strict().refine(value => Object.keys(value).length > 0, 'Name at least one setting');
export class HouseholdError extends Error {
  constructor(readonly code: 'invalid' | 'conflict', message: string) { super(message); }
}
export function householdService(db: DataDatabase, now: () => string) {
  return {
    /** Initial settings belong to the household, not the first browser's zone.
     * Seed from this server once; never replace a stored household choice. */
    initialize(defaultAgent: string | null = null) {
      db.insert(household).values({defaultAgent,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'}).onConflictDoNothing().run();
    },
    synchronizeFullOwners(){db.insert(memberAgents).select(db.select({member:members.id,agent:agents.id}).from(members).crossJoin(agents).where(eq(members.fullOwner,true))).onConflictDoNothing().run();},
    setMember(input: z.input<typeof memberInput>) {
      const value = memberInput.parse(input);
      return db.transaction(() => {
        const old = db.select().from(members).where(eq(members.id, value.id)).get();
        if (old?.role === 'owner' && value.role !== 'owner' && !db.select({ id: members.id }).from(members)
          .where(sql`${members.role} = 'owner' and ${members.id} <> ${value.id}`).get())
          throw new HouseholdError('conflict', 'At least one household owner must remain');
        const owned=value.fullOwner?db.select({id:agents.id}).from(agents).all().map(row=>row.id):value.agents;
        for (const agent of owned) if (!db.select({ id: agents.id }).from(agents).where(eq(agents.id, agent)).get())
          throw new HouseholdError('invalid', 'Unknown agent');
        db.insert(members).values({ id: value.id, role: value.role, fullOwner: value.fullOwner, joinedAt: old?.joinedAt ?? now() })
          .onConflictDoUpdate({ target: members.id, set: { role: value.role, fullOwner: value.fullOwner } }).run();
        db.delete(memberAgents).where(eq(memberAgents.member, value.id)).run();
        for (const agent of owned) db.insert(memberAgents).values({ member: value.id, agent }).run();
        return { id: value.id };
      });
    },
    setAgent(input: z.input<typeof agentInput>) {
      const value = agentInput.parse(input);
      return db.transaction(()=>{
      const old = db.select().from(agents).where(eq(agents.id, value.id)).get();
      const visualChanged = old && (['markBg', 'markFg', 'faceShape', 'faceEyes'] as const).some(key => old[key] !== value[key]);
      db.insert(agents).values(value).onConflictDoUpdate({ target: agents.id, set: {
        about: value.about, markBg: value.markBg, markFg: value.markFg, faceShape: value.faceShape, faceEyes: value.faceEyes,
        ...(visualChanged ? { spriteVersion: null } : {}),
      } }).run();
      for(const owner of db.select({id:members.id}).from(members).where(eq(members.fullOwner,true)).all())db.insert(memberAgents).values({member:owner.id,agent:value.id}).onConflictDoNothing().run();
      return { id: value.id };
      });
    },
    settings() {
      const row = db.select().from(household).get();
      return { defaultAgent: row?.defaultAgent ?? null, timezone: row?.timezone ?? 'UTC', commsDays: row?.commsDays ?? 14, githubOwner: row?.githubOwner ?? '',
        secretsDefault: row?.secretsDefault ?? 'ask', backupTarget: row?.backupTarget ?? '', backupAt: row?.backupAt ?? '03:00', backupKeep: row?.backupKeep ?? 7,
        backupRecipients: db.select().from(backupRecipients).orderBy(asc(backupRecipients.recipient)).all().map(entry => entry.recipient) };
    },
    setSettings(input: z.input<typeof settingsInput>) {
      const { backupRecipients: recipients, ...row } = settingsInput.parse(input);
      return db.transaction(() => {
        if (row.defaultAgent && !db.select({ id: agents.id }).from(agents).where(eq(agents.id, row.defaultAgent)).get())
          throw new HouseholdError('invalid', 'Unknown agent');
        if (Object.keys(row).length) db.insert(household).values(row).onConflictDoUpdate({ target: household.singleton, set: row }).run();
        if (recipients) {
          db.delete(backupRecipients).run();
          if (recipients.length) db.insert(backupRecipients).values(recipients.map(recipient => ({ recipient }))).run();
        }
        return { saved: true as const };
      });
    },
    members() {
      return db.select().from(members).orderBy(asc(members.position), asc(members.id)).all().map(member => ({ ...member,
        agents: db.select({ id: memberAgents.agent }).from(memberAgents).where(eq(memberAgents.member, member.id)).orderBy(asc(memberAgents.agent)).all().map(row => row.id),
      }));
    },
  };
}
