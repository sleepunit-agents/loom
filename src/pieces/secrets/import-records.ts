/** Offline destination planning. No IO, persistence, registration or current clock. */
import { grantId } from './grant-id.js';
import { secretAgent, secretName } from './input.js';
import { planLegacySecretMetadata } from './import-plan.js';
import type { LegacyRequestPrincipals } from './request-plan.js';
import type { Grant, GrantRequest } from './role.js';

export interface LegacySecretRecordPrincipals extends LegacyRequestPrincipals {
  /** Explicit exact old who -> registered new household member. Never an owner fallback. */
  members: ReadonlyMap<string, string>;
  registeredMembers: ReadonlySet<string>;
}

/** Materialize runtime-compatible request/grant records while retaining validated
 * original metadata separately. Pending requests refuse until the final importer
 * can compose their trusted Attention asks in its transaction. Active owner grants
 * without surviving, explicitly mapped member attribution likewise refuse; history
 * may remain unattributed. The final importer must derive the registered sets and
 * stored name inventory from its destination, persist all inputs atomically and
 * independently verify them. These records alone do not complete an import.
 */
export function planLegacySecretRecords(policyBytes: Buffer, requestBytes: Buffer,
  principals: LegacySecretRecordPrincipals, names: ReadonlySet<string>, snapshotAt: number, options: { pendingAttention?: true } = {}) {
  try {
    const metadata = planLegacySecretMetadata(policyBytes, requestBytes, principals, snapshotAt);
    for (const name of names) if (!secretName.safeParse(name).success) throw new Error();
    const resolved = new Map<string, string>(), used = new Set<string>();
    const member = (old: string): string => {
      if (resolved.has(old)) return resolved.get(old)!;
      const id = principals.members.get(old);
      if (!principals.members.has(old) || typeof id !== 'string' || !id.length
        || !principals.registeredMembers.has(id) || used.has(id)) throw new Error();
      resolved.set(old, id); used.add(id); return id;
    };
    const requests: GrantRequest[] = metadata.requests.requests.map(({ source: r, agent }) => {
      if ((r.state === 'pending' && !options.pendingAttention) || (r.service !== undefined && !secretAgent.safeParse(r.service).success)) throw new Error();
      return {
        id: r.id, agent, kind: 'secret', target: r.secret,
        askedBy: { kind: 'agent', id: agent }, why: r.why, minutes: r.minutes,
        scope: { house: r.house, ...(r.service === undefined ? {} : { service: r.service }) },
        ...(r.state === 'pending' ? { attentionManaged: true as const } : {}),
        createdAt: Date.parse(r.at), state: r.state === 'granted' ? 'allowed' : r.state,
        ...(r.decided === undefined ? {} : { answeredAt: Date.parse(r.decided) }),
        ...(r.who === undefined ? {} : { by: member(r.who) }),
        ...(r.by === 'policy' ? { decision: 'policy' as const } : {}),
        ...(r.always ? { always: true as const } : {}),
        ...(r.carriedFrom ? { carriedFrom: r.carriedFrom } : {}),
        ...(r.claimedBy ? { claimedBy: r.claimedBy } : {}),
      };
    });
    const byId = new Map(requests.map(r => [r.id, r]));
    const sources = new Map(metadata.requests.requests.map(r => [r.source.id, r.source]));
    const grants: Grant[] = [];
    const occupied = new Set<string>();
    const add = (record: Grant) => {
      if (occupied.has(record.id)) throw new Error();
      occupied.add(record.id); grants.push(record);
    };
    for (const proposal of metadata.requests.grants) {
      if (!names.has(proposal.target)) throw new Error();
      const request = byId.get(proposal.requestId)!;
      const source = sources.get(request.id)!;
      const original = proposal.pairedRequestId ? byId.get(proposal.pairedRequestId)! : request;
      // A carry inherits the original member's authority, but its own historical
      // request keeps absent who absent. No owner is fabricated for either row.
      const by = source.by === 'policy' ? 'policy' : original.by;
      if (!by) throw new Error();
      const record: Grant = { id: grantId(proposal.agent, proposal, proposal.scope), agent: proposal.agent,
        kind: 'secret', target: proposal.target, scope: { ...proposal.scope }, requestId: request.id,
        expiresAt: proposal.expiresAt, createdAt: request.answeredAt!, by,
        ...(proposal.pairedRequestId ? { pairedRequestId: proposal.pairedRequestId } : {}) };
      add(record);
      if (proposal.pairedRequestId) {
        add({ id: grantId(original.agent, original, original.scope), agent: original.agent,
          kind: 'secret', target: original.target, scope: { ...original.scope! }, requestId: original.id,
          expiresAt: proposal.expiresAt, createdAt: original.answeredAt!, by,
          movedTo: request.id, pairedRequestId: request.id });
      }
    }
    return { metadata, requests, grants };
  } catch { throw new Error('Invalid legacy secret destination records'); }
}
