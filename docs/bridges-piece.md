# Bridges inside loom

The new-side bridges piece owns venue connections and settings, channel/thread routes,
venue-user → People slug links, conversation keys, a durable inbox and a send outbox in
`loom.db`. It never reads the old JSON configuration. People cards remain in People;
links identify a sender and never grant authority. Runtime admits each sender and owns
turns, body delivery and continuity. Secrets are obtained through a grant-checked role.

## Foundation slice

This first slice is an injectable engine, not yet a production adapter installation.
`installBridges` registers setup operations and live records. `Bridges.sync` reconciles
connections, `receive` durably accepts a venue message, and `reply` queues one reply
under runtime's operation id. The daemon composition root must call sync after a
committed setup change, await engine.close before closing its database. Core staging releases notify
the engine after commit through the effects role; no new venue traffic is needed. Production Discord/Slack transports, importer, generated commands,
app and composition are subsequent work on t-2210; the old side is untouched.

| Old behavior | New owner / replacement |
| --- | --- |
| shuttle.json bridge settings | bridges_venues; bridges.putVenues / removeVenues |
| routes.json channel and thread routes | bridges_routes; bridges.putRoutes / removeRoutes |
| people.json venue handles | bridges_links; bridges.putLinks / removeLinks |
| tiers, scopes, grants, guest limits | runtime's admit role; not copied into a People link |
| adapter routing | routing.ts; mention before primary; thread inherits parent |
| body spawn/feed/resume/reap | runtime deliver/stop role; bodies never run in bridges |
| state JSON and sent log dedup | bridges_inbox/outbox with permanent operation ids |
| adapter upgrade/restart loops | daemon connection lifecycle with bounded reconnect backoff |
| shadow outbound mode | core staging effect hold; one release permits one attempt |

A receive id includes platform, workspace, channel, message and agent. Runtime must
atomically deduplicate that id when recording a turn. This permits a retry after a
runtime commit whose acknowledgement was lost without adding another turn. The venue
is acknowledged after the inbox is durable, independently of runtime availability.
Unknown and denied users are left on read; their stored message words are erased.

Messages carry their original event timestamp and optional display label through the
inbox to runtime. Timestamps normalize to ISO UTC milliseconds, truncating finer
precision. Missing timestamps derive from Slack's message ts or Discord's snowflake,
never the receipt clock. Invalid event times hold the receipt durably for correction.
Previously queued foundation messages without a recoverable event time also hold.

The injected runtime delivery role returns `delivered`, `refused`, `retry` or `held`.
Only `delivered` establishes a conversation binding. A final refusal consumes the
receipt and erases its words; a transient outcome or exception retains the stable id
for retry; malformed/unknown outcomes hold without retry until deliberately repaired.
Production composition must map the runtime registry Result into these outcomes and
must preserve authenticated caller identity; that integration remains on t-2210.

## Discord intake

`discordMessage` validates one gateway message against the receiving workspace and
channel metadata before returning a bridge Message. It accepts default and reply
events, rejects the receiving bot's own posts and system events, and preserves event
time. DMs require the absence of a guild. Threads require a known parent and are
labelled from the parent channel, never from Discord's starter-derived thread name.
Attachment names and URLs remain textual descriptions; this function fetches nothing.

The Message `mentions` field means explicit, resolved summons. Discord user mentions
must occur in both content and the resolved mention list; managed role mentions must
occur in both content and resolved roles and map to a configured bot in the workspace.
An automatic reply ping cannot summon an agent or suppress a primary. The normalizer
does not grant admission: the existing engine still resolves People links and asks
runtime. The injected gateway transport must call this function; production socket
connections, durable resume checkpoints, paired webhook identity and stop/presence
effects remain unfinished on t-2210. No live connection uses this helper yet.

| Old Discord routing case | New intake / routing coverage |
| --- | --- |
| Explicit user/managed-role summons; reply pings | discordMessage + discord.test.ts |
| No summons → primary; peer-only mention suppresses primary | addressed + discord.test.ts |
| Known bot peer in peer route only | addressed + discord.test.ts |
| Thread parent ignore/only, safe thread label | discordMessage/addressed + discord.test.ts |
| DM identity and original event timestamp | discordMessage + engine event-time validation |
| Guest/reader admission and tiers | runtime admission, unchanged; not inferred by intake |
| Paired webhook and webhook-peer identity | Pending adapter identity work; no new support claimed |

## Slack intake

`slackMessage` validates a raw message event against connection-bound conversation
metadata. Only DM/group metadata is accepted; a non-D id is conservatively a group
even when its DM flag was lost. Own/bot posts, edits, joins and deletes are discarded.
The message ts remains its id (the durable inbox key also includes channel and agent),
so the engine derives the original event time without floating-point timestamp loss.
Thread replies retain thread_ts as their reply address but keep DM/person or group/room
conversation continuity. A root's own thread_ts does not turn it into a reply.

Text replaces actual mentions and HTTP links before decoding lt/gt/amp once. Encoded
mentions stay literal; unknown people become @someone, and Slack's supplied mention
label never supplies a person's name. Labels use resolved human display names, omit
the receiving bot and fit 80 UTF16 units; groups use whole names and count the rest. A DM name that cannot fit whole falls
back to DM rather than showing a partial name.
File names remain textual descriptions only. No credential, URL download or file
storage is used here. Safe bounded fetch, runtime-bound file access and retention are
still required before production file support.

This pure helper is unregistered and grants no admission. Conversation metadata must
come from the authenticated bot's API, with human names resolved through unambiguous
People links. Real Slack integration must still check users.info (same team, not guest,
stranger, deleted or bot), inspect every member and admit each with runtime, and check
fresh group membership/admission before EVERY post. The existing engine's boolean
inspect seam and group recipient selection still need reconciliation. Socket durable
ACK, outbound threads/splitting, stop/presence and named secret sinks remain unfinished.

| Old Slack case | This slice / remaining owner |
| --- | --- |
| DM and MPIM message filtering | slackMessage + slack.test.ts |
| Thread under a human or bot post, same conversation | slackMessage + keyFor tests |
| Markup/escape order, readable mentions/links | slackMessage/slackText tests |
| Human-only short labels with whole group names | slackMessage label tests |
| File name descriptions | Pure text only; secure runtime-bound fetch pending |
| users.info, all-member admission, fresh pre-post checks | Pending real adapter/runtime integration; never inferred here |
| Socket ACK after durable receipt, send/presence staging | Pending transport integration |
| Poll/lookback/shadow compare/check-gone | Retired on the new side: staged sockets replace concurrent shadow polling; preserve live thread/dedup semantics in adapter tests |

Reply text is kept in the outbox, never exposed as traffic metadata. A send exception
is treated as uncertain, even if a venue might have rejected it before posting.
Inbox and outbox records retain their receiving bot identity; changing a venue
holds that identity’s pending work rather than moving it to another agent or workspace.
An interrupted send is uncertain after restart and is never automatically repeated.
Staging sends call core's beforeOutside gate; their effect id is bridges:<reply id>.
The setup and traffic projections contain secret references, never token values or
upstream exception text. Current setup operations are household-owner actions through
src/policy.ts, preventing bodies from changing person links or connections.

## Final move

Do not deploy, import real data, or retire old adapters from this slice. The whole
new side is assembled beside the old one; the coordinator runs and verifies the
final import/cutover with Jonathan when every bridge slice is complete.
