/** Offline authority planning only. No database, filesystem, clock or registration. */
import { secretAgent } from './input.js';
import { parseLegacySecretRequestLinks } from './request-links.js';
import type { LegacySecretRequest } from './request-source.js';
import type { GrantContext } from './role.js';

export interface LegacyRequestPrincipals {
  /** Exact old strings, including strings the new agent validator cannot accept. */
  bindings: ReadonlyMap<string, string>;
  /** Supplied by the final importer from the new household registry. */
  registered: ReadonlySet<string>;
}
export interface PlannedRequestGrant {
  agent: string;
  kind: 'secret';
  target: string;
  scope: GrantContext;
  requestId: string;
  expiresAt: number;
  pairedRequestId?: string;
}
export interface LegacyRequestPlan {
  snapshotAt: number;
  /** Original history remains intact, including absent attribution and pruned links. */
  requests: { source: LegacySecretRequest; agent: string }[];
  /** Only live authority at snapshotAt. Claimed originals never occur here. */
  grants: PlannedRequestGrant[];
}

/** Every source principal needs an explicit injective mapping to a registered agent.
 * No normalization or implicit same-name lookup. A live carried grant needs its
 * surviving reciprocal owner Allow; missing history alone never authorizes use.
 * The single-row-per-scope destination cannot represent multiple live requests
 * at one exact scope, so those inputs refuse instead of choosing or unioning them.
 * This is NOT the final importer: attribution, pending attention, moved-original
 * revocation records, names/policy/audit and atomic persistence remain its work.
 */
export function planLegacySecretRequests(bytes: Buffer, principals: LegacyRequestPrincipals, snapshotAt: number): LegacyRequestPlan {
  try {
    if (!Number.isSafeInteger(snapshotAt) || snapshotAt < 0) throw new Error();
    const source = parseLegacySecretRequestLinks(bytes);
    const byId = new Map(source.map(row => [row.id, row]));
    const mapped = new Map<string, string>();
    const used = new Set<string>();
    for (const row of source) {
      // A stored snapshot cannot be rewound through later decisions/revocations.
      if (Date.parse(row.at) > snapshotAt || (row.decided !== undefined && Date.parse(row.decided) > snapshotAt)) throw new Error();
      if (mapped.has(row.agent)) continue;
      const agent = principals.bindings.get(row.agent);
      if (!principals.bindings.has(row.agent) || !secretAgent.safeParse(agent).success
        || !principals.registered.has(agent!) || used.has(agent!)) throw new Error();
      mapped.set(row.agent, agent!); used.add(agent!);
    }
    const requests = source.map(row => ({ source: row, agent: mapped.get(row.agent)! }));
    const grants: PlannedRequestGrant[] = [];
    const occupied = new Set<string>();
    for (const { source: row, agent } of requests) {
      if (row.state !== 'granted' || row.claimedBy || Date.parse(row.expires!) <= snapshotAt) continue;
      if (row.carriedFrom) {
        const original = byId.get(row.carriedFrom);
        // Link parser checks the reciprocal pair's identity/state/expiry. Here
        // require surviving evidence and chronological original authorization.
        if (!original || Date.parse(original.decided!) > Date.parse(row.at)) throw new Error();
      }
      const scope: GrantContext = { house: row.house, ...(row.service === undefined ? {} : { service: row.service }) };
      const key = JSON.stringify([agent, row.secret, scope.house, scope.service ?? null]);
      if (occupied.has(key)) throw new Error();
      occupied.add(key);
      grants.push({ agent, kind: 'secret', target: row.secret, scope, requestId: row.id,
        expiresAt: Date.parse(row.expires!), ...(row.carriedFrom ? { pairedRequestId: row.carriedFrom } : {}) });
    }
    return { snapshotAt, requests, grants };
  } catch { throw new Error('Invalid legacy secret request plan'); }
}
