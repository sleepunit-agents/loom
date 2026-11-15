import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from '../core/data/database.js';
import { approvals, approvalRecord, approvalNotices, members } from '../core/data/schema.js';
import { Conversations } from '../core/conversations/index.js';

export type Approval = typeof approvals.$inferSelect;
const request = z.object({
  kind: z.enum(['merge', 'command', 'setting', 'dangerous']), target: z.string().trim().min(1),
  what: z.string().trim().min(1), why: z.string().trim().min(1), agent: z.string().min(1),
  askedFrom: z.string().min(1), actingFor: z.string().min(1), project: z.string().min(1).nullable().default(null),
  member: z.string().min(1).nullable().default(null), conversation: z.string().min(1).nullable().default(null),
  minutes: z.number().int().positive().default(30), ask: z.string().trim().min(1),
  ifYes: z.string().trim().min(1), ifNo: z.string().trim().min(1), details: z.string().default(''),
  operation: z.string().min(1).nullable().default(null), changeSummary: z.string().trim().min(1).nullable().default(null),
});
export type ApprovalRequest = z.input<typeof request>;
/** These handlers are synchronous database operations on the same connection.
 * They must perform no network, filesystem or other outside side effects. A
 * producer names a prepared operation and includes its exact before/after on
 * the card. Unknown operations are refused; no shell text is ever executed.
 */
export type ApprovedOperations = ReadonlyMap<string, (approval: Approval) => void>;

/** Trusted application interface. Authenticated person/agent checks belong at
 * the external door; this service still binds a spend to agent, kind and target.
 */
