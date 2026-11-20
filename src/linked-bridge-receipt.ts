/** The authenticated bridge event behind a linked member's message, while that
 * exact workspace account still names the same household member. */
import { and, eq } from 'drizzle-orm';
import type { DataDatabase } from './core/data/database.js';
import { bridgeConnections,bridgeIncoming,bridgePeople,conversations,inboxRefs,type inbox } from './core/data/schema.js';
import { incomingId,parseInboxSourceId } from './pieces/bridges/keys.js';

export function linkedBridgeReceipt(db:DataDatabase,job:{agent:string;conversation:string|null},
  item:Pick<typeof inbox.$inferSelect,'id'|'source'|'sourceId'|'fromId'>) {
  const source = parseInboxSourceId(item.sourceId);
  if (!source || !job.conversation || (item.source!=='discord' && item.source!=='slack')) return;
  const receipts = db.select({
    event: bridgeIncoming, linkedMember: bridgePeople.member, direct: conversations.direct, privateMember: conversations.member,
  }).from(inboxRefs)
    .innerJoin(bridgeIncoming, eq(inboxRefs.ref, bridgeIncoming.id))
    .innerJoin(bridgeConnections, and(eq(bridgeConnections.id, bridgeIncoming.connection),
      eq(bridgeConnections.agent, job.agent), eq(bridgeConnections.platform, item.source), eq(bridgeConnections.workspace, source.workspace)))
    .innerJoin(bridgePeople, and(eq(bridgePeople.platform, bridgeConnections.platform),
      eq(bridgePeople.workspace, bridgeConnections.workspace), eq(bridgePeople.user, bridgeIncoming.user)))
    .innerJoin(conversations, eq(conversations.id, bridgeIncoming.conversation))
    .where(and(eq(inboxRefs.item, item.id), eq(bridgeIncoming.conversation, job.conversation), eq(bridgeIncoming.channel, source.channel)))
    .all().filter(({ event }) => event.id === incomingId(event.connection, source.message));
  const receipt = receipts.length === 1 && receipts[0];
  if (!receipt || receipt.linkedMember !== item.fromId || receipt.event.member !== item.fromId ||
      receipt.event.bot || receipt.event.webhook || receipt.event.state !== 'delivered') return;
  return receipt;
}
