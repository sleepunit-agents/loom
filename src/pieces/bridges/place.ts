/** Where a bridge message sits: which conversation it joins and where its answer goes. Both follow from
 * the two functions here and from nothing else. The stored formats are data already in households'
 * databases: do not change them.
 *
 * The platforms differ, on purpose. A Discord channel is one running conversation, and a Discord thread
 * is its own. In a Slack room every message posted to the room starts a thread of its own, so the answer
 * is threaded under it and the room stays readable; a direct message on either platform is one running
 * conversation unless it is threaded. The adapter says which thread a message is in (normalize.ts, using
 * slackThread for Slack); intake turns that address into a place (conversationPlace). A reply goes to
 * the channel and thread of the message it answers (sends.ts copies them from the message's row). */

/** The thread a Slack message sits in: the one it was posted to, or, in a room, the one it starts. */
export function slackThread(kind: 'channel' | 'group' | 'im' | 'mpim', ts: string, threadTs: string | undefined): string | undefined {
  return threadTs ?? (kind === 'channel' || kind === 'group' ? ts : undefined);
}

/** `conversations.place` for a message. The workspace and the real channel are part of it even for a
 * direct message, because outside channel and thread ids are not unique across workspaces. A direct
 * message's place also says who it is private to: the linked member of a one-to-one message (or nobody,
 * for an unlinked sender), so a changed person link opens a new place and never relabels an old one; a
 * group direct message is private to no one member. */
export function conversationPlace(workspace: string, message: { channel: string; thread?: string | null; isDm: boolean; groupDm?: boolean }, member: string | null): string {
  return JSON.stringify([workspace, message.channel, message.thread ?? null,
    ...(message.isDm ? [message.groupDm ? ['group'] : ['member', member]] : [])]);
}
