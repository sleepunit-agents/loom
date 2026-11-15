/** Outside read policy. Installed services continue to use the shared database
 * directly. Retained schemas re-evaluate all ownership and conversation labels.
 */
import { getTableColumns, sql, type SQL } from 'drizzle-orm';
import type { Viewer } from '../../policy.js';
import type { QueryVisibility } from './queries.js';
import { members, memberAgents, conversations, bridgeIncoming } from './schema.js';
import { workVisibility } from './work-visibility.js';

export const bridgeSecretsTables = ['bridgeConnections', 'bridgeChannelFilters', 'bridgeChannels', 'bridgePeople',
  'bridgeIncoming', 'bridgeSends', 'secrets', 'secretGrants', 'secretRequests', 'secretRules', 'secretRuleAgents', 'secretUses', 'secretChanges'] as const;
export function bridgeSecretsVisibility(viewer: Viewer): QueryVisibility {
  const owner: SQL = viewer.kind === 'member'
    ? sql`exists (select 1 from ${members} where ${members.id} = ${viewer.id} and ${members.role} = 'owner')` : sql`false`;
  const labels = workVisibility(viewer).approvals!(getTableColumns(conversations));
  const incoming = (conversation: Parameters<NonNullable<QueryVisibility['bridgeIncoming']>>[0]['conversation']): SQL => sql`(${owner} or exists (select 1 from ${conversations} where ${conversations.id} = ${conversation} and ${labels}))`;
  return {
    bridgeConnections: f => sql`(${owner} or ${viewer.kind === 'member'
      ? sql`exists (select 1 from ${memberAgents} join ${members} on ${members.id} = ${memberAgents.member} where ${memberAgents.member} = ${viewer.id} and ${memberAgents.agent} = ${f.agent})` : sql`false`})`,
    bridgeChannelFilters: () => owner, bridgeChannels: () => owner, bridgePeople: () => owner,
    bridgeIncoming: f => incoming(f.conversation),
    bridgeSends: f => sql`exists (select 1 from ${bridgeIncoming} where ${bridgeIncoming.id} = ${f.incoming} and ${incoming(bridgeIncoming.conversation)})`,
    secrets: () => owner, secretGrants: () => owner, secretRequests: () => owner,
    secretRules: () => owner, secretRuleAgents: () => owner, secretUses: () => owner, secretChanges: () => owner,
  };
}
