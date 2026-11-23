import type { DataQuerySnapshot } from '../../data/graphql';
import type { SecretsSnapshot } from '../secrets-view';

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
