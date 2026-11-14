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

`startLoom({next:true, bridges:{source, name, receive}})` now
binds the authenticated bot/workspace/app evidence, service-scoped `SecretUse`,
raw inbox, serialized drain and Socket Mode transport. The supplied source is the
public authenticated holder source; no grants or credentials are discovered.
The source supplies the public asynchronous `generation()` capability described below. Setup revision and public secret name, grant,
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
and public holder generation source. It does not claim CLI activation, a real
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

The Discord and Slack daemon lifecycle loops remain separate in this slice. This
keeps each transport binding explicit while their authentication, cursor and
receipt contracts differ; lifecycle fixes must be checked against both daemons.


## Authenticated asynchronous holder generations

The trusted next root now requires `source: SecretValueSource & HolderGeneration`.
The actual `localSecretSource(config)` returned by `configuredSecretHolder` supplies
both capabilities over the pinned private mTLS transport. The root no longer accepts
a separate synchronous credential epoch. A shared `bridgeCredentials` monitor obtains
the initial UUID before either daemon may acquire a value, authenticate or dial.
It reads only public metadata, including while staging holds platform IO. No secret
value, value hash or registry timestamp supplies this marker. A legacy age-file
holder without the capability remains unavailable.

The monitor polls five seconds after each completed read, with a separate five-second
absolute read deadline. Rotation or a failed/malformed/timed-out read synchronously
invalidates both daemons when observed, independently of their pending authentication
or normalization work. Thus a mutation immediately after a successful poll may take
up to ten seconds to be detected if the next read stalls. Once invalidated, late
holder/metadata/handoff results cannot revive or consume for that lifetime. Recovery
to the same UUID still starts a fresh lifetime and needs a new staging release.
Only a successful current read can re-enable credential use. Late expired reads
cannot overwrite newer state. Shutdown cancels the monitor, invalidates its current
marker and ignores late results before the root awaits existing bridge work and
closes SQLite.

This unit replaces the injected generation prerequisite. The persistent-holder test
uses actual household mutation authority and authenticated holder transport, including
identical-value replacement and holder outage; platform transports remain test fakes.
CLI activation, People names, real adapter send/inspect and removal of the foundation
engine's `BridgeSecrets.may/get` interface remain required composition work. Runtime
handoff remains explicitly injected until that subsequent integration.


### Service-owned adapters and explicit holder composition

`serve --next --secret-holder FILE` now supplies the configured authenticated
source to both Changes and Bridges. No extra source discovery or grants are
introduced. The root installs the durable `Bridges` engine and the real
`venueAdapters`, alongside the existing socket daemons. The engine no longer
has `BridgeSecrets.may/get` or receives a token; HTTP adapters acquire each
value through the bridges service's `SecretUse.withValue`. The same role exposes
`SecretUseAuthority.mayUse`, an immediate check of its existing registration,
name and grant/expiry rules; adapters use it after asynchronous admission and
immediately before posting, without acquiring or returning another value.

