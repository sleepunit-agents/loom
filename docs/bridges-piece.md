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
