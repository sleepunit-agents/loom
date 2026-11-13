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
}
export interface SecretName { id: string; description: string; changedAt: number; by: string }
export interface GrantRequest extends Resource {
  id: string; agent: string; askedBy: { kind: string; id: string }; why: string;
  state: 'pending' | 'allowed' | 'denied' | 'cancelled'; createdAt: number;
  answeredAt?: number; by?: string;
}
