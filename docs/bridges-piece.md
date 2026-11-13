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
for retry; malformed/unknown outcomes hold for the life of the engine. On daemon restart, only
`runtime delivery held` receipts return to pending, preserving the original id, words
and event metadata. Delivery repeats current setup, credential and admission checks;
a still-malformed result holds again. Venue-removal, identity and invalid-event-time
holds stay held. Delivered/dropped receipts and all outbox states are unaffected.
Transient failures (credential/inspection/admission waits, setup changes, runtime retries
and exceptions) persist their first wait time. Pending intake expires only after more
than one hour, before another attempt; expiry retains the receipt id for deduplication,
erases the payload and publishes venue metadata. Duplicate receipts and restarts do not
renew the hour. Event and receipt time do not start a new receipt's wait budget: the
first transient result does. An attempt begun within the budget may complete successfully.
A held outcome clears the transient clock; recovery after restart gets a fresh hour if
it becomes transient again. Other held reasons stay held without expiry. Upgrade of
already pending foundation rows uses their receipt time conservatively, since no first
wait time was recorded. Outgoing sends have no transient intake expiry.
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
components. It reads `bridges.venue`, `bridges.route`, `bridges.link`, `bridges.send` and `core.effect`
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

The Connections folder creates, edits and removes setup with existing
`bridges.putVenues`/`bridges.removeVenues`. It includes agent, platform, workspace,
bot, enabled state, token/app secret **names**, only/ignore channels and bot roles.
No value lookup or grant creation is performed. Untouched strings and lists retain
exact values; edited lists use one reference per line and omit empty lines.
New connections receive stable random ids; removal requires confirmation and holds
pending intake/replies through the existing operation. Setup changes observed while
editing latch a reload requirement, including edit-and-restore. Traffic-only updates
do not invalidate the draft. This is an observed-change guard, not atomic compare-and-swap.

The Person links folder creates, edits and confirms removal through existing
`bridges.putLinks`/`bridges.removeLinks`. All fields are included: platform,
workspace, platform user ID and People person ID. This is an authority mapping,
not a descriptive People handle; runtime still decides admission. Identifiers
are preserved exactly. New links have stable random ids. An observed link change
latches an app-owned reload requirement until explicitly reloaded, including edit-and-restore and navigation away and back. Saved creations are remembered across navigation and cleared on eviction, including their creation URLs.
The existing operations remain last-write-wins; this is not atomic revision checking.

The Routes folder creates, edits and removes routes using the existing
`bridges.putRoutes` and `bridges.removeRoutes` operations. Fields cover platform,
workspace/channel, parent, primary agent, paired webhook, peers, guests, reader agents
and note references. Reader and note lists use one reference per line; blank lines
are omitted when editing a list; untouched strings and lists retain their exact values. New routes receive a stable random id. Removal requires confirmation.
Observed stale changes and saved-creation eviction tracking live in the app for all three setup forms, so editor unmounts do not reset them. A pending setup write blocks other connection, route and person-link writes across in-app navigation, and refusal stays inline.
If the window observes a live route change while a draft is open, saving and removal
stay blocked even after an edit-and-restore, until the
current route is reloaded. This catches changes already received by the window;
the existing put operation remains last-write-wins, without an atomic revision check.
The daemon continues to enforce the existing household-owner policy for every write.
Confirmed uncertain-send dismissal is available below; runtime-held intake repair
runs on restart as described above. Transient retry expiry remains required before
the full rebuild is complete. No live
connections start merely by opening this app or installing next-mode metadata.

The CI-only `bridges-preview.integration.test.ts` uses two windows and fake venue IO
on a disposable staged `startLoom --next` home. It verifies shared status, route and
send reads, reload/deep-link selection, one release reaching one uncertain attempt,
and both windows losing the release action afterward. Its twenty-four screenshots cover person-link editing, connection editing, route editing and staged sends at
390/1280/1920 widths in Neon Noir and Daylight. The dedicated Bridges preview
evidence workflow uploads them with the exact PR head in the artifact name.