Each inspection authenticates the configured bot/workspace and fetches fresh
recipient metadata. Each outgoing chunk rechecks runtime admission, setup,
service grants, the observed holder lifetime and staging. Discord posts use
`allowed_mentions.parse=[]`; Slack escapes mention markup and disables markdown,
link parsing and unfurls. Receipts must identify the requested channel. Partial
posts and ambiguous receipts make the whole durable send uncertain, without retry.
The request endpoints follow [Discord Create Message](https://docs.discord.com/developers/resources/message#create-message)
and [Slack chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/).

Staging has a separately released inspection lifetime and one effect per whole
reply. A lifetime permits its repeated reads; holder failure/recovery, setup
changes and shutdown invalidate pending callbacks. Root shutdown waits for the
engine as well as both receivers. The existing public generation monitor remains
the only holder-mutation signal; no value-derived marker is added.

Slack names resolve the explicit bridge account link, then call the installed
`mindRole.personRead` as that venue's agent for its own relationship. Central policy denies agents
access to unscoped commons cards; there is no commons fallback or service grant. Missing or
denied cards yield an absent name; neither owner impersonation nor account fields
on People cards grant bridge authority.

The installed runtime now also supports household-linked one-person Discord and
Slack DMs. `bridgeRuntime` uses the existing household member/agent relationship
rule, queues the actual `runtime.startBody` intent, and binds the private runtime
transcript to that member and job. An assigned runner claims the job and takes its
staging-gated input with a central body credential. Only that current running or
waiting body may use `runtime.readConversation` and `runtime.reply`; copied agent
names, unbound credentials, other jobs, owners and runners confer no transcript
access. Revoked relationships, boxes, house configurations, stopped jobs and root
shutdown invalidate access.

Incoming IDs permanently deduplicate private turns and body starts beyond registry
receipt expiry. A reply transaction stores its transcript acknowledgement and calls
`Bridges.reply` with a stable conversation-scoped ID and the original incoming
receipt. Retries retain that address even after another turn arrives or the daemon
restarts. Reply words remain outside registry/live records and stored operation
results. The existing engine performs fresh platform, lifetime, grant and admission
checks and its separate send effect before posting. `stop` revokes the bound body's
credentials and records its own receipt so replay cannot stop a later body.

This first runtime integration is deliberately limited to private household DMs.
Groups, guild channels, peers, guest/readers and paired routes return admission
`wait` until their runtime contracts are implemented; People links alone never
grant access. `NextBridgesOptions.runtime` remains an explicit trusted override
for fixtures. End-to-end fixtures use actual SQLite, Signin, runner claim/input,
body read/reply, provenance and Bridges queues, with fake holder/HTTP/sockets; they
do not launch an external runner process or activate a running home.

| Old path | New path in this unit |
| --- | --- |
| Engine `BridgeSecrets.may/get` and raw token arguments | Credential-owning `venueAdapters` on service `SecretUse` |
| Adapter send with one token for all chunks | Per-chunk grant acquisition and fresh runtime/platform checks |
| Injected Slack names only | Current linked person's installed policy-checked Mind role |
| Holder flag composes Changes only | Same explicit source also composes Bridges |

Retained command parity, proactive first DM, files, read/describe/presence, peers,
pairs, attributed relay, offline importer, raw identity disposition and final move
inventory remain obligations of the full rebuild.

The runtime also rechecks the current delivered source's account link before a
body read or reply. New outbox addresses retain the intended linked person;
relinking an account to another admitted member holds those pending replies.
This metadata never supplies a platform recipient or grants admission.

Runtime receipt dedup compares immutable source content while repeating current
admission; a route edit after a committed delivery cannot create another turn or
strand its acknowledgement. The internal accept operation owns its permanent
private receipt in the registry transaction, with no second core retry cache over
fresh routing metadata. Guest, pair and peer-route flags reach admission before
delivery or stop and are checked again by the trusted runtime delivery seam.

## Offline source inventory (importer prerequisite)

`readBridgeInventory` in `src/pieces/bridges/import-source.ts` is an offline
explicit-file reader. It is not registered with migrate-all and does not import
anything into the database. Normal daemon paths never call it. Every future
registry adapter must resolve **each** selected file with `snapshotPath` before
passing it to this reader; the reader rejects leaf symlinks and special files,
but snapshot confinement of parent directories belongs to that adapter.

Required source inventory:

| Input | Retained configuration |
| --- | --- |
| Each instance's `shuttle.json` | Agent slug, explicitly present Discord/Slack secret references, channel-note references |
| Co-located `people.json` | Exact person and peer account claims, Slack workspace IDs; no tier, scope or grants |
| Co-located `routes.json` | Guild/bot/managed-role IDs, channel/thread claims, peer/pair/guest flags, People reader slugs, only/ignore, webhook-peer, notify and budget metadata |
| `pieces/discord/settings.json` | `DISCORD_BOTS` agent → secret-name map |
| `pieces/slack/settings.json` | `SLACK_BOTS` agent → **bundle** secret-name map |

The future snapshot collector must accept explicit external instance roots when
these files are outside the old home; it must not infer `~/Art`, run old exports,
follow paths in the JSON or modify the source home to stage files. Authoritative
shuttle-store documents may supersede the instance files. Those need a separate
source inventory and comparison before full migration coverage can be claimed.
This reader makes no current-authority or completeness claim for the files.

The inventory retains conflicts between sources and between person/peer account
claims. The importer must resolve or refuse them, never choose a file-order winner.
Readers retain their **People** provenance; they are not agent grants. Absent, null and empty platform sections do not invent a connection or default
secret reference; only explicitly supplied references survive. Slack's bundle reference
cannot supply workspace/bot IDs or separate token/app secret names without reviewed
mapping. A later importer must require those inputs rather than open the bundle or
fabricate names. Other source settings are not imported by this reader.

Each selected file contributes its stable snapshot-relative name, kind, byte count
and SHA-256 to the source checksum, including bytes of ignored legacy fields.
Reads are capped at 8 MiB per file even if it grows after the initial stat. Output
contains selected configuration references, never raw source documents, commands,
credential values or parser/filesystem exception details. Configured `secrets`,
`secret_cmd`, `ext`, `commands`, token files and env bundles are never opened or
executed. Synthetic fixtures cover both old JSON-text settings and object settings,
exact account IDs (numeric spellings must be canonical safe nonnegative integers;
use strings for other IDs; numeric zero is preserved for later importer validation), conflict retention, unchanged sources, sanitized failures and
file-boundary refusals. No real data is used.

The remaining importer still owes one transaction, receipt/checksum, repeat no-op,
different-source refusal, interruption rollback, independent IDs/counts/content
verification, migrate-all discovery/registration, and final move coverage.

### Authoritative store inventory prerequisite

`import-stores.ts` is an unregistered offline evidence reader, alongside the
JSON-file inventory. It is not the destination importer or a precedence resolver.
The caller supplies only completed snapshot files, each resolved through
`snapshotPath`: `home/commons/stores/shuttle.db` and, when present,
`home/commons/stores/runtime.db`. It opens neither live stores nor the paths or
commands inside documents. Store inputs have explicit names and kinds. It retains
all current documents and revisions (including unknown collections, offers,
pending proposals and moved tombstones), exact JSON strings, row metadata, source
byte hashes and a combined inventory checksum. These are private migration
evidence, never grants, executable relay requests or public live records.

Pinned shuttle `c4a188b6` (`shuttle/gates.py`) establishes the source distinction:
`people/<agent>` replaces that agent's file; Runtime people can supersede shuttle
people, and a `moved/<agent>` tombstone forbids fallback when Runtime has no answer.
`routes/household` plus every `channels/<agent>` assemble an agent's route map;
`route-offers` can still require file fallback when accepted parts are incomplete.
Offers and proposals are not accepted configuration. Flags/readers come only from
accepted channel parts; readers name People slugs. Do not pick the first document,
merge contradictory claims by file order, or import an offer as accepted authority.
The inventory deliberately preserves conflicting evidence without selecting it.

The reader bounds each input file to 128 MiB and the combined document/metadata
materialization per store to 8 MiB / 10,000 rows, refusing before selecting words.
SQLite reads use an injected completed-snapshot opener. Exact store columns and
both tables are required; unknown tables/columns refuse rather than disappear.
Unsafe SQLite revision/id integers refuse before numeric coercion; JSON numeric
lexemes stay in their original strings. Source mutation around the read refuses.
Failures are sanitized. Parent confinement and completed-backup consistency belong
to the snapshot caller; this reader is not a live-WAL reader.

The completed-snapshot importer below now collects these stores and explicit
external roots, resolves authoritative sources, retains exact private evidence,
and owns the atomic import and both source-derived verification paths. The
inventory readers are used by the registered Bridges migration; they never run
as daemon adapters or apply legacy authority themselves.

## Completed-snapshot importer

`loom migrate snapshot --from <old-home> --bridges <instance-root> --bridges <another-instance-root> --to <snapshot>`
collects each explicitly named external instance's shuttle.json, people.json and
routes.json under bridges/0, bridges/1, etc. It does not open their configured
paths or env bundles. Registered source rules also collect the home platform
settings and completed backups of commons/stores/shuttle.db and runtime.db.
Runtime's own snapshot root requirements still apply when its store is present.

`loom migrate plan --snapshot <snapshot>` discovers Bridges and emits instance
triples plus an empty connections mapping. Review that plan's Bridges options:

```json
{"instances":[{"shuttle":"bridges/0/shuttle.json","people":"bridges/0/people.json","routes":"bridges/0/routes.json"}],"connections":[{"agent":"art","platform":"discord","workspace":"789","bot":"100","tokenSecret":"art-discord"}]}
```

Every configured **local instance** agent/platform requires one connection mapping.
Bots merely named in routes/settings do not prove a local instance exists. With
explicit instance roots, only their agents require mappings; off-machine bots
remain source evidence. An explicit complete mapping may additionally select a
household bot with accepted source routes. Store-only snapshots require mappings
for declared household bots. Unknown agents never become household agents.
Discord bot and guild must match resolved source routes. A complete Slack mapping
requires explicit workspace, bot-user metadata and distinct tokenSecret/appSecret
names. secrets_env/SLACK_BOTS is a whole bundle reference, never a source of
invented split secret names. No bundle is opened.

For a local Slack section with only a bundle reference, use
`{"agent":"art","platform":"slack","workspace":"TWORK","setupIncomplete":true}`.
The workspace must occur in that instance's `slack.workspaces`. Omit bot,
tokenSecret and appSecret entirely. This creates **no runnable venue**; the
workspace, bundle reference and incomplete reason remain in private import
evidence (`bridges_meta` / `legacy-evidence`, `incomplete`). The completed snapshot
and mapping are the setup-repair inputs. No owner needs to create secrets to
complete migration. Every created venue is **disabled**, with no adapter started.
Incomplete Slack setup does not appear as a fabricated connection on the screen.
The owner reviews setup before enabling anything in the final move.

`loom migrate all --snapshot <snapshot> --home <stopped-new-home> --plan <plan>`
includes Bridges. For a separately imported matching household use
`loom migrate bridges --from <snapshot> --home <stopped-new-home> --mapping <bridges-options.json>`.
`loom migrate verify` supports both `--plan <plan>` and `--bridges-mapping <options>`.
Both derive expected ids, counts and full row content from the snapshot, including
private exact stored documents/revisions. They do not trust destination receipts
as evidence of content. A single owning transaction compares all setup, empty
traffic and private evidence rows; interruption rolls it back, a repeat is a no-op,
and a different source or mapping refuses.

People resolution follows the pinned old runtime's `gates` collection (its CLI
verb is `people`), then shuttle `people`, then the explicit file. A shuttle moved
tombstone without Runtime gates refuses. Routes use accepted routes/household and
all agents' channels parts only when routes_for completeness permits it; otherwise
they use the instance file. Offers affect completeness only; their flags never
become accepted rules. Contradictory people, person/agent platform identities,
channel primaries, threads, connection filters or contradictory present per-agent channel flags refuse.
People readers remain person slugs. Unknown members/accounts and routes whose
primary or readers cannot be projected remain private evidence (`retained`);
the importer creates no member, grant, link or audience-widened route for them.
Thread routes also retain their parent's unprojectable audience rather than
dropping its restrictions. Every unprojectable channel (or affected thread's
parent) is also added to the imported Discord connection's ignore list: a missing
route alone must not permit explicit-mention routing after enabling a connection.
Repair that source audience before removing the block. Identities without a projectable workspace remain
private evidence. Gates, proposals and restrictions remain
Runtime-owned; private source evidence never grants or executes them.

