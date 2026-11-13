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
the engine after commit through the effects role; no new venue traffic is needed. Next mode now installs the setup operations and metadata records for the preview,
but does not start an engine or connect to either platform. Production Discord/Slack transports, importer, retained runtime commands
and engine composition remain subsequent work on t-2210; the old side is untouched.

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
stranger, deleted or bot), inspect every member and admit each with runtime, and return the full checked member set as `{kind:'allow', members}`. For a group,
that includes the receiving bot and the sender, with at least two distinct humans;
every human must resolve unambiguously to a different People link and pass runtime
admission. A bare `allow` cannot authorize a Slack group. The engine derives non-D Slack
conversation IDs as groups at routing, receipt, queue drain, reply and send boundaries,
including queued messages predating this check; an absent group flag cannot bypass it. Groups route to their
receiving bot without needing a primary route or mention, as DMs do.

The engine repeats inspection and all-member admission before EVERY group post,
including after staging release; the adapter must fetch fresh conversations.info
(still MPIM), conversations.members and users.info, never reuse intake membership.
A temporary failure keeps the reply pending; a definite denial holds it for human
disposition. Link, route or venue edits during admission invalidate every verdict from that attempt,
even an edit restored before admission finishes. A transactional setup revision in
bridges_meta catches this without a new schema.
Injected fake tests cover these boundaries; no real Web API inspection exists yet.
Socket durable ACK, outbound threads/splitting, stop/presence and service-based
secrets.withValue credential wiring remain unfinished. The foundation get seam is
not a production secret path; adapters will run as the bridges service, not an agent.

| Old Slack case | This slice / remaining owner |
| --- | --- |
| DM and MPIM message filtering | slackMessage + slack.test.ts |
| Thread under a human or bot post, same conversation | slackMessage + keyFor tests |
| Markup/escape order, readable mentions/links | slackMessage/slackText tests |
| Human-only short labels with whole group names | slackMessage label tests |
| File name descriptions | Pure text only; secure runtime-bound fetch pending |
| users.info, all-member admission, fresh pre-post checks | Engine requires checked member IDs, admits all humans and repeats before posts; actual platform checks and runtime composition pending |
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

## Outbound reply attempt

`replyParts` preserves every character (including blank lines), prefers newline cuts,
and never separates a Unicode surrogate pair. It uses the legacy conservative caps:
2000 UTF16 units for Discord, 3900 for Slack. This intentionally preserves boundary
newlines that the old Python chunkers stripped; there is no markup rewriting.
`postReply` posts those parts sequentially, validates each nonempty receipt id and
returns the final id, like the old send commands. It never retries. Any callback failure
or malformed receipt stops the attempt with a fixed error without upstream details.

This is an adapter building block, still unregistered. Its post callback must use the
bound channel/thread, suppress automatic platform mentions and repeat fresh authorization
immediately before **each** post, including every chunk of a group reply. The helper
does not implement those platform checks or confer permission. The engine holds the
whole reply as uncertain after any partial failure, including across restart; it never
replays already sent parts or attempts the remainder. One staging release authorizes
one whole attempt. Fake adapter/engine tests prove this behavior for both venues, with
thread addresses preserved. Production Web API, first outbound DM and per-chunk
platform membership checks remain required integration work.

| Old send case | New coverage / remaining integration |
| --- | --- |
| Discord test_send long reply; Slack test_send long group reply | replyParts/postReply + outbound.test.ts; caps and lossless text tested |
| Sequential chunk receipt, final send id | postReply receipt/order tests |
| Part posted then failure | Fake postReply adapter + durable engine uncertainty/restart tests |
| Thread reply address and staging release | Fake postReply adapter + engine tests for both venues |
| Slack first outbound DM, fresh group checks for each post | Pending real adapter; no production support claimed |

## Bridges preview

The registered `/p/bridges-preview` app uses Kit `Split`, `List`, `Row` and state
components. It reads `bridges.venue`, `bridges.route`, `bridges.send` and `core.effect`
through the shared `useRecords` socket. Connections show saved status and receipt,
delivery and hold counts for the last 24 hours. Routes show primary, parent, peer,
guest and reader metadata. Sends show receipt ids and state, never message words.
The preview does not fetch credentials or expose their values.