| Existing surface | Preview replacement / remaining work |
| --- | --- |
| Bridge connection setup and traffic metadata | Connections form with create/edit/confirmed removal, saved state and daily counts |
| Platform account to People identity mapping | Person links form with create/edit/confirmed removal |
| Channel/thread route configuration | Routes form with create/edit/confirmed removal |
| Staging-held reply | Pending sends and staged effects, one-item release |
| Partial or interrupted send | Uncertain state, review guidance and no replay control; explicit disposition pending |

## Terminal send disposition

`bridges.dismissSend` takes `{id, state: 'held' | 'uncertain'}` under the existing
central household-owner policy. After checking the platform, an owner can dismiss
that reply from pending sends. The operation requires the observed state to match;
a missing id returns not-found and any active, completed or changed state conflicts.
Already dismissed ids acknowledge without another change. The transition and live
notification commit together through the registry. It performs no platform IO.

Dismissal does not assert that delivery succeeded. It is terminal and never retries
or clears the permanent reply id. The original payload and receipt stay private in
the outbox so a later runtime retry of that same reply cannot create another send.
A stale staging release cannot send a dismissed row. The core effect remains an
independent staging record; dismissal does not mark it delivered or release it.
The generated `loom-bridges dismissSend '{"id":"reply-id","state":"uncertain"}'`
command returns the usual id acknowledgement and exit codes. The preview offers
confirmed dismissal for held or uncertain sends, with the observed state sent to
the same operation. Pending requests and inline errors survive app navigation;
changed or evicted records and lost subscriptions remove confirmation controls.
The two-window CI proof covers cancellation, dismissal propagation and reload,
with six additional confirmation screenshots. Held-intake repair remains required.

## Opt-in setup commands

`loom-bridges <operation> '<json-object>'` targets the explicit `LOOM_URL` of a
next-mode daemon using `LOOM_TOKEN_FILE`. It never chooses a local store or reads
legacy bridge configuration. `--help` works offline. The setup operation names are
`putVenues`, `removeVenues`, `putRoutes`, `removeRoutes`, `putLinks`, `removeLinks`;
`dismissSend` provides terminal send disposition as described above.
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

## Slack Web API inspection

`slackApi` reads fresh `conversations.info`, every page of
`conversations.members` for MPIMs, and `users.info` for every other member.
It returns the complete member set only when workspace, human, guest/deleted/bot
and channel checks pass. DMs bind the event sender to the authenticated IM peer.
Malformed replies, incomplete/repeated pagination and temporary API failures wait;
definite platform denials drop. Membership is bounded at 10,000 and each response
at 1 MiB; larger conversations wait for explicit support rather than admitting a
partial group. There is no inspection cache or automatic HTTP retry.

The caller supplies the bridges service's `SecretUse` (composed with the real
holder by the root), and a staging read gate. The gate runs before every request,
then `withValue` checks current secret authority and confines the token to that
request. Requests use only Slack's fixed HTTPS API origin, refuse redirects and
time out after 15 seconds. Errors and returned inspection evidence contain no
upstream response words or credentials. This client is not yet registered: Socket
Mode, the engine's legacy credential seam, runtime admission and daemon lifecycle
composition remain required before production activation. Fake HTTP tests do not
claim live connectivity or end-to-end adapter readiness.

A definite denial means the channel or requested user is unavailable to this bot
(`channel_not_found`, `not_in_channel`, `user_not_found`, `user_not_visible`). Bot
credential/configuration failures such as `missing_scope` and `account_inactive`
wait for owner repair, as the legacy Slack check failures did; they do not prove
that the sender is permanently ineligible. Malformed envelopes never imply a
definite denial. The durable engine's transient intake budget still applies.

## Slack Socket Mode transport

