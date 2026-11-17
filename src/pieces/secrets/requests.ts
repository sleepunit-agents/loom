/** Trusted metadata service. External operations authenticate callers and check
 * Settings ownership before invoking answer/setRule/revoke. No value enters it.
 *
 * `standing` is the door's answer to one question of policy.ts (standingSecretAnswerServes): may a
 * standing answer serve this work? Where it may not, a rule or the household default never allows a
 * request (it can still refuse one), and only a grant a household owner gave for that very job counts. */
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, ne, sql, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from '../../core/data/database.js';
import { Conversations } from '../../core/conversations/index.js';
import { secrets, secretRequests, secretGrants, secretRules, secretRuleAgents, members, jobs, conversations } from '../../core/data/schema.js';
import { householdOwners } from '../../shared-sharing.js';
import { householdSettings } from '../../core/data/household-settings.js';
import { secretName, secretAgent, requestReason } from './input.js';
import { secretHasValue } from './presence.js';
const duration = z.number().int().min(1).max(525600);
const requestInput = z.object({ id: z.string().min(1).max(200), secret: secretName, agent: secretAgent,
  job: z.string().min(1).optional(), conversation: z.string().min(1).optional(), why: requestReason, minutes: duration }).strict();
/** How long a standing answer lets a secret be used when no rule has said. */
const UNSET_RULE_MINUTES = 30;
/** Who answered, on a request or a grant that a rule or the household default settled. Any other value is
 * the member who answered. A member whose id is this word is taken for a rule where the two differ, and
 * that only ever refuses. */
export const BY_RULE = 'rule';
export type SecretRequestInput = z.input<typeof requestInput>;
type Request = typeof secretRequests.$inferSelect;
export const secretRuleInput = z.object({ secret: secretName, answer: z.enum(['ask', 'auto', 'never']), minutes: duration,
  agents: z.array(z.object({ agent: secretAgent, when: z.enum(['on_request', 'at_start']) }).strict()) }).strict();

export class SecretRequests {
  private readonly mail: Conversations;
  constructor(readonly db: DataDatabase, readonly now: () => string = () => new Date().toISOString()) { this.mail = new Conversations(db, now); }

  request(raw: SecretRequestInput, when: 'on_request' | 'at_start' = 'on_request', standing = true): Request {
    const input = requestInput.parse(raw);
    return this.db.transaction(() => {
      const old = this.db.select().from(secretRequests).where(eq(secretRequests.id, input.id)).get();
      if (old) {
        if (old.secret !== input.secret || old.agent !== input.agent || old.job !== (input.job ?? null) || old.conversation !== (input.conversation ?? null) || old.why !== input.why || old.minutes !== input.minutes) throw new Error('Secret request id reused');
        return old;
      }
      if (!this.db.select().from(secrets).where(eq(secrets.name, input.secret)).get() || !secretHasValue(this.db, input.secret)) throw new Error('Unknown secret');
      const job = input.job ? this.db.select().from(jobs).where(eq(jobs.id, input.job)).get() : undefined;
      // An answer for the agent and no one job is a standing answer.
      if (!standing && !input.job) throw new Error('This work asks for a secret one job at a time');
      if (input.job) {
        if (!job || job.agent !== input.agent || (input.conversation && job.conversation !== input.conversation)) throw new Error('Job does not belong to this agent and conversation');
      }
      if (input.conversation && this.db.select().from(conversations).where(eq(conversations.id, input.conversation)).get()?.agent !== input.agent) throw new Error('Conversation does not belong to this agent');
      const row = this.db.insert(secretRequests).values({ ...input, state: 'pending', always: false, askedAt: this.now() }).returning().get();
      const rule = this.db.select().from(secretRules).where(eq(secretRules.secret, input.secret)).get();
      const applies = rule && this.db.select().from(secretRuleAgents).where(and(eq(secretRuleAgents.secret, input.secret), eq(secretRuleAgents.agent, input.agent), eq(secretRuleAgents.when, when))).get();
      const settled = rule ? applies ? rule.answer : 'ask' : householdSettings(this.db).secretsDefault;
      const decision = settled === 'auto' && !standing ? 'ask' : settled;
      if (decision !== 'ask') return this.settle(row, BY_RULE, decision === 'auto', false, Math.min(input.minutes, rule?.minutes ?? input.minutes));
      const owners = householdOwners(this.db);
      if (!owners.length) throw new Error('A secret request needs a household owner');
      for (const owner of owners) this.mail.send({ toKind: 'person', to: owner, source: 'secret-request', sourceId: row.id, conversation: input.conversation,
        fromKind: 'agent', fromId: input.agent, agent: input.agent, words: `Allow ${input.agent} to use ${input.secret} for ${input.minutes} minutes${job?.member ? `, in its private work for ${job.member}` : ''}?`, why: input.why, answers: 'yes-no', waitsOnKind: 'secret-request', waitsOnId: row.id, refs: [row.id] });
      return row;
    });
  }

