/** Trusted household membership and agent appearance over the shared schema. */
import { tightenSessionDeadlines } from '../core/conversations/sessions.js';
import { HH_MM } from '../core/tempo/calendar.js';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from '../core/data/database.js';
import { agents, members, memberAgents, household, backupRecipients, projects, bridgeConnections } from '../core/data/schema.js';
import { householdId } from '../slug.js';
import { COMMS_DAYS_MAX } from '../core/data/comms-days.js';
import { BACKUP_KEEP_MAX, householdSettings } from '../core/data/household-settings.js';
const id = householdId;
export const memberInput = z.object({
  id, role: z.enum(members.role.enumValues), fullOwner: z.boolean().default(false),
  agents: z.array(id).max(1000).transform(values => [...new Set(values)].sort()),
}).strict().refine(value => !value.fullOwner || value.role === 'owner', 'Only an owner can own every agent');
export const agentInput = z.object({
  id, about: z.string().max(600), markBg: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  markFg: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  // The choices are the schema's own (src/core/data/schema.ts), so a new shape is added in one place.
  faceShape: z.enum(agents.faceShape.enumValues), faceEyes: z.enum(agents.faceEyes.enumValues),
}).strict();
/** A GitHub user or organisation name, as GitHub allows them. */
export const GITHUB_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const zone = z.string().min(1).max(100).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, 'Unknown time zone');
/** A patch: only the named settings change. An empty backup target turns backups off. */
export const settingsInput = z.object({
  defaultAgent: id.nullable(), timezone: zone, commsDays: z.number().int().min(1).max(COMMS_DAYS_MAX),
  githubOwner: z.string().refine(value => value === '' || GITHUB_LOGIN.test(value), 'Not a GitHub name'),
  backupTarget: z.string().trim().max(500), backupAt: z.string().regex(HH_MM),
  backupKeep: z.number().int().min(1).max(BACKUP_KEEP_MAX),
  backupRecipients: z.array(z.string().trim().regex(/^(?:age1[0-9a-z]{20,100}|ssh-(?:ed25519|rsa) [A-Za-z0-9+/=]{40,1000}(?: [^\r\n]{0,100})?)$/)).max(50).transform(values => [...new Set(values)].sort()),
}).partial().strict().refine(value => Object.keys(value).length > 0, 'Name at least one setting');
/** What can be removed and restored: its row stays (setRemoved). */
/** The household's answer for a secret no rule names: the choices are the column's own. */
export const secretsDefaultInput = z.enum(household.secretsDefault.enumValues);
export type SecretsDefault = z.infer<typeof secretsDefaultInput>;
export const removable = z.enum(['member', 'agent', 'project', 'bridge']);
export type Removable = z.infer<typeof removable>;
export class HouseholdError extends Error {
  constructor(readonly code: 'invalid' | 'conflict' | 'not-found', message: string) { super(message); }
}
export function householdService(db: DataDatabase, now: () => string) {
  /** The household's one row, made if it is not there. Its first timezone is this server's, whichever
   * write makes the row; a stored household choice is never replaced. */
  const seed = (defaultAgent: string | null = null) => {
    db.insert(household).values({defaultAgent,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'}).onConflictDoNothing().run();
  };
  const validateMember = (value: z.infer<typeof memberInput>) => {
    const old = db.select().from(members).where(eq(members.id, value.id)).get();
    if (old?.role === 'owner' && value.role !== 'owner' && !db.select({ id: members.id }).from(members)
      .where(sql`${members.role} = 'owner' and ${members.removedAt} is null and ${members.id} <> ${value.id}`).get())
      throw new HouseholdError('conflict', 'At least one household owner must remain');
    const { agents: requested, fullOwner } = value;
    const found = db.select({ id: agents.id }).from(agents).where(fullOwner ? undefined : inArray(agents.id, requested)).all();
    if (!fullOwner && found.length !== new Set(requested).size) throw new HouseholdError('invalid', 'Unknown agent');
    const owned = fullOwner ? found.map(row => row.id) : requested;
    return { old, owned };
  };
  const validateRemoval = (of: Removable, id: string, removed: boolean) => {
    const table = of === 'member' ? members : of === 'agent' ? agents : of === 'project' ? projects : bridgeConnections;
    const row = db.select({ id: table.id, removedAt: table.removedAt }).from(table).where(eq(table.id, id)).get();
    if (!row) throw new HouseholdError('not-found', 'No ' + of + ' has that id');
    if (!!row.removedAt === removed) throw new HouseholdError('invalid', removed ? 'That is already removed' : 'That is not removed');
    if (removed && of === 'member' && !db.select({ id: members.id }).from(members).where(sql`${members.role} = 'owner' and ${members.removedAt} is null and ${members.id} <> ${id}`).get())
      throw new HouseholdError('conflict', 'At least one household owner must remain');
    if (removed && of === 'agent' && db.select().from(household).get()?.defaultAgent === id) throw new HouseholdError('conflict', 'Choose another default agent first');
  };
  const validateSettings = (row: z.infer<typeof settingsInput>) => {
    if (row.defaultAgent && !db.select({ id: agents.id }).from(agents).where(eq(agents.id, row.defaultAgent)).get())
      throw new HouseholdError('invalid', 'Unknown agent');
  };
  const validateOrder = (of: 'members' | 'agents', ids: readonly string[]) => {
    const table = of === 'members' ? members : agents;
    const have = db.select({ id: table.id }).from(table).all().map(row => row.id);
    if (new Set(ids).size !== ids.length || have.length !== ids.length || have.some(id => !ids.includes(id)))
      throw new HouseholdError('invalid', 'Name every one of the ' + of + ' exactly once');
  };
  return {
    validateMember, validateRemoval, validateSettings, validateOrder,
    /** Initial settings belong to the household, not the first browser's zone. */
    initialize(defaultAgent: string | null = null) { seed(defaultAgent); },
    synchronizeFullOwners(){db.insert(memberAgents).select(db.select({member:members.id,agent:agents.id}).from(members).crossJoin(agents).where(eq(members.fullOwner,true))).onConflictDoNothing().run();},
    setMember(input: z.input<typeof memberInput>) {
      const value = memberInput.parse(input);
      return db.transaction(() => {
        const { old, owned } = validateMember(value);
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
    /** Remove keeps the row and everything that refers to it. A removed person cannot sign in, a removed
     * agent does not run and its bridge connections are switched off, a removed project grants nobody
     * anything (shared-sharing.ts), a removed connection is switched off. Restore puts it back. */
    setRemoved(of: Removable, id: string, removed: boolean) {
      return db.transaction(() => {
        validateRemoval(of, id, removed);
        const table = of === 'member' ? members : of === 'agent' ? agents : of === 'project' ? projects : bridgeConnections;
        db.update(table).set({ removedAt: removed ? now() : null }).where(eq(table.id, id)).run();
        // A removed connection is switched off. Restoring it leaves it off until someone turns it on.
        if (of === 'bridge' && removed) db.update(bridgeConnections).set({ enabled: false, state: 'disconnected', stateAt: now() }).where(eq(bridgeConnections.id, id)).run();
        // A removed agent never runs, so messages to it would arrive for nobody: its connections are switched
        // off with it. They stay its own, and stay off after a restore until someone turns them on.
        if (of === 'agent' && removed) db.update(bridgeConnections).set({ enabled: false, state: 'disconnected', stateAt: now() }).where(and(eq(bridgeConnections.agent, id), eq(bridgeConnections.enabled, true))).run();
        return { id };
      });
    },
    settings() {
      // What an unset household has is answered in one place (core/data/household-settings.ts).
      return { ...householdSettings(db),
        backupRecipients: db.select().from(backupRecipients).orderBy(asc(backupRecipients.recipient)).all().map(entry => entry.recipient) };
    },
    setSettings(input: z.input<typeof settingsInput>) {
      const { backupRecipients: recipients, ...row } = settingsInput.parse(input);
      return db.transaction(() => {
        validateSettings(row);
        if (Object.keys(row).length) { seed(); db.update(household).set(row).run(); }
        if (row.commsDays !== undefined) tightenSessionDeadlines(db, row.commsDays);
        if (recipients) {
          db.delete(backupRecipients).run();
          if (recipients.length) db.insert(backupRecipients).values(recipients.map(recipient => ({ recipient }))).run();
        }
        return { saved: true as const };
      });
    },
    /** What a request for a secret is answered with when no rule covers it. Its own door and its own card,
     * apart from the settings above; written here so the household row has one writer. */
    setSecretsDefault(raw: SecretsDefault) {
      const secretsDefault = secretsDefaultInput.parse(raw);
      db.transaction(() => { seed(); db.update(household).set({ secretsDefault }).run(); });
    },
    /** The order members or agents are listed in: every one of them, named exactly once. */
    setOrder(of: 'members' | 'agents', ids: readonly string[]) {
      return db.transaction(() => {
        validateOrder(of, ids);
        const table = of === 'members' ? members : agents;
        ids.forEach((id, position) => db.update(table).set({ position }).where(eq(table.id, id)).run());
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
