/** Read filters for the bridge and secret tables. Outside read policy only: installed services
 * continue to use the shared database directly. The rules are stated in policy.ts: a bridge
 * message is read with the conversation it went into, so a direct message follows its
 * conversation's `direct` and member labels and a retained schema re-evaluates both. */
import type { Viewer } from '../../policy.js';
import { sqlVisibility } from '../../policy-sql.js';
import type { QueryVisibility } from './queries.js';

export const bridgeSecretsTables = ['bridgeConnections', 'bridgeChannelFilters', 'bridgeChannels', 'bridgePeople',
  'bridgeIncoming', 'bridgeSends', 'secrets', 'secretGrants', 'secretRequests', 'secretRules', 'secretRuleAgents', 'secretUses', 'secretChanges'] as const;
export function bridgeSecretsVisibility(viewer: Viewer): QueryVisibility {
  return sqlVisibility(viewer, bridgeSecretsTables);
}
