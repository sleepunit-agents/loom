import { maySee, type Db, type Sharing, type Operations, type Result, type Viewer } from '../../core/index.js';
export { secretName } from './input.js';
export type { SecretUse } from './service.js';
/** The single authority for agent use. No cache: revocation applies to the next call. */
export type ResourceKind = 'secret' | 'runner' | 'piece' | 'tailnet';
export interface Resource { kind: ResourceKind; target: string }
/** Supplied only by the authenticated runtime, never from operation input. */
export interface GrantContext { house: string; service?: string }
export interface Grants {
  mayUse(agent: string, resource: Resource, now: number, context?: GrantContext): boolean;
}
export interface Grant extends Resource {
  id: string; agent: string; by: string; createdAt: number; expiresAt?: number;
  /** A temporary house grant never becomes agent-wide. Service absence is exact. */
  scope?: GrantContext;
  /** The particular request that produced this grant; manual grants omit it. */
  requestId?: string;
  /** A moved original is retained for paired revocation, but grants no access. */
  movedTo?: string;
  pairedRequestId?: string;
}
export interface SecretName { id: string; description: string; changedAt: number; by: string }
export interface GrantRequest extends Resource {
  id: string; agent: string; askedBy: { kind: string; id: string }; why: string;
  state: 'pending' | 'allowed' | 'denied' | 'cancelled' | 'revoked'; createdAt: number;
  /** This request must resolve its capability-owned household ask before commit. */
  attentionManaged?: true;
  carriedFrom?: string; claimedBy?: string;
  always?: true; answeredAt?: number; by?: string; decision?: 'policy';
  scope?: GrantContext; minutes?: number;
}

/** Internal runtime seam. The adapter must derive agent and scope from authenticated
 * job/token identity, never copy them from a caller's JSON. Not offered remotely.
 */
export function secretRequestsRole(operations: Pick<Operations, 'call'>) {
  return {
    request(viewer: Viewer, context: GrantContext, input: { target: string; why: string; minutes?: number }, operationId: string): Result {
      return operations.call('direct', viewer, 'secrets.requestHouse', { ...input, agent: viewer.id, scope: context }, operationId);
    },
  };
}

/** Minimal answer projection; secret values and grant scope never cross this seam. */
export function secretAnswers(db: Db, sharing: () => Sharing) {
  return {
    check(id: string, viewer: Viewer) {
      const row = db.prepare('SELECT record FROM secrets_requests WHERE id=?').get(id) as { record: string } | undefined;
      if (!row) return;
      const request = JSON.parse(row.record) as GrantRequest;
      if (!maySee(viewer, { type: 'secret.request', agent: request.agent }, sharing())) return;
      return { state: request.state, ...(request.kind !== 'secret' ? { kind: request.kind } : {}) };
    },
  };
}