export function approvalService(db: DataDatabase, operations: ApprovedOperations = new Map(), now: () => string = () => new Date().toISOString()) {
  const mail = new Conversations(db, now);
  const answer = (row: Approval, member: string, allowed: boolean) => {
    const questions = mail.resolve('approval', row.id, allowed ? 'Allowed' : 'Denied');
    // One answer returns to the asking agent, even if several owners saw it.
    // A later denial of an allowance is a new event, not a replay of its answer.
    mail.send({ toKind: 'agent', to: row.agent, conversation: row.conversation,
      source: questions.length ? 'answer' : 'approval', sourceId: questions[0]?.id ?? `${row.id}:denied`,
      fromKind: 'person', fromId: member, words: [allowed ? 'Allow' : 'Deny', row.ask, allowed ? row.ifYes : row.ifNo].join('\n'),
      project: row.project, agent: row.agent, member: row.member, refs: [row.id, ...questions.map(q => q.id)] });
  };
  const get = (id: string) => {
    const row = db.select().from(approvals).where(eq(approvals.id, id)).get();
    if (!row) throw new Error('Approval not found');
    return row;
  };
  const record = (row: Approval, event: typeof approvalRecord.$inferInsert['event'], note = '') => {
    const seq = db.select({ n: sql<number>`coalesce(max(${approvalRecord.seq}), 0) + 1` }).from(approvalRecord).get()!.n;
    db.insert(approvalRecord).values({ seq, at: now(), event, approval: row.id, agent: row.agent, note }).run();
  };
  const expire = (row: Approval) => {
    if (row.state === 'allowed' && row.expiresAt && Date.parse(row.expiresAt) <= Date.parse(now())) {
      db.update(approvals).set({ state: 'expired' }).where(eq(approvals.id, row.id)).run();
      return get(row.id);
    }
    return row;
  };
  return {
    request(input: ApprovalRequest) {
      const value = request.parse(input);
      if (value.kind === 'merge' && !/^github:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#[1-9][0-9]*@[0-9a-f]{40}$/.test(value.target)) throw new Error('A merge approval must name one exact commit');
      if ((value.kind === 'setting' || value.kind === 'dangerous') && (!value.operation || !value.changeSummary)) throw new Error('A proposed change needs an operation and before/after summary');
      if (value.operation && !operations.has(value.operation)) throw new Error('Unknown approved operation');
      return db.transaction(() => {
        const row = db.insert(approvals).values({ ...value, id: `a-${randomUUID()}`, state: 'pending', askedAt: now() }).returning().get();
        const owners = db.select().from(members).where(eq(members.role, 'owner')).orderBy(asc(members.id)).all();
        if (!owners.length) throw new Error('No household owner can answer this approval');
        for (const owner of owners) mail.send({ toKind: 'person', to: owner.id, source: 'approval', sourceId: row.id,
          fromKind: 'agent', fromId: row.agent, conversation: row.conversation, project: row.project, agent: row.agent, member: row.member,
          words: row.ask, why: row.why, answers: 'yes-no', ifYes: row.ifYes, ifNo: row.ifNo,
          waitsOnKind: 'approval', waitsOnId: row.id, refs: [row.id] });
        record(row, 'request'); return row;
      });
    },
    get(id: string) { return db.transaction(() => expire(get(id))); },
    list() {
      return db.transaction(() => db.select().from(approvals).orderBy(asc(approvals.askedAt), asc(approvals.id)).all().map(expire));
    },
    allow(id: string, member: string, basis?: string) {
      return db.transaction(() => {
        const row = get(id);
        if (row.state !== 'pending') throw new Error('Approval is already answered');
        const at = now(), expiresAt = new Date(Date.parse(at) + row.minutes * 60000).toISOString();
        db.update(approvals).set({ state: 'allowed', decidedBy: member, decidedAt: at, expiresAt }).where(eq(approvals.id, id)).run();
        record(row, 'allow', basis ?? member);
        if (row.operation) {
          const execute = operations.get(row.operation);
          if (!execute) throw new Error('Unknown approved operation');
          execute(get(id));
          db.update(approvals).set({ state: 'used', usedAt: at }).where(eq(approvals.id, id)).run();
          record(row, 'use', row.operation);
        }
        answer(row, member, true);
        return get(id);
      });
    },
    deny(id: string, member: string) {
      return db.transaction(() => {
        const row = expire(get(id));
        if (row.state !== 'pending' && row.state !== 'allowed') throw new Error('Approval cannot be denied now');
        db.update(approvals).set({ state: 'denied', decidedBy: member, decidedAt: now(), expiresAt: null }).where(eq(approvals.id, id)).run();
        record(row, 'deny', member);
        const older = db.select().from(approvals).where(and(eq(approvals.agent, row.agent), eq(approvals.kind, row.kind), eq(approvals.target, row.target), eq(approvals.state, 'allowed'))).all();
        for (const previous of older) {
          db.update(approvals).set({ state: 'denied', overriddenBy: id, expiresAt: null }).where(eq(approvals.id, previous.id)).run();
          record(previous, 'deny', `Overridden by ${id}`);
        }
        answer(row, member, false);
        return get(id);
      });
    },
    withdraw(id: string, agent: string) {
      return db.transaction(() => {
        const row = expire(get(id));
        if (row.agent !== agent || !['pending', 'allowed'].includes(row.state)) throw new Error('Approval cannot be withdrawn');
        db.update(approvals).set({ state: 'withdrawn', expiresAt: null }).where(eq(approvals.id, id)).run();
        mail.resolve('approval', id, 'Withdrawn');
        record(row, 'withdraw'); return get(id);
      });
    },
    /** Append-only hook for an outside refusal after its effect transaction rolls back. */
    refuseUse(id: string, agent: string, note: string) {
      return db.transaction(() => {
        const row = get(id);
        if (row.agent !== agent) throw new Error('Approval belongs to another agent');
        record(row, 'refused-use', note);
      });
    },
    /** A refused spend is a result rather than an exception so its audit commits. */
    use(id: string, agent: string, kind: Approval['kind'], target: string): { ok: boolean; approval: Approval } {
      return db.transaction(() => {
        const row = expire(get(id));
        if (row.agent !== agent || row.kind !== kind || row.target !== target || row.state !== 'allowed' || row.operation) {
          record(row, 'refused-use', 'Agent, kind, target or allowance does not match');
          return { ok: false, approval: row };
        }
        db.update(approvals).set({ state: 'used', usedAt: now() }).where(eq(approvals.id, id)).run();
        record(row, 'use'); return { ok: true, approval: get(id) };
      });
    },
    record(id: string) { get(id); return db.select().from(approvalRecord).where(eq(approvalRecord.approval, id)).orderBy(asc(approvalRecord.seq)).all(); },
    /** A body reports the step against the allowance it spent. Private words
     * stay on that approval's labelled permanent record; the unlabelled notices
     * table is used only for non-private steps. One report per allowance. */
    reportUsed(id: string, agent: string, what: string) {
      const text = z.string().trim().min(1).max(2000).parse(what);
      return db.transaction(() => {
        const row = get(id);
        if (row.agent !== agent || row.state !== 'used' || row.operation) throw new Error('A spent body allowance is required');
        const history = db.select().from(approvalRecord).where(eq(approvalRecord.approval,id)).orderBy(asc(approvalRecord.seq)).all();
        if (!history.some(event => event.event === 'allow' && event.note.startsWith('Standing tell rule '))) throw new Error('A tell-rule allowance is required');
        const old = history.find(event => event.event === 'use' && event.note.startsWith('Reported step: '));
        if (old) {
          if (old.note !== 'Reported step: '+text) throw new Error('Step was already reported');
          return;
        }
        record(row,'use','Reported step: '+text);
        if (!row.member) db.insert(approvalNotices).values({id:`an-${randomUUID()}`,agent:row.agent,kind:row.kind,target:row.target,what:text,at:now()}).run();
      });
    },
    notices() { return db.select().from(approvalNotices).orderBy(asc(approvalNotices.at), asc(approvalNotices.id)).all(); },
  };
}
