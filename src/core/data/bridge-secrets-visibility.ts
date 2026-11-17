/** Outside read policy. Installed services continue to use the shared database
 * directly. Retained schemas re-evaluate all ownership and conversation labels.
 *
 * Direct messages are read by people only. A DM from a linked member is private
 * to that member by its conversation label. A DM from anyone else, and a group
 * DM, has no member to be private to, so the label rule alone would hand its
 * words to every token of the agent, including a body working in a public room.
 * An agent gets DM words one way: as the mail of the body in that conversation.
 */
import { and, eq, getTableColumns, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { DataDatabase } from './database.js';
import type { Viewer } from '../../policy.js';
import type { QueryVisibility } from './queries.js';
import { members, memberAgents, conversations, bridgeIncoming, inboxRefs } from './schema.js';
import { workVisibility } from './work-visibility.js';

export const bridgeSecretsTables = ['bridgeConnections', 'bridgeChannelFilters', 'bridgeChannels', 'bridgePeople',
  'bridgeIncoming', 'bridgeSends', 'secrets', 'secretGrants', 'secretRequests', 'secretRules', 'secretRuleAgents', 'secretUses', 'secretChanges'] as const;
export function bridgeSecretsVisibility(viewer: Viewer): QueryVisibility {
  const owner: SQL = viewer.kind === 'member'
    ? sql`exists (select 1 from ${members} where ${members.id} = ${viewer.id} and ${members.role} = 'owner')` : sql`false`;
  const labels = workVisibility(viewer).approvals!(getTableColumns(conversations));
  const people: SQL = viewer.kind === 'member' ? sql`true` : sql`false`;
  const incoming = (f: { conversation: AnyColumn; isDm: AnyColumn }): SQL => sql`(${owner} or ((${people} or ${f.isDm} = 0) and exists (select 1 from ${conversations} where ${conversations.id} = ${f.conversation} and ${labels})))`;
  return {
    bridgeConnections: f => sql`(${owner} or ${viewer.kind === 'member'
      ? sql`exists (select 1 from ${memberAgents} join ${members} on ${members.id} = ${memberAgents.member} where ${memberAgents.member} = ${viewer.id} and ${memberAgents.agent} = ${f.agent})` : sql`false`})`,
    bridgeChannelFilters: () => owner, bridgeChannels: () => owner, bridgePeople: () => owner,
    bridgeIncoming: f => incoming({ conversation: f.conversation, isDm: f.isDm }),
    bridgeSends: f => sql`exists (select 1 from ${bridgeIncoming} where ${bridgeIncoming.id} = ${f.incoming} and ${incoming(bridgeIncoming)})`,
    secrets: () => owner, secretGrants: () => owner, secretRequests: () => owner,
    secretRules: () => owner, secretRuleAgents: () => owner, secretUses: () => owner, secretChanges: () => owner,
  };
}

/** Whether this Inbox item carries a bridge direct message. Readers of Inbox
 * words apply the same rule as the rows above: see the note at the top. */
export function carriesDirectMessage(db: DataDatabase, item: { id: string; source: string }): boolean {
  if (item.source !== 'discord' && item.source !== 'slack') return false;
  return !!db.select({ id: bridgeIncoming.id }).from(inboxRefs).innerJoin(bridgeIncoming, eq(bridgeIncoming.id, inboxRefs.ref))
    .where(and(eq(inboxRefs.item, item.id), eq(bridgeIncoming.isDm, true))).get();
}