Channel-note file references, webhook-peer maps, notification settings, peer budgets,
unknown store collections and proposals remain inventory/evidence, rather than
being manufactured into unsupported setup fields. Runtime admission still holds
unsupported peer/guest/group forms. Their remaining behavior matrix is tracked on
t-2210; this importer does not claim that work complete. Source JSON inventory is
whitelisted configuration plus byte digests; exact source files remain in the
completed snapshot. Stored documents and revisions retain exact JSON strings,
including numeric lexemes, privately in bridges_meta and never live records.


### Household mapping procedure (one Art root, Art/Mark/Fez routes, work Slack)

The coordinator performs these steps offline on a completed snapshot, without
reading credential values or contacting Discord or the work Slack workspace:

1. Supply exactly the existing `~/Art/bridge` root to snapshot's repeatable
   `--bridges` option. Do not invent Mark or Fez roots. Preserve the discovered
   `instances` triple under `bridges/0`; include both platform settings and both
   completed store backups in the plan's paths. A Runtime store also requires
   the Runtime collector's explicit state/data roots and its own mappings.
2. Read `bridges/0/shuttle.json`: `agent.slug` supplies `art`;
   `discord.token_file` supplies the existing **secret name** `discord-token`.
   Do not open that file. Read the selected routes: workspace is `guild`, bot is
   `bots.art`. When accepted shuttle `routes/household` and `channels/<agent>`
   parts are complete, use their assembled guild/bot instead of a stale file;
   inconsistent claims refuse. No discovery API is necessary.
