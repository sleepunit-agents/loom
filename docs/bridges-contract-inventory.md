# Bridge replacement inventory

Coverage for t-2210, audited against main `9453ccd` after #1133, #1128 and #1129.
Read with [the piece overview](bridges-piece.md) and the settled
[new-side move](specs/web-foundation.md#moving-there). Runtime owns authority,
conversation words, turns and bodies; Bridges owns platform IO. Pending means
required work, not an agreed retirement. This audit supersedes the original
#907 inventory: adapters, importer, screen and setup client have since merged.

Pinned legacy contracts:

- [loom-discord at 5d197bac](https://github.com/sleepunit-agents/loom-discord/tree/5d197bacbe80e82b5546656db538cee43c09c835)
- [loom-slack at 4acf0562](https://github.com/sleepunit-agents/loom-slack/tree/4acf056239ae1c431d645068a3be8e71f2623837)
- [shuttle at c4a188b6](https://github.com/sleepunit-agents/shuttle/tree/c4a188b6e3e362ff34903e0ad79b25c1bca77c62)

Paths in the source column below are relative to those repositories. No real
workspace, source snapshot, installed home or external runner is used by these
fixtures. Platform HTTP/sockets and key-holder IO are faked; the installed
next-mode roles, SQLite, routing, normalizers and engine are real.

## Commands, API routes and jobs

| Old entry point | Current replacement / outstanding behavior | Legacy source |
| --- | --- | --- |
| Discord/Slack `run`, shuttle venue adapters | Next daemon lifecycle with service credentials, durable Discord session/sequence and Slack ACK after raw receipt, normalizers and engine; #1096. No subprocess adapter. | Both `bin/loom-*`, shuttle adapters |
| Discord/Slack `status` | Metadata live records and Bridges screen exist; retained command output/exit parity remains pending. Shadow-line count retires with shadow mode. | Both dispatchers/status |
| Both `send --agent --place`, stdin text | Bound body `runtime.reply` queues a durable staged outbox; actual split posting/uncertainty proven for household DMs in #1104. Arbitrary place/proactive sends and retained command parity remain pending. | Both `test/test_send.py` |
| Slack `send --place dm:U…` before intake | Pending Runtime recipient authorization and Bridges `conversations.open` transport. Existing reply requires a delivered incoming receipt. | Slack `test/test_presence.py` |
| Both `send --describe` | Authenticated channel/member evidence exists internally, but no Runtime-authorized describe operation or legacy output parity. | Discord presence, Slack describe tests |
| Both `send --status working/done` | Pending lifecycle presence effects, reactions/typing and cleanup; not an ordinary reply. Runtime terminal Comms updates in #1129 are not venue presence. | Both presence tests |
| Discord `read --agent --place [--after] [--limit]` | Pending authorized platform history (oldest first, limit 1–100, initial latest one, original time/from/person/may_wake/text). `runtime.readConversation` reads a bound local transcript, not platform history. | Discord read tests |
| `compare`, Slack `--check-gone` | Retired: whole-side staging replaces shadow comparisons. No second socket, shadow poller or deletion probe. | Both compare tests |
| Shuttle API `people/routes`, setup | Owner-only `bridges.put/removeVenues/Routes/Links`, generated setup client and Bridges screen merged. Runtime gates remain separate. | Shuttle CLI/gates.py |
| `offer-people/routes`, accept/merge | Retired file-offer protocol; completed-snapshot importer resolves accepted authority and retains offers as evidence. Owner setup changes the new DB. | Shuttle gates/merge tests |
| `propose-person`, allow/deny/then-relay | Runtime/Approvals owning work remains; link setup cannot authorize it. Original proposals are retained, not executed by Bridges. | Shuttle propose tests |
| `relay`, `relay-take --via slack` | Pending attributed Runtime relay, one-time dequeue and bridge DM transport; preserve actor, non-recipient authority, quoting, loop rejection and current workspace identity. | Shuttle relay tests |
| Body API/host | Installed Runtime jobs/runner claim/input/read/reply used for household DMs; broader owning-policy runner and non-DM audience work remain on t-2209. | Shuttle bodies tests |
| `routes --json`, gates export/moved | Offline importer + Runtime gates, not live compatibility commands. Old tombstones forbid inappropriate fallback during import. | Shuttle CLI |
| `cards-backfill` | People-owned work. Importer maps existing household members or retains evidence; creates no authority or member. | Shuttle cards tests |
| `ui` and agent Bridges tab | Kit screen, setup forms, live counts/routes, staged-send release and confirmed terminal dismissal merged; 30-PNG CI proof at six theme/width combinations. | Shuttle loomui/adapter_health tests |
| Poll/lookback/thread scans/fairness | Poll machinery retired for sockets. Discord durable Resume, Slack receipt-before-ACK, per-agent dedup and bounded normalization retries implemented. | Both adapter tests |
| Retry/held/reconnect/sent logs | Durable queues, one-hour transient intake expiry, restart-only runtime-hold repair, uncertain sends never replayed; metadata-only Attention integration still pending. | Both deliver_contract, shuttle core tests |
| Upgrade loops/locks/ext hooks | New daemon and external runners replace process machinery. Arbitrary Python hooks retired; instance-specific briefs/restrictions must be accounted for by Runtime, not silently dropped. | Shuttle upgrade/instance tests |

## Remaining behavior matrix, in delivery order

`src/pieces/bridges/runtime-matrix.test.ts` exercises the first four forms through
real raw receipts, platform metadata, normalizers, engine, Secrets service and
installed Runtime. It observes Runtime admission by delegating to the unchanged
implementation; there is no permissive runtime override. The runnable household
DM control proves missing runner setup cannot conceal an admission regression.

| Behavior | Actual current behavior | Remaining owner / proof |
| --- | --- | --- |
| Peer | Known remote bot without a person link is discarded as unknown user before Runtime. A synthetic explicit peer link reaches Runtime and waits. Neither case is peer delivery. | Runtime needs authenticated agent identity distinct from person/member, turn budget/reset and no peer stop; Bridges must resolve that identity without impersonation. Import does not fabricate peer links. |
| Pair | A human on a paired Discord route reaches actual Runtime and waits. Webhook peer identity is unsupported by current `addressed`. | Runtime shared/pair admission + Bridges authenticated pair transport; webhook evidence disposition still required. |
| Channel/thread | Fresh Discord guild/type/parent checks and primary/mention routing run, then Runtime waits. Thread labels use parent name, never thread title. | Runtime audience/readers, original sender, continuity and source-bound read/reply/stop. No DM fallback. |
| Group | Slack authenticated MPIM kind, complete members and every-human checks run before Runtime waits. No body/turn/outbox is created. | Runtime shared audience and all-human policy; existing engine must keep fresh checks on every reply chunk. |
| Read | Bound body DM transcript works. Internal Discord history transport requires an exact-place current permit, fresh guild/channel evidence, bounded oldest-first history and original sender/time/text. No installed permit issuer, sender/may_wake resolution or public command yet. | Runtime must issue authenticated exact agent/workspace/channel permits and resolve sender/may_wake; then wire the public read operation and command parity. Test permit is explicit; transport fixtures do not complete this row. |
| Describe | Internal authenticated place/member evidence works; no public describe contract. | Runtime derives tiers/restrictions/briefs/guest floors; People labels never authorize. |
| Presence | No platform working/done/typing/reaction lifecycle implemented. | Runtime lifecycle role + Bridges staged effects and restart cleanup. |
| First proactive DM | Reply-only engine requires prior delivered intake; no `conversations.open` path. | Runtime recipient authorization/attribution + Bridges open/post with durable uncertain-send semantics. |
| Files | Intake includes textual file descriptions only. | Secure scoped fetch/retrieval: max five, bounded bytes, Slack HTTPS files origin, no redirects/HTML/traversal, agent/place/delivery/body scope, 14-day retention. Runtime owns access, Bridges owns platform fetch. |
| Attributed relay | No new-side bridge relay operation/dequeue. | Runtime actor/recipient/current authority + bridge DM transport; no forged person's inbound message. |

Unsupported receives that reach Runtime remain pending with their original receipt
and retry budget; the fixture proves retries repeat the owning `wait` and create
no jobs or turns. This is a fence regression test, not positive support. Expiry
still applies after more than one hour. Neither these tests nor the existing
injected engine tests close a pending matrix row. t-2209 has the concrete role
requirements; #1128's house destination and #1129's terminal Comms updates do not
supply the missing venue contracts. Existing imported/configured owner policy
continues to hold execution until the owning runner enforces it.

## Implemented platform and authority evidence

- `discord.test.ts` / `slack.test.ts`: explicit resolved summons, reply pings,
  managed roles, readable markup, whole-name labels, original event time and
  textual attachments. `routing.ts` keeps mention/primary and parent filters.
- `discord-gateway/inbox/drain/daemon.test.ts` and Slack equivalents: authenticated
  identity/lifetime, durable commit before Resume/ACK, bounded pages/backoff,
  startup/release recovery and awaited shutdown. No first-connect history replay.
- `slack-api.test.ts`: same-workspace human eligibility, paginated full members,
  fresh MPIM checks; `adapters.test.ts`: current service grants and every chunk's
  authorization, exact bound receipts and mention suppression.
- `outbound.test.ts` / `bridges.test.ts`: lossless Unicode splitting at Discord
  2000 / Slack 3900 UTF16 units, partial failure uncertain, no automatic resend,
  stable IDs, edit-and-restore invalidation, stop seam and queue expiry/repair.
- `runtime/bridges.test.ts`: actual household DM runner claim/input, scoped body
  read/reply/stop, atomic transcript/outbox, relink/box/house/shutdown/policy fences.
- `credentials.test.ts`, `composition.test.ts`, and Secrets tests: actual
  persistent-holder generation/private mTLS evidence from #1091/#1096, current
  service grants/expiry, lifetime invalidation and no value in loom.db. Engine
  no longer receives tokens; there is no production `BridgeSecrets.may/get` seam.

Household DM end-to-end proof uses actual Runtime/People/Secrets roles with fake
platform and holder IO. Separate persistent-holder fixtures cover the real private
holder transport. This does not claim a live workspace or external runner test.

## Shuttle responsibilities outside platform IO

These test families prevent a large bridge rewrite from accidentally reintroducing
shuttle's body coordinator inside the platform adapter. This is an ownership index;
it does not assert that another house has completed its replacement.

| Legacy test family | New owner / boundary |
| --- | --- |
| `test_core`, `test_dispatch`, `test_spawn`, `test_reap`, `test_runner`, `test_codex_runner`, `test_runner_parity`, `test_bodies` | Runtime scheduling, ordering, capacity, retry/park, unknown-versus-gone, isolated launch/claim/report and external runners. Bridges cannot start a body or decide runner identity. |
| `test_inbox_hook`, `test_boards`, `test_deeds` | Runtime bound-body follow-ups/read receipts and activity/status. No bridge-local transcript or harness hook installation. |
| `test_gates`, `test_runtime_gates`, `test_selvedge`, `test_merge`, `test_propose`, `test_cards` | Runtime owner-written authority, central policy/Approvals, People identity and offline import. Bridge links do not import grants, tiers or restrictions. |
| `test_relay` | Runtime authenticated relay, bridge-owned platform DM transport; no impersonation of the recipient. |
| `test_reach` | Bridge-observed account label/id for a known person, emitted once daily or when changed; People owns the card update. No stranger observation, name-based identity or authority change. Integration pending. |
| `test_loomui`, `test_adapter_health` | Bridges preview health/counts/routes and pending effects; runtime owns bodies/house rules, central Attention owns alerts. Names link by exact slug, not by guessed name. |
| `test_discord_adapter`, `test_slack_adapter`, `test_shadowlog` | Platform routing/formatting/files and attribution retained; spawn/brief/scope move to runtime. Shadow route logging retired with compare. |
| `test_instance`, `test_config`, `test_upgrade`, `test_no_instance` | Database configuration/import and daemon/external-runner lifecycle replace instance discovery, process locks and self-upgrade. No legacy loader on the next path. |
| `test_cidsplit`, `test_similarity` | Legacy board-ID repair belongs to old-data maintenance, not the next connection path; runtime owns new conversation identity. The source similarity utility is development tooling, not a production bridge operation. |

## Import and completion evidence

The completed-snapshot importer is merged in #1118/#1133, registered for plan,
all, standalone Bridges and both independent source-derived verification paths.
One owning transaction checks IDs/counts/content, checksum/no-op/different-source
refusal and rollback. Source files/stores are confined by snapshotPath; no daemon
reads old data. [The piece page](bridges-piece.md#completed-snapshot-importer)
gives the exact household mapping procedure. Every venue is disabled; bundle-only
Slack becomes explicit incomplete evidence with no invented bot or split names.
Off-machine bots, unknown audiences, exact stored docs/revisions and proposals
stay private evidence. Unprojectable channel/parent IDs also block default routing.

Webhook-peer, notify, peer budgets and channel-note references are retained evidence
pending explicit dispositions in this inventory; not active configuration. Obsolete
raw identity/session disposition also remains required. Retained command output/exit
fixtures and final move inventory are not complete. No owner decision, deployment,
real import or workspace contact is implied by the code or this inventory.

Before closing t-2210, replace every pending matrix/command row with merged positive
proof or a named justified retirement, reconcile Runtime/People/Secrets/Attention/
Approvals roles, retain generated command output/exit fixtures, and finish the move
docs. Existing screen and CI evidence do not substitute for these behaviors.
