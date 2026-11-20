/** Public metadata adapter. Exact central credential proof supplies every scope field. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { operation, OperationError, type Viewer } from '../../core/index.js';
import type { Foundation } from '../../core/app.js';
import { runtimeHouseContext } from '../runtime/role.js';
import { secretName, requestReason } from './input.js';
import type { GrantRequest, Grant } from './role.js';

export function installHouseSecrets(app: Foundation) {
  const context = (viewer: Viewer) => {
    const bound = runtimeHouseContext(app, viewer);
    return bound && {agent: bound.agent, scope: {house: bound.job, ...(bound.service === undefined ? {} : {service: bound.service})}};
  };
  const requireContext = (viewer: Viewer) => {
    const bound = context(viewer);
    if (!bound) throw new OperationError('denied', 'Authenticated house unavailable');
    return bound;
  };
  app.operations.register(operation({name: 'secrets.houseRequest', write: true, recheckPolicy: true,
    input: z.object({job: z.uuid(), name: secretName, why: requestReason, minutes: z.number().int().positive().optional()}).strict(),
    output: z.object({id: z.string(), state: z.enum(['pending','allowed','denied','cancelled','revoked'])}),
    may: (viewer, input) => context(viewer)?.scope.house === input.job, run(ctx, input) {
      const bound = requireContext(ctx.viewer);
      const result = app.operations.call('direct', ctx.viewer, 'secrets.requestHouse', {
        ...bound, target: input.name, why: input.why, ...(input.minutes === undefined ? {} : {minutes: input.minutes}),
      }, `house-request:${createHash('sha256').update(ctx.receipt!.id).digest('hex')}`);
      if (!result.ok) throw new OperationError(result.code, result.message);
      const request = result.value as GrantRequest;
      return {id: request.id, state: request.state};
    },
  }));
  app.operations.register(operation({name: 'secrets.houseStatus',
    input: z.object({id: z.string().regex(/^q-(?:[0-9a-f]{8}|[0-9a-f-]{36})$/)}).strict(),
    output: z.object({state: z.enum(['pending','granted','expired','denied','cancelled','revoked'])}),
    may: viewer => !!context(viewer), run(ctx, input) {
      const bound = requireContext(ctx.viewer);
      const row = app.db.prepare('SELECT record FROM secrets_requests WHERE id=?').get(input.id) as {record:string}|undefined;
      const request = row && JSON.parse(row.record) as GrantRequest | undefined;
      if (!request || request.kind !== 'secret' || request.agent !== bound.agent || request.scope?.house !== bound.scope.house
        || request.scope.service !== bound.scope.service) throw new OperationError('not-found', 'Request not found');
      if (request.state !== 'allowed') return {state: request.state};
      const rows = app.db.prepare('SELECT record FROM secrets_grants WHERE agent=? AND kind=? AND target=?').all(bound.agent,'secret',request.target) as {record:string}[];
      const grant = rows.map(row => JSON.parse(row.record) as Grant).find(g => g.requestId === request.id && !g.movedTo
        && g.scope?.house === bound.scope.house && g.scope.service === bound.scope.service);
      return {state: grant && (grant.expiresAt === undefined || grant.expiresAt > ctx.now) ? 'granted' as const : 'expired' as const};
    },
  }));
}