3. Add only Art's Discord complete mapping. Mark and Fez route bot IDs are
   evidence of peers/off-machine setup, not requests for local connections.
   The existence of `mark-discord-token` does not create a local Mark instance.
   Fez need not be a household agent for this archive to pass.
4. Read the single key of Art's `slack.workspaces` for workspace (the `T…` ID).
   Its value is a display name, not an ID. `slack.secrets_env` supplies only
   the retained bundle reference `slack-onterris.env`. With no split names and
   no offline bot-user metadata, add the incomplete mapping below. Do not
   derive a bot from the bundle, guess secret names, or request new secrets.
   For a future complete setup, bot is the authenticated Slack **U… bot user**,
   not the B… bot ID; tokenSecret/appSecret must name separately established
   bot/app credentials. That setup is outside this import.
5. Put these connections in the discovered plan options, preserving `instances`:

```json
{"connections":[
  {"agent":"art","platform":"discord","workspace":"<routes.guild>","bot":"<routes.bots.art>","tokenSecret":"discord-token"},
  {"agent":"art","platform":"slack","workspace":"<single slack.workspaces key>","setupIncomplete":true}
]}
```

Run plan validation, all, and independent verify with that same reviewed plan.
For standalone import/verify the mapping file contains the full options object
(`instances` plus `connections`), not this connections-only illustration. Verify
that only Art's disabled Discord venue exists and Slack's incomplete evidence
names the workspace and bundle. The synthetic household rehearsal exercises
plan, all and both verifiers, including evidence tampering. Imports start no
adapters, make no venue calls, and do not enable or change the work workspace.

### Legacy source annotations

Keys beginning with `_` are human annotations at every object depth in the
instance JSON, platform settings bot maps (including JSON encoded as text), and
selected accepted-store documents. Projection skips these keys before schema
validation and assembly; they never become accounts, bots, workspaces, channels,
filters or other identities. This does not relax validation of other keys or
array entries. Original file bytes stay in the private completed snapshot and
source digests; exact store JSON stays in the private evidence archive.
Configuration schema refusals report the source file kind and JSON field path,
without values or parser/filesystem exception text. Malformed instance JSON
reports the file root `$`; malformed stored JSON identifies its document field.
Accepted-route diagnostics map assembled fields back to their original store
collection/key/field.