  /** Always writes the standing answer for the requesting agent. The schema has
   * one answer per secret; changing its answer replaces its agent list. Adding
   * an agent to the same answer preserves the other listed agents. */
  answer(id: string, by: string, allow: boolean, always = false): Request {
    return this.db.transaction(() => {
      if (!this.db.select().from(members).where(eq(members.id, by)).get()) throw new Error('Unknown answering member');
      const row = this.read(id);
      if (row.state !== 'pending') return row;
      if (always) {
        const answer = allow ? 'auto' : 'never';
        const old = this.db.select().from(secretRules).where(eq(secretRules.secret, row.secret)).get();
        const agents = old?.answer === answer ? this.db.select().from(secretRuleAgents).where(eq(secretRuleAgents.secret, row.secret)).all().map(a => ({ agent: a.agent, when: a.when })) : [];
        const when = row.job && row.id === startupRequestId(row.job, row.secret) ? 'at_start' : 'on_request';
        if (!agents.some(a => a.agent === row.agent && a.when === when)) agents.push({ agent: row.agent, when });
        this.setRule({ secret: row.secret, answer, minutes: row.minutes, agents });
      }
      return this.settle(row, by, allow, always, row.minutes);
    });
  }

  setRule(raw: z.input<typeof secretRuleInput>): void {
    const input = secretRuleInput.parse(raw);
    this.db.transaction(() => {
      this.db.insert(secretRules).values({ secret: input.secret, answer: input.answer, minutes: input.minutes }).onConflictDoUpdate({ target: secretRules.secret, set: { answer: input.answer, minutes: input.minutes } }).run();
      this.db.delete(secretRuleAgents).where(eq(secretRuleAgents.secret, input.secret)).run();
      for (const agent of input.agents) this.db.insert(secretRuleAgents).values({ secret: input.secret, ...agent }).onConflictDoNothing().run();
    });
  }

  cancel(id: string): Request {
    return this.db.transaction(() => {
      const row = this.read(id);
      if (row.state !== 'pending') return row;
      this.db.update(secretRequests).set({ state: 'cancelled', answeredAt: this.now() }).where(eq(secretRequests.id, id)).run();
      this.resolve(id, 'cancelled');
      return this.read(id);
    });
  }

  revoke(id: string): Request {
    return this.db.transaction(() => {
      const row = this.read(id);
      if (row.state !== 'allowed') return row;
      this.db.delete(secretGrants).where(eq(secretGrants.request, id)).run();
      this.db.update(secretRequests).set({ state: 'revoked', answeredAt: this.now() }).where(eq(secretRequests.id, id)).run();
      return this.read(id);
    });
  }

  /** One grant, taken back by its id. A grant that answers a request goes with that request's revocation. */
  revokeGrant(id: string): void {
    this.db.transaction(() => {
      const grant = this.db.select().from(secretGrants).where(eq(secretGrants.id, id)).get();
      if (!grant) throw new Error('Unknown grant');
      if (grant.request) this.revoke(grant.request);
      else this.db.delete(secretGrants).where(eq(secretGrants.id, id)).run();
    });
  }

  /** The secret's value is gone, so nothing may wait on it or use it: every open request is cancelled,
   * every allowed one revoked, every grant deleted, and the standing answer returns to asking with no
   * listed agents. Its length of use is kept. Runs in the caller's transaction, with the value's removal. */
  removed(secret: string): void {
    this.db.transaction(() => {
      for (const request of this.db.select().from(secretRequests).where(eq(secretRequests.secret, secret)).all()) {
        if (request.state === 'pending') this.cancel(request.id);
        else if (request.state === 'allowed') this.revoke(request.id);
      }
      this.db.delete(secretGrants).where(eq(secretGrants.secret, secret)).run();
      const minutes = this.db.select().from(secretRules).where(eq(secretRules.secret, secret)).get()?.minutes ?? UNSET_RULE_MINUTES;
      this.setRule({ secret, answer: 'ask', minutes, agents: [] });
    });
  }

