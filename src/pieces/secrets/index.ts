import { registerBuiltinService } from '../../core/services.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { migrate, operation, failure, mayAct, maySee, type Context, type Db, type Operations, type Live, type Sharing, type Viewer, type LiveRecord } from '../../core/index.js';
import { resolveGrantAttention } from './attention-resolution.js';
import { installSecretUsage } from './usage.js';
import { installSecretHistory } from './history.js';
import { schema } from './schema/001.js';
import { grantId } from './grant-id.js';
export { grantId } from './grant-id.js';
import type { GrantContext, Grant, GrantRequest, Grants, Resource, SecretName } from './role.js';

import { readSecretPolicy, requestDecision, secretPolicy, withAlways } from './policy.js';
import { secretName as name, secretAgent as agent, requestReason } from './input.js';
const grantScope = z.object({ house: z.string().regex(/^h-[0-9]{1,9}$/), service: agent.optional() }).strict();
const resource = { kind: z.enum(['secret', 'runner', 'piece', 'tailnet']), target: name };
/** Trusted in-process attention seam. Implementations must raise a household ask and
 * deliver only its first household owner's yes/no. No caller can inject an answer. */
export interface GrantAttention {
  raise(request: GrantRequest, ctx: Context): { raised: true; managed?: true };
  resolve?(request: GrantRequest, ctx: Context): { resolved: true };
}
const tables = { 'secret.name': 'secrets_names', 'secret.grant': 'secrets_grants', 'secret.request': 'secrets_requests' } as const;
function read<T>(db: Db, table: string, id: string): T | undefined {
  const row = db.prepare(`SELECT record FROM ${table} WHERE id=?`).get(id) as { record: string } | undefined;
  return row ? JSON.parse(row.record) as T : undefined;
}
function all<T>(db: Db, table: string): T[] {
  return (db.prepare(`SELECT record FROM ${table} ORDER BY id`).all() as { record: string }[]).map(r => JSON.parse(r.record) as T);
}
export function grantsRole(db: Db): Grants {
  return { mayUse(agent, resource, now, context) {
    if (resource.kind === 'secret' && requestDecision(readSecretPolicy(db), agent, resource.target).level === 'never') return false;
    const candidates = [read<Grant>(db, 'secrets_grants', grantId(agent, resource))];
    if (context) candidates.push(read<Grant>(db, 'secrets_grants', grantId(agent, resource, context)));
    return candidates.some(row => !!row && !row.movedTo && (row.expiresAt === undefined || row.expiresAt > now)
      && (!row.scope || !!context && row.scope.house === context.house && row.scope.service === context.service));
  } };
}
export function installSecrets(db: Db, operations: Operations, live: Live, sharing: () => Sharing, attention?: GrantAttention) {
  registerBuiltinService(operations, 'secrets', ['secret.name', 'secret.grant', 'secret.request', 'secret.policy', 'secret.change']);
  migrate(db, 'secrets', schema);
  installSecretHistory(db, operations, live, sharing);
  installSecretUsage(db, operations, live, sharing);
  const owner = (v: Viewer, op: string) => mayAct(v, { type: 'secret.grant' }, sharing(), 'household', op);
  const canAsk = (v: Viewer, a: string) => v.kind === 'agent' ? v.id === a && maySee(v, { agent: a }, sharing()) : owner(v, 'secrets.request') || mayAct(v, { agent: a }, sharing(), 'agent-setup', 'secrets.request');
  const saveGrant = (record: Grant) => db.prepare('INSERT INTO secrets_grants VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(record.id, record.agent, record.kind, record.target, JSON.stringify(record));
  const saveRequest = (r: GrantRequest) => db.prepare('INSERT INTO secrets_requests VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record').run(r.id, JSON.stringify(r));
  function raiseRequest(ctx: Context, record: GrantRequest) {
      if (!attention) return failure('unavailable', 'Grant requests need the attention role');
      saveRequest(record);
      const acknowledgement: unknown = attention.raise(record, ctx);
      if (acknowledgement instanceof Promise) {
        // A miswired async role must neither commit nor leave an unhandled rejection.
        void acknowledgement.catch(() => {});
        return failure('unavailable', 'Attention must acknowledge synchronously');
      }
      if (!acknowledgement || typeof acknowledgement !== 'object' || !('raised' in acknowledgement) || acknowledgement.raised !== true) return failure('unavailable', 'Attention did not acknowledge the ask');
      if ('managed' in acknowledgement && acknowledgement.managed === true) { record.attentionManaged = true; saveRequest(record); }
      ctx.changed('secret.request', record.id); return record;
  }
  // The Settings page needs explicit capability/availability rather than inferring
  // ownership from an empty list. No household document or credential is exposed.
  live.register({ name: 'secret.settings', ids: () => ['settings'], inScope: () => true,
    refreshOn: change => ['secret.grant','secret.change','secret.name','secret.policy'].includes(change.type),
    expires: record => typeof record.refreshAt === 'number' ? record.refreshAt : undefined,
    read(id, viewer) {
      if (id !== 'settings' || !owner(viewer, 'secrets.list')) return;
      const held = sharing(), now = operations.clock.now();
      const deadlines = [
        ...all<Grant>(db, 'secrets_grants').flatMap(g => g.expiresAt === undefined ? [] : [g.expiresAt]),
        ...(db.prepare('SELECT record FROM secrets_changes').all() as {record:string}[]).map(r => (JSON.parse(r.record) as {at:number}).at + 365 * 86400_000),
      ].filter(at => at > now);
      return { id, ...(deadlines.length ? {refreshAt: deadlines.reduce((a,b) => Math.min(a,b), Infinity)} : {}), agents: [...new Set([...Object.values(held.members).flatMap(m => m.agents),
        ...Object.values(held.projects).flatMap(p => p.agents)])].sort(),
        valuesAvailable: operations.has('secrets.set') && operations.has('secrets.remove'), now: operations.clock.now() };
    },
  });
  operations.register(operation({ name: 'secrets.list', input: z.object({}).strict(), output: z.unknown(),
    may: v => owner(v, 'secrets.list'), run: () => ({ names: all<SecretName>(db, 'secrets_names'), grants: all<Grant>(db, 'secrets_grants'), requests: all<GrantRequest>(db, 'secrets_requests') }),
  }));
  const savePolicy = (ctx: Context, policy: ReturnType<typeof readSecretPolicy>) => {
    db.prepare("INSERT INTO secrets_meta VALUES ('policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(policy));
    ctx.changed('secret.policy', 'policy');
  };
  operations.register(operation({ name: 'secrets.always', write: true,
    input: z.object({ name, agent, on: z.boolean() }).strict(), output: secretPolicy,
    may: v => owner(v, 'secrets.always'), run(ctx, input) {
      if (!read<SecretName>(db, 'secrets_names', input.name)) return failure('not-found', 'Secret name not found');
      const current = readSecretPolicy(db);
      const policy = withAlways(current, input.name, input.agent, input.on);
      if (!policy) return failure('conflict', 'Policy never gives this secret out');
      if (!secretPolicy.safeParse(policy).success) return failure('invalid', 'Standing policy exceeds capacity');
      savePolicy(ctx, policy); return policy;
    },
  }));
  operations.register(operation({ name: 'secrets.policy', write: true, input: secretPolicy, output: secretPolicy,
    may: v => owner(v, 'secrets.policy'), run(ctx, input) {
      savePolicy(ctx, input); return input;
    },
  }));
  live.register({ name: 'secret.policy', ids: () => ['policy'], inScope: () => true,
    read: (id, viewer) => id === 'policy' && owner(viewer, 'secrets.list') ? { id, ...readSecretPolicy(db) } : undefined,
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
      const id = grantId(input.agent, input, input.scope);
      const grant = read<Grant>(db, 'secrets_grants', id);
      const revoke = (g: Grant) => {
        db.prepare('DELETE FROM secrets_grants WHERE id=?').run(g.id); ctx.changed('secret.grant', g.id);
        const request = g.requestId && read<GrantRequest>(db, 'secrets_requests', g.requestId);
        if (request) { request.state = 'revoked'; saveRequest(request); ctx.changed('secret.request', request.id); }
      };
      if (grant) {
        const paired = grant.pairedRequestId && read<GrantRequest>(db, 'secrets_requests', grant.pairedRequestId);
        const other = paired && read<Grant>(db, 'secrets_grants', grantId(paired.agent, paired, paired.scope));
        // A later independent grant at the same scope is not part of this pair.
        if (other && other.requestId === paired.id && other.pairedRequestId === grant.requestId) revoke(other);
        revoke(grant);
      }
      return { revoked: true };
    },
  }));
  operations.register(operation({ name: 'secrets.may', input: z.object({ agent, ...resource }).strict(), output: z.object({ allow: z.boolean() }),
    may: (v, i) => owner(v, 'secrets.may') || v.kind === 'agent' && v.id === i.agent,
    run: (ctx, input) => ({ allow: grantsRole(db).mayUse(input.agent, input, ctx.now) }),
  }));
  operations.register(operation({ name: 'secrets.request', write: true, input: z.object({ agent, ...resource, why: requestReason }).strict(), output: z.unknown(),
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
    input: z.object({ agent, target: name, scope: grantScope, why: requestReason, minutes: z.number().int().positive().optional() }).strict(), output: z.unknown(),
    may: (v, i) => v.kind === 'agent' && v.id === i.agent && canAsk(v, i.agent), run(ctx, input) {
      if (!read<SecretName>(db, 'secrets_names', input.target)) return failure('not-found', 'Secret name not found');
      const decision = requestDecision(readSecretPolicy(db), input.agent, input.target);
      const old = decision.level !== 'never' && all<GrantRequest>(db, 'secrets_requests').find(r => r.agent === input.agent && r.kind === 'secret' && r.target === input.target
        && r.scope?.house === input.scope.house && r.scope?.service === input.scope.service
        && (r.state === 'pending' && decision.level === 'ask' || r.state === 'allowed' && (() => {
          const grant = read<Grant>(db, 'secrets_grants', grantId(r.agent, r, input.scope));
          return grant?.requestId === r.id && !grant.movedTo && grant.expiresAt !== undefined && grant.expiresAt > ctx.now;
        })()));
      if (old) return old;
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
      // Policy wins first. Only a still-live plain owner Allow may move once.
      for (const source of all<GrantRequest>(db, 'secrets_requests')) {
        if (source.kind !== 'secret' || source.agent !== record.agent || source.target !== record.target
          || source.state !== 'allowed' || !source.by || source.decision || source.always || source.carriedFrom || source.claimedBy
          || !source.scope || source.scope.house === input.scope.house || source.scope.service !== input.scope.service) continue;
        const original = read<Grant>(db, 'secrets_grants', grantId(source.agent, source, source.scope));
        if (!original || original.requestId !== source.id || original.movedTo || original.expiresAt === undefined || original.expiresAt <= ctx.now) continue;
        record.state = 'allowed'; record.by = source.by; record.answeredAt = ctx.now; record.carriedFrom = source.id;
        source.claimedBy = record.id;
        const carried: Grant = { id: grantId(record.agent, record, input.scope), agent: record.agent, kind: 'secret', target: record.target,
          scope: input.scope, requestId: record.id, expiresAt: original.expiresAt, createdAt: ctx.now, by: source.by, pairedRequestId: source.id };
        original.movedTo = record.id; original.pairedRequestId = record.id;
        saveRequest(source); saveRequest(record); saveGrant(original); saveGrant(carried);
        for (const r of [source, record]) ctx.changed('secret.request', r.id);
        for (const g of [original, carried]) ctx.changed('secret.grant', g.id);
        return record;
      }
      return raiseRequest(ctx, record);
    },
  }));
  operations.register(operation({ name: 'secrets.answer', write: true, input: z.object({ id: z.string().min(1).max(200), allow: z.boolean(), always: z.literal(true).optional() }).strict(), output: z.unknown(),
    may: v => owner(v, 'secrets.answer'), run(ctx, input) {
      const record = read<GrantRequest>(db, 'secrets_requests', input.id);
      if (!record) return failure('not-found', 'Request not found');
      if (input.always && (!input.allow || record.kind !== 'secret')) return failure('invalid', 'Always requires allowing a secret request');
      if (record.state !== 'pending') return failure('conflict', 'Request already answered');
      if (input.allow && record.kind === 'secret' && (!record.scope || !record.minutes)) return failure('invalid', 'Secret request has no house or duration');
      if (input.allow && record.kind === 'secret' && requestDecision(readSecretPolicy(db), record.agent, record.target).level === 'never') return failure('conflict', 'Policy never gives this secret out');
      if (input.always) {
        const policy = withAlways(readSecretPolicy(db), record.target, record.agent, true);
        if (!policy) return failure('conflict', 'Policy never gives this secret out');
        if (!secretPolicy.safeParse(policy).success) return failure('invalid', 'Standing policy exceeds capacity');
        savePolicy(ctx, policy); record.always = true; record.minutes = 480;
      }
      record.state = input.allow ? 'allowed' : 'denied'; record.by = ctx.viewer.id; record.answeredAt = ctx.now; saveRequest(record);
      if (input.allow) {
        const grant: Grant = { id: grantId(record.agent, record, record.scope), ...(record.scope ? { scope: record.scope, requestId: record.id, expiresAt: ctx.now + record.minutes! * 60_000 } : {}), agent: record.agent, kind: record.kind, target: record.target, createdAt: ctx.now, by: ctx.viewer.id };
        saveGrant(grant); ctx.changed('secret.grant', grant.id);
      }
      resolveGrantAttention(attention, record, ctx);
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
