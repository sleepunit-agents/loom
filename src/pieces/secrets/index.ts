import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { migrate, operation, failure, mayAct, maySee, type Context, type Db, type Operations, type Live, type Sharing, type Viewer, type LiveRecord } from '../../core/index.js';
import { schema } from './schema/001.js';
import type { GrantContext, Grant, GrantRequest, Grants, Resource, SecretName } from './role.js';

import { readSecretPolicy, requestDecision, secretPolicy } from './policy.js';
import { secretName as name } from './input.js';
const agent = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100);
const grantScope = z.object({ house: z.string().regex(/^h-[0-9]{1,9}$/), service: agent.optional() }).strict();
const resource = { kind: z.enum(['secret', 'runner', 'piece', 'tailnet']), target: name };
/** Trusted in-process attention seam. Implementations must raise a household ask and
 * deliver only its first household owner's yes/no. No caller can inject an answer. */
export interface GrantAttention {
  raise(request: GrantRequest): { raised: true };
}
const tables = { 'secret.name': 'secrets_names', 'secret.grant': 'secrets_grants', 'secret.request': 'secrets_requests' } as const;
function read<T>(db: Db, table: string, id: string): T | undefined {
  const row = db.prepare(`SELECT record FROM ${table} WHERE id=?`).get(id) as { record: string } | undefined;
  return row ? JSON.parse(row.record) as T : undefined;
}
function all<T>(db: Db, table: string): T[] {
  return (db.prepare(`SELECT record FROM ${table} ORDER BY id`).all() as { record: string }[]).map(r => JSON.parse(r.record) as T);
}
export const grantId = (agent: string, r: Resource, scope?: GrantContext) => JSON.stringify(scope ? [agent, r.kind, r.target, scope.house, scope.service ?? null] : [agent, r.kind, r.target]);
export function grantsRole(db: Db): Grants {
  return { mayUse(agent, resource, now, context) {
    if (resource.kind === 'secret' && requestDecision(readSecretPolicy(db), agent, resource.target).level === 'never') return false;
    const candidates = [read<Grant>(db, 'secrets_grants', grantId(agent, resource))];
    if (context) candidates.push(read<Grant>(db, 'secrets_grants', grantId(agent, resource, context)));
    return candidates.some(row => !!row && (row.expiresAt === undefined || row.expiresAt > now)
      && (!row.scope || !!context && row.scope.house === context.house && row.scope.service === context.service));
  } };
}
export function installSecrets(db: Db, operations: Operations, live: Live, sharing: () => Sharing, attention?: GrantAttention) {
  migrate(db, 'secrets', schema);
  const owner = (v: Viewer, op: string) => mayAct(v, { type: 'secret.grant' }, sharing(), 'household', op);
  const canAsk = (v: Viewer, a: string) => v.kind === 'agent' ? v.id === a && maySee(v, { agent: a }, sharing()) : owner(v, 'secrets.request') || mayAct(v, { agent: a }, sharing(), 'agent-setup', 'secrets.request');
  const saveGrant = (record: Grant) => db.prepare('INSERT INTO secrets_grants VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(record.id, record.agent, record.kind, record.target, JSON.stringify(record));
  const saveRequest = (r: GrantRequest) => db.prepare('INSERT INTO secrets_requests VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(r.id, JSON.stringify(r));
  function raiseRequest(ctx: Context, record: GrantRequest) {
      if (!attention) return failure('unavailable', 'Grant requests need the attention role');
      saveRequest(record);
      const acknowledgement: unknown = attention.raise(record);
      if (acknowledgement instanceof Promise) {
        // A miswired async role must neither commit nor leave an unhandled rejection.
        void acknowledgement.catch(() => {});
        return failure('unavailable', 'Attention must acknowledge synchronously');
      }
      if (!acknowledgement || typeof acknowledgement !== 'object' || !('raised' in acknowledgement) || acknowledgement.raised !== true) return failure('unavailable', 'Attention did not acknowledge the ask');
      ctx.changed('secret.request', record.id); return record;
  }
  operations.register(operation({ name: 'secrets.list', input: z.object({}).strict(), output: z.unknown(),
    may: v => owner(v, 'secrets.list'), run: () => ({ names: all<SecretName>(db, 'secrets_names'), grants: all<Grant>(db, 'secrets_grants'), requests: all<GrantRequest>(db, 'secrets_requests') }),
  }));
  operations.register(operation({ name: 'secrets.policy', write: true, input: secretPolicy, output: secretPolicy,
    may: v => owner(v, 'secrets.policy'), run(ctx, input) {
      db.prepare("INSERT INTO secrets_meta VALUES ('policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(input));
      ctx.changed('secret.policy', 'policy'); return input;
    },
  }));
  live.register({ name: 'secret.policy', ids: () => ['policy'], inScope: () => true,
    read: (id, viewer) => id === 'policy' && maySee(viewer, { type: 'secret.policy' }, sharing()) ? { id, ...readSecretPolicy(db) } : undefined,
  });
  operations.register(operation({ name: 'secrets.describe', write: true, input: z.object({ name, description: z.string().max(2000) }).strict(), output: z.unknown(),
    may: v => owner(v, 'secrets.describe'), run(ctx, input) {
      const record: SecretName = { id: input.name, description: input.description, by: ctx.viewer.id, changedAt: ctx.now };
      db.prepare('INSERT INTO secrets_names VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(record.id, JSON.stringify(record));
      ctx.changed('secret.name', record.id); return record;
    },
  }));
  operations.register(operation({ name: 'secrets.grant', write: true, input: z.object({ agent, ...resource, scope: grantScope.optional(), expiresAt: z.number().int().positive().optional() }).strict(), output: z.unknown(),
    may: v => owner(v, 'secrets.grant'), run(ctx, input) {
      if (input.scope && input.expiresAt === undefined) return failure('invalid', 'House grants must expire');
      if (input.expiresAt !== undefined && input.expiresAt <= ctx.now) return failure('invalid', 'Grant must expire in the future');
      const record: Grant = { ...input, id: grantId(input.agent, input, input.scope), by: ctx.viewer.id, createdAt: ctx.now };
      saveGrant(record); ctx.changed('secret.grant', record.id); return record;
    },
  }));
  operations.register(operation({ name: 'secrets.revoke', write: true, input: z.object({ agent, ...resource, scope: grantScope.optional() }).strict(), output: z.unknown(),
    may: v => owner(v, 'secrets.revoke'), run(ctx, input) {
      const id = grantId(input.agent, input, input.scope); db.prepare('DELETE FROM secrets_grants WHERE id=?').run(id); ctx.changed('secret.grant', id); return { revoked: true };
    },
  }));
  operations.register(operation({ name: 'secrets.may', input: z.object({ agent, ...resource }).strict(), output: z.object({ allow: z.boolean() }),
    may: (v, i) => owner(v, 'secrets.may') || v.kind === 'agent' && v.id === i.agent,
    run: (ctx, input) => ({ allow: grantsRole(db).mayUse(input.agent, input, ctx.now) }),
  }));
  operations.register(operation({ name: 'secrets.request', write: true, input: z.object({ agent, ...resource, why: z.string().trim().min(1).max(2000) }).strict(), output: z.unknown(),
    may: (v, i) => canAsk(v, i.agent), run(ctx, input) {
      if (input.kind === 'secret') return failure('denied', 'Secret requests need authenticated house context');
      const old = all<GrantRequest>(db, 'secrets_requests').find(r => r.agent === input.agent && r.kind === input.kind && r.target === input.target && r.state === 'pending');
      if (old) return old;
      const record: GrantRequest = { ...input, id: `q-${randomUUID()}`, state: 'pending', askedBy: { kind: ctx.viewer.kind, id: ctx.viewer.id }, createdAt: ctx.now };
      return raiseRequest(ctx, record);
    },
  }));
  // This door is only for an in-process runtime adapter after authenticating its job/token.
  // House/service are never accepted by the public request operation.
  operations.register(operation({ name: 'secrets.requestHouse', doors: ['direct'], write: true,
    input: z.object({ agent, target: name, scope: grantScope, why: z.string().trim().min(1).max(2000), minutes: z.number().int().positive().optional() }).strict(), output: z.unknown(),
    may: (v, i) => v.kind === 'agent' && v.id === i.agent && canAsk(v, i.agent), run(ctx, input) {
      if (!read<SecretName>(db, 'secrets_names', input.target)) return failure('not-found', 'Secret name not found');
      const old = all<GrantRequest>(db, 'secrets_requests').find(r => r.agent === input.agent && r.kind === 'secret' && r.target === input.target
        && r.scope?.house === input.scope.house && r.scope?.service === input.scope.service
        && (r.state === 'pending' || r.state === 'allowed' && (() => {
          const grant = read<Grant>(db, 'secrets_grants', grantId(r.agent, r, input.scope));
          return grant?.requestId === r.id && grant.expiresAt !== undefined && grant.expiresAt > ctx.now;
        })()));
      if (old) return old;
      const decision = requestDecision(readSecretPolicy(db), input.agent, input.target);
      const minutes = Math.min(input.minutes ?? decision.minutes, decision.minutes);
      const record: GrantRequest = { ...input, minutes, kind: 'secret', id: `q-${randomUUID()}`, state: 'pending', askedBy: { kind: ctx.viewer.kind, id: ctx.viewer.id }, createdAt: ctx.now };
      if (decision.level !== 'ask') {
        record.state = decision.level === 'auto' ? 'allowed' : 'denied';
        record.decision = 'policy'; record.answeredAt = ctx.now;
        saveRequest(record); ctx.changed('secret.request', record.id);
        if (record.state === 'allowed') {
          const grant: Grant = { id: grantId(record.agent, record, input.scope), agent: record.agent, kind: 'secret', target: record.target,
            scope: input.scope, requestId: record.id, expiresAt: ctx.now + minutes * 60_000, createdAt: ctx.now, by: 'policy' };
          saveGrant(grant); ctx.changed('secret.grant', grant.id);
        }
        return record;
      }
      return raiseRequest(ctx, record);
    },
  }));
  operations.register(operation({ name: 'secrets.answer', write: true, input: z.object({ id: z.string().min(1).max(200), allow: z.boolean() }).strict(), output: z.unknown(),
    may: v => owner(v, 'secrets.answer'), run(ctx, input) {
      const record = read<GrantRequest>(db, 'secrets_requests', input.id);
      if (!record) return failure('not-found', 'Request not found');
      if (record.state !== 'pending') return failure('conflict', 'Request already answered');
      if (input.allow && record.kind === 'secret' && (!record.scope || !record.minutes)) return failure('invalid', 'Secret request has no house or duration');
      if (input.allow && record.kind === 'secret' && requestDecision(readSecretPolicy(db), record.agent, record.target).level === 'never') return failure('conflict', 'Policy never gives this secret out');
      record.state = input.allow ? 'allowed' : 'denied'; record.by = ctx.viewer.id; record.answeredAt = ctx.now; saveRequest(record);
      if (input.allow) {
        const grant: Grant = { id: grantId(record.agent, record, record.scope), ...(record.scope ? { scope: record.scope, requestId: record.id, expiresAt: ctx.now + record.minutes! * 60_000 } : {}), agent: record.agent, kind: record.kind, target: record.target, createdAt: ctx.now, by: ctx.viewer.id };
        saveGrant(grant); ctx.changed('secret.grant', grant.id);
      }
      ctx.changed('secret.request', record.id); return record;
    },
  }));
  for (const [type, table] of Object.entries(tables)) live.register({ name: type,
    ids: () => (db.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as { id: string }[]).map(r => r.id),
    read(id, viewer) {
      const r = read<LiveRecord>(db, table, id);
      if (!r) return;
      // Names are household data. Grants and requests can also be read by their agent and its owners.
      const scope = type === 'secret.name' ? { type } : { type, agent: String(r.agent) };
      return maySee(viewer, scope, sharing()) ? r : undefined;
    }, inScope: () => true,
  });
  return grantsRole(db);
}
