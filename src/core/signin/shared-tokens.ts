/** Canonical token issuance over the approved schema. Only fingerprints persist.
 * Trusted modules call this service; the HTTP identity door checks ownership.
 * Issuance is deliberately not retryable: a lost response requires a new label.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { DataDatabase } from '../data/database.js';
import type { Viewer } from '../../policy.js';
import type { Clock } from '../clock.js';
import { agents, boxes, jobs, members, tokens } from '../data/schema.js';
import { OperationError, type Operations } from '../operations/index.js';
const id = z.string().min(1).max(200);
const label = z.string().trim().min(1).max(120).regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u);
const common = { label, expiresAt: z.iso.datetime().optional() };
export const sharedTokenInput = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('owner'), member: id }).strict(),
  z.object({ ...common, kind: z.literal('agent'), agent: id, job: id.optional() }).strict(),
  z.object({ ...common, kind: z.literal('runner'), box: id }).strict(),
]);
export const sharedTokenOwner = (db: DataDatabase, viewer: Viewer) => viewer.kind === 'member' && db.select().from(members).where(eq(members.id, viewer.id)).get()?.role === 'owner';
export function activeMemberToken(db: DataDatabase, clock: Clock, id: string) {
  const token=db.select().from(tokens).where(eq(tokens.fingerprint,id)).get();
  if(!token||token.kind!=='owner'||!token.member||token.revokedAt||(token.expiresAt&&Date.parse(token.expiresAt)<=clock.now())||!db.select().from(members).where(eq(members.id,token.member)).get())throw Error('Sign-in refused');
  return token;
}
export function sharedTokens(db: DataDatabase, clock: Clock) {
  return {
    issue(input: z.input<typeof sharedTokenInput>) {
      const value = sharedTokenInput.parse(input), now = clock.now();
      return db.transaction(() => {
        if (value.expiresAt && Date.parse(value.expiresAt) <= now) throw new OperationError('invalid', 'Expiry must be in the future');
        if (db.select().from(tokens).where(and(eq(tokens.label, value.label), isNull(tokens.revokedAt))).all()
          .some(row => !row.expiresAt || Date.parse(row.expiresAt) > now)) throw new OperationError('conflict', 'A live token already has that label');
        if (value.kind === 'owner' && !db.select().from(members).where(eq(members.id, value.member)).get()) throw new OperationError('invalid', 'Choose an existing member');
        if (value.kind === 'agent') {
          if (!db.select().from(agents).where(eq(agents.id, value.agent)).get()) throw new OperationError('invalid', 'Choose an existing agent');
          if (value.job) {
            const job = db.select().from(jobs).where(eq(jobs.id, value.job)).get();
            if (!job || job.agent !== value.agent || !job.box || !['starting', 'running', 'waiting'].includes(job.state)) throw new OperationError('invalid', 'Choose current work for this agent');
          }
        }
        if (value.kind === 'runner' && !db.select().from(boxes).where(and(eq(boxes.id, value.box), isNull(boxes.revokedAt))).get()) throw new OperationError('invalid', 'Choose an active machine');
        const token = `loom_${randomBytes(32).toString('base64url')}`, fingerprint = createHash('sha256').update(token).digest('hex');
        db.insert(tokens).values({ ...value, fingerprint, createdAt: new Date(now).toISOString() }).run();
        return { token, fingerprint };
      });
    },
    revoke(fingerprint: string) {
      const row = db.select().from(tokens).where(eq(tokens.fingerprint, fingerprint)).get();
      if (!row) throw new OperationError('not-found', 'Token not found');
      if (!row.revokedAt) db.update(tokens).set({ revokedAt: new Date(clock.now()).toISOString() }).where(eq(tokens.fingerprint, fingerprint)).run();
      return { revoked: true as const };
    },
  };
}
export function registerSharedTokenAdmin(operations: Operations, db: DataDatabase, service: ReturnType<typeof sharedTokens>) {
  operations.register({ name: 'token.revoke', write: true, recheckPolicy: true,
    input: z.object({ fingerprint: z.string().regex(/^[0-9a-f]{64}$/) }).strict(), output: z.object({ revoked: z.literal(true) }).strict(),
    may: viewer => sharedTokenOwner(db, viewer),
    run(ctx, input) { const result = service.revoke(input.fingerprint); ctx.changed('core.access', 'household'); return result; },
  });
}
