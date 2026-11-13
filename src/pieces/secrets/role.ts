/** The single authority for agent use. No cache: revocation applies to the next call. */
export type ResourceKind = 'secret' | 'runner' | 'piece' | 'tailnet';
export interface Resource { kind: ResourceKind; target: string }
export interface Grants {
  mayUse(agent: string, resource: Resource, now: number): boolean;
}
export interface Grant extends Resource {
  id: string; agent: string; by: string; createdAt: number; expiresAt?: number;
}
export interface SecretName { id: string; description: string; changedAt: number; by: string }
export interface GrantRequest extends Resource {
  id: string; agent: string; askedBy: { kind: string; id: string }; why: string;
  state: 'pending' | 'allowed' | 'denied' | 'cancelled'; createdAt: number;
  answeredAt?: number; by?: string;
}
