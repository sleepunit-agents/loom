/** The names loom already holds for outside accounts, channels and workspaces: the one place a proposal card
 * asks "who is U07V8CZUC1J?" (shared-household-proposals.ts, household.proposalPreview).
 *
 * The owner-only preview reads person links and connections (policy.ts, `bridgePeople` and
 * `bridgeConnections`) and labels of shared conversations without a member or direct-message scope.
 *
 * Names come from indexed person links and retained Discord channel labels.
 * The people directory stores free-form fields in separate databases.
 * A workspace can be identified by a connection configured for its exact platform and id.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DataDatabase } from './core/data/database.js';
import { agents, bridgeConnections, bridgePeople, conversations } from './core/data/schema.js';
import type { CardNames, HeldName } from './proposal-words.js';

export function outsideNames(db: DataDatabase): CardNames {
  return {
    person(platform, workspace, user): HeldName | null {
      const link = db.select({ member: bridgePeople.member }).from(bridgePeople)
        .where(and(eq(bridgePeople.platform, platform), eq(bridgePeople.workspace, workspace), eq(bridgePeople.user, user))).get();
      return link ? { name: link.member, source: 'Household person link for this account' } : null;
    },
    channel(platform, workspace, channel): HeldName | null {
      // Discord sends a channel's name with each message, and the conversation's label keeps it ("Discord channel
      // #pond"). A Slack conversation's label is the channel id, so Slack channels have no name here.
      if (platform !== 'discord') return null;
      const row = db.select({ label: conversations.label }).from(conversations).where(and(eq(conversations.venue, 'discord'), isNull(conversations.member), eq(conversations.direct, false),
        inArray(conversations.agent, db.select({ id: agents.id }).from(agents)),
        eq(conversations.place, JSON.stringify([workspace, channel, null])),
        sql`${conversations.label} like 'Discord channel #%'`, sql`${conversations.label} <> ${'Discord channel #' + channel}`)).orderBy(desc(conversations.lastAt), conversations.id).get();
      const held = row?.label.slice('Discord channel '.length);
      return held && held !== '#' + channel ? { name: held, source: 'The name Discord gave with a message from there' } : null;
    },
    workspace(platform, workspace): HeldName | null {
      if (platform !== 'discord' && platform !== 'slack') return null;
      const connection = db.select({ id: bridgeConnections.id }).from(bridgeConnections)
        .where(and(eq(bridgeConnections.platform, platform), eq(bridgeConnections.workspace, workspace), isNull(bridgeConnections.removedAt)))
        .orderBy(bridgeConnections.id).get();
      return connection ? { name: connection.id, source: 'reached by the connection' } : null;
    },
  };
}
