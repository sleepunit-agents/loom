/** Offline metadata validation only. No grants, filesystem or database access. */
import { parseLegacySecretRequests, type LegacySecretRequest } from './request-source.js';

/** Validate surviving carry partners as one exact grant moved once. Retention can
 * prune either row, so missing partners are retained, not reconstructed. The final
 * importer still owns registered-principal mapping and authorization: a missing
 * partner is not evidence of permission, and a claimed original must never grant.
 */
export function parseLegacySecretRequestLinks(bytes: Buffer): LegacySecretRequest[] {
  try {
    const rows = parseLegacySecretRequests(bytes);
    const byId = new Map(rows.map(r => [r.id, r]));
    const claimed = new Set<string>();
    const carried = new Set<string>();
    const pair = (source: LegacySecretRequest, target: LegacySecretRequest) => {
      if (source.claimedBy !== target.id || target.carriedFrom !== source.id
        || source.carriedFrom || source.always || target.claimedBy || target.always
        || source.by !== 'owner' || target.by !== 'owner'
        || source.agent !== target.agent || source.secret !== target.secret
        || source.house === target.house || source.service !== target.service
        || source.expires !== target.expires
        || source.state !== target.state
        || (source.state !== 'granted' && source.state !== 'revoked')
        || (source.state === 'revoked' && source.decided !== target.decided)) throw new Error();
    };
    for (const row of rows) {
      if (row.claimedBy) {
        if (claimed.has(row.claimedBy)) throw new Error();
        claimed.add(row.claimedBy);
        const target = byId.get(row.claimedBy);
        if (target) pair(row, target);
      }
      if (row.carriedFrom) {
        if (carried.has(row.carriedFrom) || Date.parse(row.at) >= Date.parse(row.expires!)) throw new Error();
        carried.add(row.carriedFrom);
        const source = byId.get(row.carriedFrom);
        if (source) pair(source, row);
      }
    }
    // A pruned row cannot itself be both carried and claimed: only one move.
    for (const id of claimed) if (carried.has(id)) throw new Error();
    return rows;
  } catch { throw new Error('Invalid legacy secret request links'); }
}