A due bridge effect with a matching pending send can be released by calling the
existing `core.releaseEffect` operation. The server applies its existing household
permission check. A release allows one attempt; uncertain/held sends have no resend
control, even when a stale effect still says due. Non-bridge effects are excluded.
Offline or denied subscriptions clear detail and release controls. Completed or
evicted effects leave the reader instead of retaining an actionable snapshot.

The Routes folder creates, edits and removes routes using the existing
`bridges.putRoutes` and `bridges.removeRoutes` operations. Fields cover platform,
workspace/channel, parent, primary agent, paired webhook, peers, guests, reader agents
and note references. Reader and note lists use one reference per line; blank lines
are omitted. New routes receive a stable random id. Removal requires confirmation.
A pending write stays locked across in-app navigation, and refusal stays inline.
If the live route changes while a draft is open, saving and removal stop until the
current route is reloaded. This catches changes already received by the window;
the existing put operation remains last-write-wins, without an atomic revision check.
The daemon continues to enforce the existing household-owner policy for every write.
Connection and person-link editing, uncertain-send disposition and held intake
repair remain required work before the full rebuild is complete. No live
connections start merely by opening this app or installing next-mode metadata.

The CI-only `bridges-preview.integration.test.ts` uses two windows and fake venue IO
on a disposable staged `startLoom --next` home. It verifies shared status, route and
send reads, reload/deep-link selection, one release reaching one uncertain attempt,
and both windows losing the release action afterward. Its twelve screenshots cover route editing and staged sends at
390/1280/1920 widths in Neon Noir and Daylight. The dedicated Bridges preview
evidence workflow uploads them with the exact PR head in the artifact name.

| Existing surface | Preview replacement / remaining work |
| --- | --- |
| Bridge connection and traffic metadata | Connections folder, saved state and daily counts |
| Channel/thread route configuration | Routes form with create/edit/confirmed removal |
| Staging-held reply | Pending sends and staged effects, one-item release |
| Partial or interrupted send | Uncertain state, review guidance and no replay control; explicit disposition pending |

## Opt-in setup commands

`loom-bridges <operation> '<json-object>'` targets the explicit `LOOM_URL` of a
next-mode daemon using `LOOM_TOKEN_FILE`. It never chooses a local store or reads
legacy bridge configuration. `--help` works offline. The six operation names are
`putVenues`, `removeVenues`, `putRoutes`, `removeRoutes`, `putLinks`, `removeLinks`.
The same declarations attach CLI metadata to the registry and generate help;
`BridgesInputs` exposes input types derived from the piece's schemas.

Put operations take the existing venue, route or link JSON; remove operations take
`{"id":"record-id"}`. The daemon applies schemas and household policy. The client
adds no actor or authority fields. It prints the daemon's `{ "id": "record-id" }`
acknowledgement as JSON, with exit 0; refusal/unavailability exits 1 and malformed
command/JSON usage exits 2. Transport failures and HTTP 5xx responses retry at most four times with the
same write id and original JSON, including after a lost commit acknowledgement.
Redirects are refused and diagnostics are fixed strings. The returned id must match
the id supplied by the caller; unrelated response fields or ids are refused. Only secret references
belong in venue setup; this command never obtains venue credentials.

This is an additional setup surface for the new side. It does not replace legacy
`send`, `read`, `describe`, `status`, relay or file commands: their generated typed
client and fixture comparison remain required when the runtime operations land.
No legacy dispatch or live installation changes here.

## Final move

The [replacement inventory](bridges-contract-inventory.md) pins the legacy source
revisions and lists command/job ownership, existing fake coverage and outstanding
production cases, including first outbound DMs, attributed relays and held-delivery
repair. Pending rows remain completion requirements for t-2210.

Do not deploy, import real data, or retire old adapters from this slice. The whole
new side is assembled beside the old one; the coordinator runs and verifies the
final import/cutover with Jonathan when every bridge slice is complete.