  /** A current grant of this secret to this agent: one for this job, or one for the agent and no one job.
   * Without `standing`, only one a household owner gave for this very job. */
  grantFor(secret: string, agent: string, job?: string, request?: string, standing = true): typeof secretGrants.$inferSelect | undefined {
    if (!secretHasValue(this.db, secret) || !standing && !job) return;
    const at = this.now();
    return this.db.select().from(secretGrants).where(and(eq(secretGrants.secret, secret), eq(secretGrants.agent, agent), request ? eq(secretGrants.request, request) : undefined,
      standing ? undefined : and(eq(secretGrants.job, job!), ne(secretGrants.grantedBy, BY_RULE)), sql`julianday(${secretGrants.expiresAt}) > julianday(${at})`, sql`julianday(${secretGrants.grantedAt}) <= julianday(${at})`, or(isNull(secretGrants.job), job ? eq(secretGrants.job, job) : isNull(secretGrants.job)))).get();
  }

  /** Startup permissions use durable requests, so expiry, denial and explicit
   * revocation survive retries and process restarts. Rule edits do not revoke
   * an already issued grant. Aliases alone never authorize a startup handoff. */
  grantAtStart(jobId: string, selected?: readonly string[], standing = true): (typeof secretGrants.$inferSelect)[] {
    z.string().min(1).max(200).parse(jobId);
    return this.db.transaction(() => {
      const job = this.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
      if (!job) throw new Error('Unknown startup job');
      const rules = this.db.select({ secret: secretRules.secret, minutes: secretRules.minutes })
        .from(secretRules).innerJoin(secretRuleAgents, eq(secretRules.secret, secretRuleAgents.secret))
        .where(and(eq(secretRuleAgents.agent, job.agent), eq(secretRuleAgents.when, 'at_start'))).all().filter(rule => !selected || selected.includes(rule.secret));
      for (const rule of rules) {
        if (!secretHasValue(this.db, rule.secret)) continue;
        const id = startupRequestId(jobId, rule.secret);
        if (this.db.select().from(secretRequests).where(eq(secretRequests.id, id)).get()) continue;
        this.request({ id, secret: rule.secret, agent: job.agent, job: jobId,
          ...(job.conversation ? { conversation: job.conversation } : {}),
          why: 'The house needs this secret when its job starts.', minutes: duration.parse(rule.minutes) }, 'at_start', standing);
      }
      const at = Date.parse(this.now());
      return this.db.select().from(secretGrants).where(and(eq(secretGrants.job, jobId), eq(secretGrants.agent, job.agent))).all()
        .filter(grant => (!selected || selected.includes(grant.secret)) && grant.request === startupRequestId(jobId, grant.secret)
          && (standing || grant.grantedBy !== BY_RULE)
          && this.read(grant.request).state === 'allowed' && secretHasValue(this.db, grant.secret)
          && Date.parse(grant.grantedAt) <= at && at < Date.parse(grant.expiresAt));
    });
  }

  private read(id: string): Request {
    const row = this.db.select().from(secretRequests).where(eq(secretRequests.id, id)).get();
    if (!row) throw new Error('Unknown secret request');
    return row;
  }
  private settle(row: Request, by: string, allow: boolean, always: boolean, minutes: number): Request {
    const at = this.now();
    this.db.update(secretRequests).set({ state: allow ? 'allowed' : 'denied', answeredBy: by, answeredAt: at, always }).where(eq(secretRequests.id, row.id)).run();
    if (allow) this.db.insert(secretGrants).values({ id: `sg-${randomUUID()}`, secret: row.secret, agent: row.agent, job: row.job, request: row.id, grantedBy: by, grantedAt: at, expiresAt: new Date(Date.parse(at) + minutes * 60000).toISOString() }).run();
    this.resolve(row.id, allow ? 'allowed' : 'denied');
    return this.read(row.id);
  }
  private resolve(id: string, reason: string): void {
    this.mail.resolveSource('secret-request', id, reason);
  }
}

export function startupRequestId(job: string, secret: string): string {
  return `q-start-${createHash('sha256').update(JSON.stringify([job, secret])).digest('hex')}`;
}
