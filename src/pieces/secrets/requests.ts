/** Trusted metadata service. External operations authenticate callers and check
 * Settings ownership before invoking answer/setRule/revoke. No value enters it. */
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from '../../core/data/database.js';
import { Conversations } from '../../core/conversations/index.js';
import { household, secrets, secretRequests, secretGrants, secretRules, secretRuleAgents, members, jobs, conversations, inbox } from '../../core/data/schema.js';
import { secretName, secretAgent, requestReason } from './input.js';
import { secretHasValue } from './presence.js';
const duration = z.number().int().min(1).max(525600);
const requestInput = z.object({ id: z.string().min(1).max(200), secret: secretName, agent: secretAgent,
  job: z.string().min(1).optional(), conversation: z.string().min(1).optional(), why: requestReason, minutes: duration }).strict();
export type SecretRequestInput = z.input<typeof requestInput>;
type Request = typeof secretRequests.$inferSelect;
const ruleInput = z.object({ secret: secretName, answer: z.enum(['ask', 'auto', 'never']), minutes: duration,
  agents: z.array(z.object({ agent: secretAgent, when: z.enum(['on_request', 'at_start']) }).strict()) }).strict();

export class SecretRequests {
  private readonly mail: Conversations;
  constructor(readonly db: DataDatabase, readonly now: () => string = () => new Date().toISOString()) { this.mail = new Conversations(db, now); }

  request(raw: SecretRequestInput): Request {
    const input = requestInput.parse(raw);
    return this.db.transaction(() => {
      const old = this.db.select().from(secretRequests).where(eq(secretRequests.id, input.id)).get();
      if (old) {
        if (old.secret !== input.secret || old.agent !== input.agent || old.job !== (input.job ?? null) || old.conversation !== (input.conversation ?? null) || old.why !== input.why || old.minutes !== input.minutes) throw new Error('Secret request id reused');
        return old;
      }
      if (!this.db.select().from(secrets).where(eq(secrets.name, input.secret)).get() || !secretHasValue(this.db, input.secret)) throw new Error('Unknown secret');
      if (input.job) {
        const job = this.db.select().from(jobs).where(eq(jobs.id, input.job)).get();
        if (!job || job.agent !== input.agent || (input.conversation && job.conversation !== input.conversation)) throw new Error('Job does not belong to this agent and conversation');
      }
      if (input.conversation && this.db.select().from(conversations).where(eq(conversations.id, input.conversation)).get()?.agent !== input.agent) throw new Error('Conversation does not belong to this agent');
      const row = this.db.insert(secretRequests).values({ ...input, state: 'pending', always: false, askedAt: this.now() }).returning().get();
      const rule = this.db.select().from(secretRules).where(eq(secretRules.secret, input.secret)).get();
      const applies = rule && this.db.select().from(secretRuleAgents).where(and(eq(secretRuleAgents.secret, input.secret), eq(secretRuleAgents.agent, input.agent), eq(secretRuleAgents.when, 'on_request'))).get();
      const decision = rule ? applies ? rule.answer : 'ask' : this.db.select().from(household).get()?.secretsDefault ?? 'ask';
      if (decision !== 'ask') return this.settle(row, 'rule', decision === 'auto', false, Math.min(input.minutes, rule?.minutes ?? input.minutes));
      const owners = this.db.select().from(members).where(eq(members.role, 'owner')).all();
      if (!owners.length) throw new Error('A secret request needs a household owner');
      for (const owner of owners) this.mail.send({ toKind: 'person', to: owner.id, source: 'secret-request', sourceId: row.id, conversation: input.conversation,
        fromKind: 'agent', fromId: input.agent, agent: input.agent, words: `Allow ${input.agent} to use ${input.secret} for ${input.minutes} minutes?`, why: input.why, answers: 'yes-no', waitsOnKind: 'secret-request', waitsOnId: row.id, refs: [row.id] });
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
        if (!agents.some(a => a.agent === row.agent && a.when === 'on_request')) agents.push({ agent: row.agent, when: 'on_request' });
        this.setRule({ secret: row.secret, answer, minutes: row.minutes, agents });
      }
      return this.settle(row, by, allow, always, row.minutes);
    });
  }

  setRule(raw: z.input<typeof ruleInput>): void {
    const input = ruleInput.parse(raw);
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

  grantFor(secret: string, agent: string, job?: string): typeof secretGrants.$inferSelect | undefined {
    if (!secretHasValue(this.db, secret)) return;
    const at = this.now();
    return this.db.select().from(secretGrants).where(and(eq(secretGrants.secret, secret), eq(secretGrants.agent, agent), sql`julianday(${secretGrants.expiresAt}) > julianday(${at})`, sql`julianday(${secretGrants.grantedAt}) <= julianday(${at})`, or(isNull(secretGrants.job), job ? eq(secretGrants.job, job) : isNull(secretGrants.job)))).get();
  }

  /** Trusted job-start composition only: derive the agent from the saved job.
   * Explicit at_start permission is separate from on_request auto permission;
   * 'ask' permits an explicitly listed startup agent; 'never' denies it. Household
   * defaults and house alias configuration alone do not grant startup access.
   * No values leave here: composition commits, then uses SecretDelivery for each
   * selected house secret. It binds the authenticated sink and job lifecycle.
   * Retries keep the original deadline, including after expiry or a rule edit.
   * Existing grants survive rule edits; revoke them separately if needed. */
  grantAtStart(jobId: string): (typeof secretGrants.$inferSelect)[] {
    z.string().min(1).max(200).parse(jobId);
    return this.db.transaction(() => {
      const job = this.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
      if (!job) throw new Error('Unknown startup job');
      const at = this.now();
      const rules = this.db.select({ secret: secretRules.secret, minutes: secretRules.minutes })
        .from(secretRules).innerJoin(secretRuleAgents, eq(secretRules.secret, secretRuleAgents.secret))
        .where(and(eq(secretRuleAgents.agent, job.agent), eq(secretRuleAgents.when, 'at_start'),
          or(eq(secretRules.answer, 'ask'), eq(secretRules.answer, 'auto')))).all();
      const result: (typeof secretGrants.$inferSelect)[] = [];
      for (const rule of rules) {
        if (!secretHasValue(this.db, rule.secret)) continue;
        const minutes = duration.parse(rule.minutes);
        const id = `sg-start-${createHash('sha256').update(JSON.stringify([jobId, rule.secret])).digest('hex')}`;
        this.db.insert(secretGrants).values({ id, secret: rule.secret, agent: job.agent, job: jobId,
          grantedBy: 'rule', grantedAt: at, expiresAt: new Date(Date.parse(at) + minutes * 60000).toISOString() })
          .onConflictDoNothing({ target: secretGrants.id }).run();
        const grant = this.db.select().from(secretGrants).where(eq(secretGrants.id, id)).get()!;
        if (grant.secret !== rule.secret || grant.agent !== job.agent || grant.job !== jobId || grant.request !== null || grant.grantedBy !== 'rule') throw new Error('Startup grant identity changed');
        if (Date.parse(grant.grantedAt) <= Date.parse(at) && Date.parse(at) < Date.parse(grant.expiresAt)) result.push(grant);
      }
      return result;
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
    // Source-specific resolution until Conversations exposes secret-request.
    this.db.update(inbox).set({ state: 'resolved', resolution: reason, changedAt: this.now() }).where(and(eq(inbox.source, 'secret-request'), eq(inbox.sourceId, id), eq(inbox.state, 'waiting'))).run();
  }
}