### Discord history transport (not yet a public read command)

The internal `discordApi.history` reads a channel/thread only with a trusted
`DiscordHistoryPermit` matching the exact agent, workspace, channel and kind.
The owning role must keep its `current()` proof valid; Bridges makes no read
permission decision. No installed Runtime permit issuer exists yet, so this
transport is unregistered and cannot be reached through a public operation or
command. DM admission is not a substitute. Runtime sender resolution and
`may_wake`, the public read operation/client and legacy output parity remain
required in the [inventory](bridges-contract-inventory.md).

Each read checks fresh channel type/guild evidence and reacquires the Bridges
service credential for the history request, with lifetime/staging/permit checks
before and after IO. Results retain all message classes, original author IDs,
platform time (snowflake fallback), and attachment descriptions, oldest first.
No body starts, reply posts or route filters run. Limits are 1–100; first sight
defaults to the latest one, `after` defaults to 100. Extra source fields, labels
and upstream errors are not returned. Reads are bounded by the existing 15-second
request deadline and 1 MiB response limit; ambiguous/malformed results wait.
This ports the transport part of legacy loom-discord `5d197bac` read; the
permission/identity half stays with Runtime. All test permits are explicit fakes;
Secrets registration/grants/erasure use the actual installed next role.

History response choice: the old Python reader treated null attachments as an
empty list. The new REST transport refuses a supplied non-array attachment field
(including null) as malformed evidence; an omitted field still means no
attachments. This stricter source validation changes no reader authority.

### Sparse accepted flags

A missing flags map or missing channel entry is silence, not a conflicting entry.
Only two present entries whose normalized fields disagree refuse; the error names
shuttle.db, channels, the agent, channel and differing field, without values.
Every present entry is validated before deciding whether it can be projected.
A present null/non-object flags map refuses; invalid numeric lexemes refuse
before serialization can turn their internal NaN marker into a nullable field,
including any schema-recognized channel fields present in an accepted flag entry.
Thread fields are validated before discarding their local permission flags for
parent inheritance.

The new route is global; accepted flags were per agent. If a non-default flag has
any silent part, the importer conservatively blocks the entire channel and its
threads for every imported Discord venue (ignore list), omitting its live route.
This deliberately drops more traffic rather than widen peer, pair or reader
permission. It does not discard readers or a pairing constraint into a runnable
less restricted route. No silent part inherits another agent's rule. Explicit
default-only entries need no block. Identical entries present in every part retain
their rules. Private legacy-evidence.retained reports each dropped non-default
field as source, collection, agent, channel and path; exact documents remain in
stores. Review and repair these channels before removing their import blocks.

## Internal presence lifecycle

`presence.ts` is an unregistered controller for one authenticated agent/venue/place.
An explicit fake owning role supplies working/done, original take times, heartbeat
and last-post time in `presence.test.ts`. Eyes are set once per taken ID and removed
on reply, completion, disappearance or a heartbeat stale at 90 seconds. Discord
supplies a typing effect every five seconds while a reply is owed; Slack does not.
Only the newest twenty unique takes are eligible. Failed cleanup consumes slots,
so repeated new takes cannot grow uncertain reaction state beyond twenty.

The controller serializes updates, rechecks the owning facts and composition gate
before each effect, cleans late reactions after completion during IO, retries
idempotent uncertain reactions, and awaits in-flight IO on shutdown. A transport
must check the supplied predicate after acquiring its service credential and
immediately before IO. An unavailable source or staging gate holds all effects;
a lost setup/credential lifetime permanently stops the controller.

This is internal lifecycle proof, not platform or public support: there is no
installed Runtime presence source, public status command, daemon registration or
durable restart cleanup yet. The unregistered service transport is described below. Its bounded state is
in memory; a crash could leave eyes behind. Production wiring must first supply
the owning role and durable cleanup. Stop and peer-turn budgets
remain Runtime responsibilities; this controller adds no policy for either.


`presence-transport.ts` implements the internal `PresenceEffects` seam: Discord
PUT/DELETE of this bot's eyes reaction and POST typing; Slack `reactions.add` and
`reactions.remove` with `eyes` and the original message timestamp, with no typing.
It is deliberately unregistered. Fixtures supply an explicit fake authenticated
exact-place owning role; this is not evidence of actual Runtime lifecycle support.
The service's `SecretUse` is reacquired per request, then the exact-place proof,
staging and controller facts are checked immediately before HTTP. No credentials
or platform response words escape. Slack replies are bounded to 4096 bytes;
`already_reacted` on add and `no_reaction` on remove acknowledge idempotent retries.
Other failures remain uncertain, with retry owned by the controller. A late
successful add is acknowledged even after done so the controller can remove it
before typing. No daemon, status command or durable restart cleanup is supplied.

