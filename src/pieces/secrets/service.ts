import { z } from 'zod';
import { mayAct, operation, OperationError, type Db, type Live, type Operations, type Sharing, type Viewer } from '../../core/index.js';
import { beginSecretUsage } from './usage.js';
import { grantsRole, grantId } from './index.js';
import { secretAgent, secretName } from './input.js';
import type { Grant } from './role.js';

// ':' cannot occur in an agent id. Service grants never authorize an agent of the same name.
const principal = (service: string) => `service:${service}`;
/** The authenticated local holder transport supplies a fresh, exclusively owned buffer.
 * It must never log it or retain a plaintext copy. No legacy file discovery is allowed.
 */
export interface SecretValueSource { read(name: string): Promise<Uint8Array> }
export interface SecretUse {
  withValue<T>(name: string, use: (token: string) => Promise<T>): Promise<T>;
}
/** Separate owner-only service grants use the existing central grants list. */
export function installSecretServices(db: Db, operations: Operations, sharing: () => Sharing) {
  const input = z.object({ service: secretAgent, name: secretName }).strict();
  const owner = (v: Viewer, op: string) => mayAct(v, {type: 'secret.grant'}, sharing(), 'household', op);
  operations.register(operation({ name: 'secrets.grantService', write: true,
    input: input.extend({expiresAt: z.number().int().positive().optional()}), output: z.object({granted: z.literal(true)}),
    may: v => owner(v, 'secrets.grantService'), run(ctx, i) {
      if (!Object.hasOwn(sharing().services, i.service)) throw new OperationError('not-found', 'Service not installed');
      if (!db.prepare('SELECT id FROM secrets_names WHERE id=?').get(i.name)) throw new OperationError('not-found', 'Secret name not found');
      if (i.expiresAt !== undefined && i.expiresAt <= ctx.now) throw new OperationError('invalid', 'Grant must expire in the future');
      const agent = principal(i.service), resource = {kind: 'secret' as const, target: i.name};
      const grant: Grant = {...resource, agent, id: grantId(agent, resource), by: ctx.viewer.id, createdAt: ctx.now,
        ...(i.expiresAt === undefined ? {} : {expiresAt: i.expiresAt})};
      db.prepare('INSERT INTO secrets_grants VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record')
        .run(grant.id, agent, grant.kind, grant.target, JSON.stringify(grant));
      ctx.changed('secret.grant', grant.id); return {granted: true as const};
    },
  }));
  operations.register(operation({name: 'secrets.revokeService', write: true, input, output: z.object({revoked: z.literal(true)}),
    may: v => owner(v, 'secrets.revokeService'), run(ctx, i) {
      const id = grantId(principal(i.service), {kind: 'secret', target: i.name});
      if (db.prepare('DELETE FROM secrets_grants WHERE id=?').run(id).changes) ctx.changed('secret.grant', id);
      return {revoked: true as const};
    },
  }));
}
/** Bound only at trusted composition, never exposed as an operation or remote role.
 * The callback is trusted credential-using code: it must not log, persist or retain
 * the token (including transformed copies). JS strings cannot be securely erased.
 */
export function secretUseRole(db: Db, source: SecretValueSource, sharing: () => Sharing, viewer: Viewer, now: () => number, live: Live): SecretUse {
  const caller = {...viewer};
  const allowed = (name: string) => caller.kind === 'service' && Object.hasOwn(sharing().services, caller.id)
    && grantsRole(db).mayUse(principal(caller.id), {kind: 'secret', target: name}, now())
    && !!db.prepare('SELECT id FROM secrets_names WHERE id=?').get(name);
  return { async withValue<T>(name: string, use: (token: string) => Promise<T>): Promise<T> {
    if (!secretName.safeParse(name).success || !allowed(name)) throw new OperationError('denied', 'Secret use denied');
    let bytes: Uint8Array | undefined;
    let attempt: ReturnType<typeof beginSecretUsage> | undefined;
    let released = false;
    try {
      attempt = beginSecretUsage(db, live, name, 'service-use', {kind: 'service', id: caller.id}, now());
      bytes = await source.read(name);
      // Permission may have changed while the local transport was awaiting its reply.
      if (!allowed(name)) throw new Error('Access ended');
      if (!bytes.byteLength || bytes.byteLength > 64 * 1024) throw new Error('Invalid value');
      attempt.finish('released'); released = true;
      return await use(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8'));
    } catch {
      if (!released) { try { attempt?.finish('failed'); } catch { /* Keep the durable started attempt. */ } }
      throw new OperationError('unavailable', 'Secret use failed');
    }
    finally { bytes?.fill(0); }
  } };
}
