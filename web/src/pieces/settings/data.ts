import type { DataQuerySnapshot } from '../../data/graphql';

export interface SecretRow { name: string; description: string; changedAt: string; changedBy: string }
export interface SecretGrantRow {
  id: string; secret: string; agent: string; job: string | null; request: string | null;
  grantedBy: string; grantedAt: string; expiresAt: string;
}
export interface SecretRequestRow {
  id: string; secret: string; agent: string; job: string | null; conversation: string | null;
  why: string; state: 'pending' | 'allowed' | 'denied' | 'cancelled' | 'revoked';
  minutes: number; answeredBy: string | null; always: boolean; askedAt: string; answeredAt: string | null;
}
export interface SecretsSnapshot {
  status: 'loading' | 'live' | 'offline' | 'denied' | 'error';
  /** Authenticated query principal. Root must replace the whole snapshot on
   * authentication changes and enforce owner access at the query/command door. */
  member: string;
  secrets: readonly SecretRow[];
  grants: readonly SecretGrantRow[];
  requests: readonly SecretRequestRow[];
  rules: readonly { secret: string; answer: 'ask' | 'auto' | 'never'; minutes: number }[];
  ruleAgents: readonly { secret: string; agent: string; when: 'on_request' | 'at_start' }[];
  uses: readonly { id: string; secret: string; agent: string; job: string; at: string; state: 'started' | 'released' | 'failed' }[];
  changes: readonly { id: string; secret: string; action: 'add' | 'replace' | 'removed'; by: string; at: string }[];
  /** Omit when the household default has not been fetched. */
  defaultAnswer?: 'ask' | 'auto' | 'never';
}


export const settingsQuery = `query SettingsSecrets {
  secretsReader { id defaultAnswer }
  secrets { name description changedAt changedBy }
  secretGrants { id secret agent job request grantedBy grantedAt expiresAt }
  secretRequests { id secret agent job conversation why state minutes answeredBy always askedAt answeredAt }
  secretRules { secret answer minutes }
  secretRuleAgents { secret agent when }
  secretUses { id secret agent job at state }
  secretChanges { id secret action by at }
}`;
export interface SettingsData {
  secretsReader: { id: string; defaultAnswer: 'ask' | 'auto' | 'never' } | null;
  secrets: SecretsSnapshot['secrets']; secretGrants: SecretsSnapshot['grants']; secretRequests: SecretsSnapshot['requests'];
  secretRules: SecretsSnapshot['rules']; secretRuleAgents: SecretsSnapshot['ruleAgents'];
  secretUses: SecretsSnapshot['uses']; secretChanges: SecretsSnapshot['changes'];
}
export function settingsSnapshot(query: DataQuerySnapshot<SettingsData>): SecretsSnapshot {
  const status = query.status === 'live' ? (query.data?.secretsReader === null ? 'denied' : 'error') : query.status;
  const empty: SecretsSnapshot = { status,
    member: '', secrets: [], grants: [], requests: [], rules: [], ruleAgents: [], uses: [], changes: [] };
  if (query.status !== 'live' || !query.data?.secretsReader?.id) return empty;
  const data = query.data;
  return { status: 'live', member: data.secretsReader!.id, secrets: data.secrets, grants: data.secretGrants,
    requests: data.secretRequests, rules: data.secretRules, ruleAgents: data.secretRuleAgents,
    uses: data.secretUses, changes: data.secretChanges, defaultAnswer: data.secretsReader!.defaultAnswer };
}
