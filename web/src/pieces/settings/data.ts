import type { DataQuerySnapshot } from '../../data/graphql';
import type { SecretsSnapshot } from '../secrets-view';

export const settingsQuery = `query SettingsSecrets {
  homeComms { member }
  household { secretsDefault }
  secrets { name description changedAt changedBy }
  secretGrants { id secret agent job request grantedBy grantedAt expiresAt }
  secretRequests { id secret agent job conversation why state minutes answeredBy always askedAt answeredAt }
  secretRules { secret answer minutes }
  secretRuleAgents { secret agent when }
  secretUses { id secret agent job at state }
  secretChanges { id secret action by at }
}`;
export interface SettingsData {
  homeComms: { member: string } | null;
  household: readonly { secretsDefault: 'ask' | 'auto' | 'never' }[];
  secrets: SecretsSnapshot['secrets']; secretGrants: SecretsSnapshot['grants']; secretRequests: SecretsSnapshot['requests'];
  secretRules: SecretsSnapshot['rules']; secretRuleAgents: SecretsSnapshot['ruleAgents'];
  secretUses: SecretsSnapshot['uses']; secretChanges: SecretsSnapshot['changes'];
}
export function settingsSnapshot(query: DataQuerySnapshot<SettingsData>): SecretsSnapshot {
  const empty: SecretsSnapshot = { status: query.status === 'loading' ? 'loading' : query.status === 'offline' ? 'offline' : 'error',
    member: '', secrets: [], grants: [], requests: [], rules: [], ruleAgents: [], uses: [], changes: [] };
  if (query.status !== 'live' || !query.data?.homeComms?.member) return empty;
  const data = query.data;
  return { status: 'live', member: data.homeComms!.member, secrets: data.secrets, grants: data.secretGrants,
    requests: data.secretRequests, rules: data.secretRules, ruleAgents: data.secretRuleAgents,
    uses: data.secretUses, changes: data.secretChanges, defaultAnswer: data.household[0]?.secretsDefault };
}
