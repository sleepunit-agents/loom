/** Offline metadata planning only; the final importer owns persistence and receipts. */
import { secretAgent } from './input.js';
import { parseLegacySecretPolicy } from './policy-source.js';
import { secretPolicy, type SecretPolicy } from './policy.js';
import { planLegacySecretRequests, type LegacyRequestPlan, type LegacyRequestPrincipals } from './request-plan.js';

export interface LegacySecretMetadataPlan {
  /** Validated source membership remains available for history/comparison. */
  sourcePolicy: SecretPolicy;
  /** Same exact bindings as requests, independently for agents and houses. */
  policy: SecretPolicy;
  requests: LegacyRequestPlan;
}

/** Resolve all referenced policy and request principals together. Inactive policy
 * fields still require explicit registered bindings. Aliases across either input
 * refuse, even when individually valid; they cannot silently share authority.
 * Existing strict policy input limitations remain: unsupported legacy policy IDs
 * refuse instead of being normalized. No names/attribution/attention/audit import,
 * DB writes or effective runtime permission decisions happen here.
 */
export function planLegacySecretMetadata(policyBytes: Buffer, requestBytes: Buffer,
  principals: LegacyRequestPrincipals, snapshotAt: number): LegacySecretMetadataPlan {
  try {
    const sourcePolicy = parseLegacySecretPolicy(policyBytes);
    const requests = planLegacySecretRequests(requestBytes, principals, snapshotAt);
    const resolved = new Map<string, string>();
    const owners = new Map<string, string>();
    const resolve = (old: string): string => {
      const existing = resolved.get(old);
      if (existing !== undefined) return existing;
      const agent = principals.bindings.get(old);
      if (!principals.bindings.has(old) || !secretAgent.safeParse(agent).success
        || !principals.registered.has(agent!) || owners.has(agent!)) throw new Error();
      resolved.set(old, agent!); owners.set(agent!, old);
      return agent!;
    };
    for (const row of requests.requests) resolve(row.source.agent);
    const secrets = Object.fromEntries(Object.entries(sourcePolicy.secrets).map(([name, rule]) => [name, {
      ...rule,
      ...(rule.agents === undefined ? {} : { agents: rule.agents.map(resolve) }),
      ...(rule.houses === undefined ? {} : { houses: rule.houses.map(resolve) }),
    }]));
    const policy = secretPolicy.parse({ default: sourcePolicy.default, secrets });
    return { sourcePolicy, policy, requests };
  } catch { throw new Error('Invalid legacy secret metadata plan'); }
}