`slackSocket` implements the connection protocol without registering an adapter.
It acquires the app-level credential through the supplied service `SecretUse` on
**each** `apps.connections.open` call, checks staging before acquisition and dial,
refuses redirects and non-Slack WSS targets, and keeps the returned ticket private.
The HTTP response is bounded at 16 KiB, frames at 1 MiB, and queued envelopes at 64, including ACK writes awaiting their socket callback.
Connection/hello deadlines are 15 seconds; a 30-second ping requires a pong within
10 seconds. Failures refresh the URL with exponential backoff from 1 to 60 seconds;
a successful Slack hello resets backoff. Shutdown cancels timers, aborts the open
request and suppresses late ACKs and connections. No history polling is performed.

The raw `events_api` payload goes to a receiver that **must commit durable receipt
before resolving**, including duplicates. The transport ACKs only after that
resolution. Failed receipts disconnect without ACK. The receiver must deduplicate
platform event identities across restarts; `envelope_id` is only an ACK address.
Slack has no session/sequence resume cursor. Unacknowledged envelopes rely on Slack's
retry delivery, so receipt/ACK is not a claim of lossless history recovery. In-flight
receipts can finish after close, but their obsolete socket is never ACKed. Unsupported
interactive and slash-command envelopes are consumed without runtime delivery.
The protocol reference is [Slack's Socket Mode guide](https://docs.slack.dev/apis/events-api/using-socket-mode/).

The fake HTTP/socket/clock fixtures include a `startLoom` durable receiver and
restart deduplication. This fixture receiver is not the production raw inbox.
Raw inbox integration, authenticated workspace/app binding, People normalization,
fresh Web API inspection, admission and daemon registration remain required. This
slice changes neither `serve --next` nor the legacy programs and makes no live
connection. The existing engine's normalized inbox cannot simply receive the raw
payload: durable raw receipt must precede fallible platform metadata reads.

## Slack raw durable inbox

Migration 3 installs private `bridges_slack_receipts` on every new-side home. The
`slackInbox` receiver is the production store building block for Socket Mode;
composition and daemon startup are still pending. It takes an authenticated,
explicit workspace/bot/agent/app binding and checks the current enabled venue
before accepting a receipt. The app id must come from authenticated composition,
never be copied from an incoming payload to manufacture its expected value.

The receiver validates `event_callback`, matching `team_id` and `api_app_id`, and
bounded `event_id`/inner event fields. It commits the event in its own transaction
before its Promise resolves, without metadata HTTP calls, admission or runtime
availability. Calling it from an enclosing transaction fails rather than ACKing
work that might roll back. The [Slack Events API field reference](https://docs.slack.dev/apis/events-api/)
defines the app/workspace binding and globally unique `event_id`; this is distinct
from the Socket Mode `envelope_id` ACK address. The first event is immutable and
deduplicated per connection identity and app across envelopes and restarts.
Different events with the same message timestamp remain distinct raw receipts;
the normalized engine still deduplicates platform message ids per addressed agent.

Only the inner event is stored, bounded to 1 MiB. The outer verification token and
authorization array are not retained. No operation or live record exposes raw
words. Pending reads are bounded to at most 64 entries and recheck the current
venue snapshot and transactional setup revision; any setup edit, including an
edit-and-restore, disablement or removal/recreation, invalidates the old receiver.
Composition must recreate receivers after every setup revision, including link and
route edits. A fresh receiver with the same identity may recover its pending work. A
replacement identity cannot read or consume its predecessor's events. Old pending
rows remain private for disposition; they are never silently rebound.

The daemon normalizer must page `pending`, perform fresh metadata/People/runtime
checks, and durably accept the normalized message through engine.receive before
calling `consume`, or consume after a definite discard. Consumption erases the
raw event and keeps its permanent deduplication tombstone. A crash after normalized
receipt but before consumption replays the raw event against the engine's stable
message id. Temporary normalization failures must retain raw receipts for retry;
their expiry, staging hold, setup-change disposition, serialized drain and shutdown
lifecycle are still required composition work. There is no production socket
registration, admission, metadata normalizer, or credential/app verification path
in this slice, and no activation claim.

| Legacy behavior | Replacement / remaining work |
| --- | --- |
| Socket handler ACK before in-memory queue | Socket receiver now has a production SQLite store; fixture proves commit before ACK |
| Restart loses queued raw events | Pending raw events and dedup tombstones survive restart |
| Fallible metadata before normalized receipt | Raw receipt precedes all metadata; daemon normalizer/registration still required |

## Slack authenticated app evidence

`slackApi.authenticate` calls [auth.test](https://docs.slack.dev/reference/methods/auth.test/)
with the configured bot secret and requires the configured workspace and bot user.
It then queries [bots.info](https://docs.slack.dev/reference/methods/bots.info/)
using the returned bot ID (distinct from its user ID), checks the same bot/user and
`deleted: false`, and returns only `{workspace, bot, app}`. `bots.info` requires
`users:read`, already needed by intake inspection. Missing scopes, mismatches,
malformed metadata and API failures return `wait` for configuration repair.
Each request independently checks staging and current service secret authority.
No cache, incoming payload, token or response text supplies the expected app ID.

This is point-in-time evidence for future composition, not an authority lease or
proof that a separately configured app-level token belongs to that app. Composition
must invalidate/revalidate on setup or credential changes and use this app ID to
reject mismatched incoming `api_app_id` values. Socket registration, raw drain,
normalization/admission and lifecycle remain required; nothing starts IO on install.

## Slack raw normalization drain

`slackDrain` is an unregistered, serialized handoff from the private raw inbox to
`Bridges.receive`. It inspects each candidate through fresh `slackApi.inspect`
evidence before using `slackMessage`; human display names come from current People
via unambiguous owner-written links, never Slack labels. The engine then resolves
links and repeats fresh inspection/runtime admission, including every group member.
Normalization does not grant admission. Unsupported events and definite platform
refusals erase raw words; metadata waits and failed normalized commits retain them.
Consumption follows the normalized commit. A failure between commits replays the
same stable engine message ID without a second delivery.

Each pass handles at most 64 raw receipts in receipt order, using a received/id
cursor to pass retained failures before wrapping to retry them. Failed checks retry
after five seconds; backlogs schedule another bounded pass. The conservative raw
budget starts at the immutable receipt time: exactly one hour remains eligible,
more than an hour erases raw words and retains the deduplication tombstone. This
raw budget includes time spent staged or offline and is distinct from the engine's
first-transient-result budget. An attempt begun within the raw budget may finish.

The drain rechecks the enabled venue snapshot and persistent setup revision after
metadata IO and before handoff. Setup changes permanently stop the old drain, even
when restored. Composition must also provide a current credential-generation check;
a false check stops it permanently. Reauthenticate and recreate the binding/drain
after either change. Pending receipts stay private and can be recovered only by
a fresh drain for the same authenticated identity; replacement identities cannot
read them. Owner disposition of obsolete identities remains required.

The staging gate runs before metadata and again after awaits. Held staging retains
raw receipts until release or expiry when draining resumes. `close` cancels timers,
prevents a late handoff and waits for the current metadata/handoff Promise; the
root must await it before closing the database. No new IO begins after close.
The root still must authenticate the binding, supply service SecretUse and trusted
People names, start the socket, call flush at startup/receipt/release, invalidate
on setup/credential changes, and install shutdown ordering. No root registration
or live connection is introduced here.

| Legacy queue behavior | New building block / remaining work |
| --- | --- |
| Fallible metadata before delivery | Durable raw receipt, fresh API inspection, People normalization, then engine commit |
| In-memory retry with one-hour expiry | Immutable raw receipt age, five-second retry and tombstone erasure |
| Shutdown during intake | Serialized close suppresses late handoff; daemon registration remains required |

## Next-mode Slack lifecycle composition

`startLoom({next:true, bridges:{source, credentialEpoch, name, receive}})` now
binds the authenticated bot/workspace/app evidence, service-scoped `SecretUse`,
raw inbox, serialized drain and Socket Mode transport. The supplied source is the
public authenticated holder source; no grants or credentials are discovered.
`credentialEpoch` is a trusted holder generation callback, and must change for
any replacement of either token. Setup revision and public secret name, grant,
policy and access changes invalidate immediately; a five-second lifecycle check
also observes holder generations. Traffic/status notifications do not invalidate
setup. Each new session authenticates again, including after edit-and-restore.

Startup drains saved receipts without waiting for a new socket event. Receipt
ACK waits only for the raw commit. The root waits for active drain/authentication
work before closing SQLite, on both normal shutdown and startup failure.

In staging, one explicit core effect releases one connection lifetime, including
its reconnects and metadata reads; a new identity, credential generation or daemon
restart needs another release. This is a technical choice: read/dial callbacks
share one connection lease rather than asking separately for each metadata page.
Outgoing messages still require their own engine send effects. This slice exposes
trusted programmatic composition only: CLI holder/engine wiring, real People name
resolution, runtime role reconciliation and obsolete-identity disposition remain
required before activation. The injected receive callback is the small runtime
seam and can use a fake while runtime delivery is absent.

| Legacy lifecycle | New replacement |
| --- | --- |
| Slack adapter start/reconnect | `installSlackDaemon` authenticates then starts `slackSocket` with service credentials |
| Retry waiting input on startup | Startup `slackDrain.flush`, receipt/release flush and bounded lifecycle timer |
| Config/credential replacement | Synchronous invalidation, socket retirement, awaited drain close, fresh app authentication |
| Adapter shutdown | Next root awaits authentication and drain before database close |

## Discord Gateway transport

`discordGateway` is an unregistered JSON v10 transport following the
[Discord Gateway protocol](https://discord.com/developers/docs/events/gateway).
It identifies with guild, guild-message, DM-message and message-content intents
(37377); message-content access must already be enabled for the bot. It validates
READY against the configured bot and confines Identify/Resume tokens to one
service `SecretUse.withValue` socket write, with a lifetime/staging recheck after
holder acquisition. The initial endpoint is Discord's documented
`wss://gateway.discord.gg`; resume endpoints must be Discord gateway WSS hosts.
No redirects, compression, arbitrary gateway hosts or credential diagnostics.

The mandatory private store callbacks are a composition contract, implemented
by the unregistered `discordInbox` below: `load` returns an identity/credential-generation-bound checkpoint;
`commit` atomically retains needed raw dispatches and their session/URL/sequence;
`reset` durably removes an invalid cursor. A raw receiver must commit before
resolving and deduplicate platform message identities. It must not perform
metadata reads, admission or runtime delivery in this transaction. Unsupported
metadata dispatches can advance the cursor without retaining their contents.
The transport serializes writes and resumes only from their committed sequence;
heartbeats use the last received sequence. Reconnect waits for an in-flight commit,
then skips queued obsolete frames so Discord can replay them. Replay is accepted
before RESUMED. A failed transaction preserves the preceding cursor.

Heartbeat jitter, ACK timeout, server-requested beats, reconnect/invalid-session
opcodes, nonresumable close codes and terminal authentication/intent/sharding
errors are handled explicitly. Failed connections back off from 1 to 60 seconds;
invalid-session replies wait at least five seconds. Identify calls in this
transport are at least five seconds apart; app-wide Identify quota/shard
coordination is not implemented. Frames are limited to 1 MiB, queued dispatches
to 64 and silent connection/READY waits to 15 seconds. Close cancels all timers,
terminates the socket and awaits credential/receipt work. Upstream errors and
session IDs are never returned as records or diagnostics.

The fake sockets/clock and disposable `startLoom` SQLite fixture prove protocol,
commit ordering, rollback and daemon-restart resume. The opt-in daemon below composes these building blocks with an injected holder generation and handoff. CLI and real engine composition remain required. No history poller fills gaps when Discord invalidates or expires
a session; resume is bounded by Discord's retained events, not lossless recovery.
Opening the preview starts no Discord socket. Only an explicit trusted `bridges` root option enables the daemon below.

| Legacy intake behavior | New transport / remaining work |
| --- | --- |
| Poll latest message, then cursor/lookback scans | Identify receives new events; session/sequence Resume replays retained missed events |
| In-memory delivery queue | Atomic private raw/session store below; opt-in daemon composition below |
| Adapter process reconnect | Gateway heartbeat, Resume/Identify and bounded backoff; opt-in daemon registration below |

## Discord private receipt and session store

`discordInbox` implements the Gateway's private `load`/`commit`/`reset` contract
in `bridges_discord_sessions` and `bridges_discord_receipts`. One SQLite
transaction retains a MESSAGE_CREATE and its checkpoint; a failure writing either
rolls both back. Other dispatches advance the checkpoint without retaining their
payload. A READY must match the configured bot. Session changes require reset;
sequences within a session must increase. Only canonical positive uint64 message
ids are retained; malformed message ids are discarded while advancing the cursor.

The store snapshots setup and binds both tables to a hash of the receiving venue,
workspace, agent, bot, secret reference and public holder generation. Every call
checks the current setup revision and trusted generation callback. Restored setup
still invalidates the old receiver. A new credential cannot load, read or consume
the prior generation's cursor or words. These private tables have no operation,
projection or live notification. Session ids are retained only in the cursor table.

Reads page at most 64 pending messages. Consumption erases words and retains the
message-id tombstone. Reset erases only the cursor; pending messages and dedup
tombstones survive reset and restart. A replay of the same platform message keeps
the first receipt. The caller must serialize commits and reset (as the Gateway
does), and consume only after normalized receipt commits or definite discard.
No callback may join an enclosing transaction.

The opt-in daemon below binds this private store to authentication and staging. Obsolete
identity disposition and a migration/move plan remain required. No old store is
read and no running home is changed.

| Legacy behavior | New store / remaining work |
| --- | --- |
| Memory-only Gateway cursor | Atomic private SQLite session and raw message commit |
| Replay after reconnect | Permanent platform message-id tombstone per receiving identity/generation |
| Process-local message queue | Bounded pending receipt reads; normalization and opt-in root registration below |

## Discord fresh REST evidence

`discordApi` is the service client used by the opt-in daemon below. `authenticate` calls [Get Current User](https://docs.discord.com/developers/resources/user#get-current-user)
and [Get Guild](https://docs.discord.com/developers/resources/guild#get-guild),
requiring the configured bot user (`bot: true`) and configured guild. This is
point-in-time identity/access evidence, never an admission or credential lease.
Composition must bind the same service credential and invalidate on setup or
public holder-generation changes before using it for a Gateway/store lifetime.

`channel` uses fresh [Get Channel](https://docs.discord.com/developers/resources/channel#get-channel)
metadata: text/announcement channels must match the configured guild; threads
require a fresh supported parent in that same guild. Thread names are never
returned; only the parent name supplies a label. DMs require one recipient matching
the event sender and no guild; group DMs are unsupported and drop. Missing or
malformed evidence waits. Definite 403/404 channel/parent denials drop; 401,
rate limits, network/server failures and all authentication failures wait.
Runtime still owns linked-person, peer, webhook and route admission.

Each request uses the service `SecretUse` callback, checks the lifetime/staging
gate before acquisition and after the holder responds, and checks again before
returning evidence. No credentials are retained or returned. Requests use only
Discord's fixed HTTPS v10 origin with canonical uint64 path IDs, reject redirects,
time out after 15 seconds, and bound streamed replies to 1 MiB. No upstream error
text escapes. There is no cache or automatic HTTP retry: the durable drain owns
retry and expiry. The raw drain and opt-in daemon below provide authenticated root/store/Gateway binding. Nothing starts a socket or reads an old store here.

| Legacy metadata behavior | New building block / remaining work |
| --- | --- |
| Bot-token identity/configuration | `discordApi.authenticate`; opt-in root lifetime binding below |
| Channel/thread-parent lookup | Fresh `discordApi.channel`, safe parent label; raw drain below |
| DM sender/place inference | Fresh one-recipient DM match; runtime admission still required |

## Discord raw receipt normalization

`discordDrain` serializes bounded pages of the epoch-bound private inbox through
fresh `discordApi.channel` evidence and `discordMessage` into `Bridges.receive`.
Only after that normalized durable commit resolves are raw words erased; replay
after a failed consume uses the same engine deduplication key. Definite unsupported
payloads and platform refusals become permanent raw tombstones. Transient metadata
or commit failures retry after five seconds, without changing receipt time. Raw
receipts expire after more than one hour, checked before starting an attempt;
an attempt started within the hour may finish. Pages hold at most 64 receipts and
advance past waiting prefixes before wrapping, so one failure cannot starve later
receipts. Current configured bot roles resolve explicit managed-role summons.

Setup revision, public credential generation, composition lifetime and staging
are rechecked after metadata and normalized commit waits. A changed binding
permanently stops that drain; staging retains words until release. Close cancels
retry timers and awaits in-flight work. The injected metadata role must be the
fresh service-scoped REST client; it grants no runtime admission.

The opt-in daemon below supplies authentication, Gateway/store/drain composition and startup/release hooks. Real holder-generation sources and CLI/engine composition remain required before production activation. Peer/webhook identity and legacy
receipt disposition remain in the earlier intake inventory on t-2210.


## Discord opt-in daemon lifecycle

`startLoom({next:true,bridges:...})` now starts `installDiscordDaemon` beside the
Slack daemon. It uses the real grant-checked bridges service `SecretUse` from the
injected holder source, authenticates the configured bot and guild, then binds
Gateway commits and normalization to the same setup revision and public credential
generation. `discordSocket` is a trusted test transport injection; Slack's existing
`socket` option stays specific to Slack. No operation input can supply either.

Staging holds holder reads, authentication and dialing behind a connection effect.
Release permits reconnects and fresh metadata for that one lifetime, including
transient authentication retries. Setup edits (including restore), secret/access
notifications, credential rotation or restart end the lifetime; replacements need
a new staging release. A separate five-second detector invalidates generation
changes even while authentication or normalized handoff is pending. Startup,
raw commits and release flush saved receipts. Gateway progress waits only for the
atomic raw/checkpoint commit. Shutdown invalidates synchronously once daemon close
starts, cancels timers, terminates sockets and awaits holder, metadata and handoff
work before SQLite closes, including root startup failure.

This is trusted programmatic composition with an injected durable `receive` role
and public `credentialEpoch` callback. It does not claim CLI activation, a real
keyholder generation source, People name composition or a bridge-compatible runtime
admission/delivery/stop implementation. Those and legacy engine secret-role removal
remain required on t-2210; the current Comms runtime installer is private to Comms.
Old stores, running homes and deployed services are untouched.

| Legacy lifecycle | New composition / remaining work |
| --- | --- |
| Discord adapter start/reconnect | `installDiscordDaemon`: fresh bot/guild authentication, private inbox, Gateway, REST and drain |
| Process-local receipt progress | Atomic raw/checkpoint commit, independent normalized drain, startup recovery |
| Adapter shutdown | Invalidation and awaited Gateway/drain close before database shutdown |
| Credential replacement | Trusted public generation plus setup/access invalidation; real holder-generation source remains required |