Endpoint contracts: [Discord own reactions](https://github.com/discord/discord-api-docs/blob/main/developers/resources/message.mdx),
[Discord typing](https://github.com/discord/discord-api-docs/blob/main/developers/resources/channel.mdx),
[Slack add](https://docs.slack.dev/reference/methods/reactions.add/) and
[Slack remove](https://docs.slack.dev/reference/methods/reactions.remove/).

## Platform status command

The generated client accepts `loom-bridges status '{"platform":"discord"}'`
(or `slack`) and calls the read-only `bridges.status` operation. It uses the same
central household setup authorization as the existing setup commands. No service
credential, platform lookup, body admission, effect or receipt is needed.

JSON retains the pinned legacy dispatchers' `mode`, `agents` and `held` fields.
Agents are sorted and deduplicated from all configured connections, including
disabled ones. Held counts intake rows whose original platform identity matches,
including rows for a removed or reassigned connection; pending retries, delivered
or dropped intake and outgoing holds do not count. It reports current durable
state, not a historical window or an assertion of connection health. Mode is
`live` normally and `staging` when installed by next-mode staging composition;
this describes the process effect gate, not whether a connection is enabled.

The old shadow mode and `shadow_lines` field retire with whole-side staging.
The old human text line and `--json` switch are replaced by the generated client's
always-JSON output. JSON is pretty printed like the other generated setup commands.
Success exits 0; daemon refusal/unavailability exits 1 with sanitized stderr;
local malformed usage exits 2. Synthetic fixtures retain both pinned old JSON
examples, compare the retained fields and exact new output, force reverse agent
order through record IDs, and cover connection reassignment. The operation and
client share a closed status response schema. Fixtures exercise the real
HTTP operation, empty setup, staging composition, permission denials and closed
response shapes. No old files or programs are read on the next runtime path.

## Internal Slack first-DM transport

`slack-open.ts` supplies unregistered `slackOpen(...).open()` IO for the pinned
legacy Slack `test_a_message_to_one_person_is_one_dm` contract's open step.
It checks fresh same-workspace human eligibility with `users.info`, then calls
[`conversations.open`](https://docs.slack.dev/reference/methods/conversations.open/)
with exactly one `users` ID and `return_im=true`. Only a D-prefixed IM whose
returned user matches that recipient is accepted; no shared/group conversation
or raw platform fields are returned. Existing DMs use the same uncached path.

A trusted recipient role binds agent, venue, workspace and user. Its `current()`
must include authenticated bot setup, credential generation and current Runtime
authority to contact that person. Tests provide an explicit fake owning role;
there is no installed Runtime issuer, public operation, command or daemon wiring.
People links and platform eligibility confer no recipient authority.

Every request reacquires the service's SecretUse and rechecks the exact recipient,
lifetime and dynamic composition gate after acquisition, immediately before IO,
and after the response. Opening a DM is an outside effect even without words.
Responses are bounded to 1 MiB, readers are cancelled, redirects are refused and
each request has a 15-second deadline. Failures and late revocations return only
fixed uncertainty, with no local retry or cached channel/token. An uncertain open
may have created a DM; this transport cannot assert rollback or delivery.

Runtime recipient authorization and attribution, a durable staged open/post
workflow with uncertain-send handling, and generated send command parity remain
required on t-2210. No message is posted, no inbound message is fabricated, and
no existing reply path is widened by this internal transport.

## Internal Slack file fetch

`slack-files.ts` is an unregistered transport for the first five attachments of
one delivered Slack message. An explicit fake `SlackFilesPermit` supplies exact
agent, connection, workspace, channel, delivery and immutable file descriptors in
fixtures. There is no installed Runtime issuer or public operation. Current
setup, credential generation and delivered-message authority belong to that
issuer; staging remains a separate composition gate. Checks repeat after holder
acquisition, headers, every body read and before returning the batch.

Each request acquires the Bridges service credential anew and sends it only to
literal `https://files.slack.com/` URLs, with no credentials, port, fragment,
backslash, whitespace or redirect. Literal/encoded dot path segments and nested
path escapes refuse before URL normalization. HTML/XHTML response MIME types refuse. Declared
and actual bodies are bounded to 25 MiB per file; a fifteen-second deadline covers
both headers and streaming, cancels readers and never retries. Names retain the
old safe eighty-character basename convention. Failures return fixed text,
without platform words, paths or credentials. Failed batches erase their owned
completed buffers and return no partial result.

| Legacy Slack files behavior | Replacement / remaining work |
| --- | --- |
| `Files.fetch`, `test_at_most_five_a_message` | Internal first-five batch, service credential per file, exact Slack HTTPS origin and bounded download |
| `test_never_sends_the_token_anywhere_but_slacks_file_host`, size/page/id/name cases | URL preflight, no redirects, MIME rejection, 25 MiB streaming cap, safe names and file-id validation |
| `Files.take`, body `runtime file`, `send --file --out` | Pending Runtime delivery/body authorization and private storage/retrieval; transport returns bytes only to its trusted caller |
| Fetch-once and fourteen-day prune | Pending durable storage, dedup and daemon retention job; no cache or storage is claimed by this unit |
| Shadow fetches nothing | Separate current staging gate, rechecked around IO; no adapter is registered |

This implements only the fetching half of the pinned `loom-slack` `files.py` and
`test_files.py` contract. No files are fetched during intake yet. Secure private
storage, delivery-scoped retrieval, fourteen-day retention, generated command
parity and actual Runtime owner proof remain required before file support is
complete. No caller-supplied output path is accepted here.

## Private attachment storage seam

`file-store.ts` and migration 005 keep bounded Slack attachment bytes in private
SQLite tables. No file table is a live record, and the installed owning export
filter excludes bytes, delivery manifests and source associations from exports
and backups. Filenames are safe metadata; no output path is accepted. No legacy
file directory is read. `save` commits a complete batch and its exact delivery
associations atomically. Repeated scoped file IDs deduplicate identical bytes;
changed content/name or a changed delivery manifest refuses without overwrite.
Deduplication is by scoped platform file ID (as in legacy `Files.fetch`), not
cross-ID content-addressed sharing; distinct file IDs remain independent.
Deduplication never refreshes the original file age. Descriptors persist only as
a digest, without the Slack URL.

The save proof also binds the original Runtime delivery timestamp; replaying an
expired source refuses even after prune/restart, and changing its timestamp on an
existing delivery refuses. Retention starts at that original delivery time.
Scope is agent + venue + workspace + channel, with a separate exact delivered
message association. `read` additionally requires a trusted exact active-body
Runtime proof, rechecks it before returning an owned buffer, and checks content
integrity. The proof owns authentication, job/conversation, delivery membership
and current central policy. Fixtures use an explicitly fake issuer with separate
revocation facts. **There is no production Runtime issuer or public file read.**

Reads refuse at the fourteen-day boundary even when cleanup has not run. The
internal transactional `prune` removes expired data and associations, with
cascading foreign keys; repeated receipt saves do not extend retention. This is
logical deletion, not forensic erasure of SQLite pages/WAL or external copies.
The storage seam does not fetch, register a client,
or put bytes into operation retry receipts. Fetch-once orchestration across
concurrent intake/restarts, actual Runtime access issuance and
command parity remain required. Caller-owned fetched buffers must be erased by
the eventual composition after save; returned read buffers belong to that caller.

| Legacy storage behavior | This unit / remaining work |
| --- | --- |
| `Files.fetch` private scoped storage and fetch dedup | Atomic scoped byte dedup and internal concurrent/restart fetch-once; actual Runtime intake wiring pending |
| `Files.take` scoped bytes, digest and safe name | Internal delivery/body-proof retrieval with no output path; actual Runtime issuer and generated file command pending |
| `Files.prune` fourteen-day expiry | Exact expiry on every read plus transactional prune; next-mode startup/hourly job installed |
| Private on-disk file copies | Private `loom.db` BLOBs, excluded from owning export/backup; no legacy file read |

### Slack describe platform evidence (internal only)

`slack-describe.ts` is an unregistered service transport for the platform part of
legacy `send --describe` (`loom-slack` pinned at `4acf0562`,
`test/test_describe.py`). An explicit trusted exact agent/venue/workspace/place
permit authorizes fresh reads; there is no installed Runtime issuer or public
operation. DM places are human user ids; group places are existing MPIM ids.
Nothing opens a DM, posts, starts a body or writes a receipt.

A DM checks the exact user's same-workspace human eligibility. A group checks
fresh channel kind, complete bounded paginated members, this bot's membership
and at least two other participants, then checks every participant independently.
Any guest, bot, deleted/foreign/unknown human, incomplete/duplicate pagination,
platform failure or changed proof refuses the whole result. Every HTTP request
reacquires the service SecretUse and rechecks staging and the captured proof
before/after credential acquisition and across streaming. Replies are bounded
at 1 MiB per request and fifteen seconds including body consumption; pagination
is bounded at fifty pages of at most 200 members. No retry or intake cache.

Only sorted platform human ids and exact place/kind leave the transport, without
profile words or policy fields. Runtime still must map these ids to current
people and determine tiers, restrictions, lowest group tier, owner-present and
project/field/group briefs before wiring a public operation or generated client.
Tests use an explicitly fake owning permit; actual Secrets service-grant and
buffer-erasure fixtures do not claim actual Runtime authority. The old fresh
membership-cache optimization becomes fresh platform reads here; the same
all-human requirement is retained. Describe support is still incomplete.

Describe fixtures independently refuse initially mismatched agent, venue and
workspace before acquiring credentials. They also revoke each owning fact,
staging or a captured proof field after the credential callback completes but
before SecretUse returns, proving no subsequent membership read is issued.

## Attachment retention daemon

Next mode installs `file-retention.ts` after Bridges migrations, independently
of adapter configuration, service credentials or staging. It runs the existing
private-store transactional prune on startup and hourly while the daemon runs.
Expired bytes, delivery manifests and cascaded associations are removed; younger
rows retain their original age. Read-time refusal remains exact at fourteen days;
physical row cleanup can lag expiry by up to an hour while running. This remains
logical deletion, not forensic erasure of SQLite pages/WAL or external copies.

A failed sweep rolls back, logs only a fixed diagnostic and retries on the next
hour; startup can continue. Missed ticks coalesce after suspension instead of
replaying each elapsed hour. Shutdown cancels the timer and fences already queued
work before touching SQLite. Installation is idempotent per database. The old
runtime path installs no retention job. No import or venue call runs.

`file-retention.test.ts` exercises actual next-mode startup/restart in live and
staging modes without adapter credentials, running expiry with younger data,
transaction rollback/recovery, fixed diagnostics and isolated long-clock-jump/
shutdown behavior. Explicit fake save permits only seed private fixture bytes.
Runtime issuance, fetch-once intake/restart orchestration and the generated file
client remain required; retention alone does not enable file support.

## Internal attachment fetch-once orchestration

`file-once.ts` is unregistered and has no production Runtime issuer. It composes
an exact delivered-message permit, a bounded transport callback and private
storage. Within the owning daemon process, independent connections serialize by physical
database file identity and exact agent/venue/
workspace/channel scope. Each caller captures and rechecks its own immutable
permit before and after waiting; one caller's authority never admits another.
Still-live stored file IDs are reused across deliveries and restarts, missing
IDs alone reach the transport, and the original full batch is atomically saved
with each delivery's manifest and associations. Cached bytes pass digest/name/
expiry checks; all intermediate cached/fetched buffers are erased on success
and refusal. Reuse never refreshes the original file age.

A failed fetch or save leaves no success marker and the next caller can retry.
A process stopped after GET but before commit may repeat that GET after restart;
this promises fetch dedup after durable save, not network exactly-once delivery.
Concurrent scopes can proceed independently. Simultaneous daemon processes on
one home are not coordinated by this internal queue: future production wiring
must retain a single owning daemon or introduce durable claims before supporting
multiple owners. The future production composition
must supply the existing bounded Slack transport with service/staging fences and
an actual Runtime permit. This unit installs no daemon intake, public operation
or client and reads no old-side data. Runtime issuance, production intake wiring
and generated command parity remain required.

## Legacy behavior dispositions

[The source disposition ledger](bridges-dispositions.md) separates required
webhook/notification/budget/note behavior from retired old process mechanisms
and still-required cleanup of obsolete next-side raw receiving identities.
It includes source fidelity gaps and move acceptance evidence; none of the
remaining semantic behavior is completed by retaining importer metadata.

## Raw receipt retention daemon

Next mode installs `raw-retention.ts` after Bridges migrations, independently of
platform credentials, current setup, receiving identities and staging. Startup
and each subsequent minute expire at most 64 oldest pending receipts per platform
whose immutable receipt time is more than one hour old. Exactly one hour remains
eligible. Migration 006 adds partial age/id indexes over pending rows; permanent
tombstones do not accumulate in the expiry scan. Backlogs take additional minute
passes; missed ticks coalesce into one bounded pass after suspension.

Expiry changes only raw `event` to null and `state` to consumed in one transaction
across both platforms. Receipt IDs, receiving identity, original receipt time and
Discord checkpoints remain. Repeated events cannot recreate erased words through
`INSERT OR IGNORE`. Younger current or replaced identities remain recoverable;
this age rule does not classify an identity as permanently obsolete. Already
started normalization may finish from its in-memory copy, as before. Normalized
receipts/outbox, Runtime turns and jobs are untouched. This is logical erasure,
not forensic removal from SQLite pages or WAL. No old-side data is read or erased.

Failures roll back the pass, emit a fixed warning without exception text, and
retry on the next minute. Shutdown cancels the timer and fences queued work.
`raw-retention.test.ts` covers actual next startup/restart (including staging and
no credentials), exact boundary/young-row preservation, tombstones/checkpoints,
per-pass limits, coalescing, the installed UPDATE index plans, populated version-005
upgrade/repeated migration, enclosing-transaction refusal/retry, preservation of
existing normalized/Runtime work, atomic failure/retry and shutdown.
Permanent obsolete-binding/checkpoint cleanup still needs its separate lifecycle
and outstanding-work reconciliation; this sweep does not close that required row.
