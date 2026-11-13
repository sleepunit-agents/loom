import type { GrantContext, Resource } from './role.js';

/** One identity for runtime writes and offline migration; absent service is exact. */
export const grantId = (agent: string, r: Resource, scope?: GrantContext) => JSON.stringify(scope ? [agent, r.kind, r.target, scope.house, scope.service ?? null] : [agent, r.kind, r.target]);
