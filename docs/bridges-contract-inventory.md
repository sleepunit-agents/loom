# Bridge replacement inventory

This is a coverage inventory for t-2210, not a claim that the adapters are ready.
Read it with [the piece overview](bridges-piece.md) and the settled
[new-side move](specs/web-foundation.md#moving-there). Runtime owns authority,
conversation words, turns and bodies; bridges owns platform IO. An entry marked
pending is required work, not an implemented operation or an agreed deletion.

The source checkouts inspected for this inventory are pinned here so later changes
in the separate repositories cannot silently change the comparison:

- [loom-discord at 5d197bac](https://github.com/sleepunit-agents/loom-discord/tree/5d197bacbe80e82b5546656db538cee43c09c835)
- [loom-slack at 4acf0562](https://github.com/sleepunit-agents/loom-slack/tree/4acf056239ae1c431d645068a3be8e71f2623837)
- [shuttle at c4a188b6](https://github.com/sleepunit-agents/shuttle/tree/c4a188b6e3e362ff34903e0ad79b25c1bca77c62)

Paths in the source column are relative to these repositories. Current coverage
below describes loom main through #907. Pure normalizers and injected fake adapters
do not establish production platform coverage.

## Commands, API routes and jobs

| Old entry point | Replacement / state | Source |
| --- | --- | --- |
| `loom discord run`, `loom slack run`; shuttle `adapters/{discord,slack}.py` | Daemon-owned bridges connections. Injected `Bridges.sync/close` exists; production jobs, sockets, shutdown and setup-change wiring pending. No subprocess or systemd adapter. | Both `bin/loom-*`; shuttle adapters |
| `loom discord status`, `loom slack status` | Connection, retry and held-send metadata for generated CLI and preview; pending. Legacy shadow-line count is retired with shadow mode. | Both command dispatchers and `status` |
| Both `send --agent --place` with stdin text | Runtime-authorized reply queues `Bridges.reply`; injected outbox/staging exists. Real posting, first outbound sends, generated client and legacy output/exit fixture parity pending. | Both `test/test_send.py` |
| Slack `send --place dm:U…` without previous intake | `conversations.open` then post as that agent's bot; pending. Cannot depend on an existing inbox/reply binding. Runtime resolves person-to-platform identity. | Slack `test/test_presence.py`, `test_a_message_to_one_person_is_one_dm` |
| Both `send --describe` | Platform place/member metadata to runtime, which applies tiers, restrictions, cards, guest floors and named briefs. Pending authenticated role; route fields alone are not complete describe behavior. | Discord `test/test_presence.py`; Slack `test/test_describe.py` |
| Both `send --status working --message …`, `--status done` | Runtime lifecycle notifications; staged eyes/reaction cleanup and Discord typing effects pending. Not ordinary outgoing replies. | Both `test/test_presence.py` |
| Discord `read --agent --place [--after] [--limit]` | Authorized platform read, oldest first, limit 1–100; initial read latest one. Include ignored channels, validate place/agent, and return original time/from/person/may_wake/text. Pending; runtime owns may_wake. | Discord `test/test_read.py` |
| Both `compare --start --adapter --bridge`; Slack `--check-gone` | Retired: whole-side staging replaces live/shadow comparison. No second Slack socket, shadow history poller or deletion probe. | Both `test/test_compare.py`; Slack `gone_checker/still_there` |
| Shuttle `api` at `POST /api/shuttle/run`, `people`, `routes` | New registry roles; setup collections `bridges.venue/route/link` exist, with `bridges.putVenues/putRoutes/putLinks` and corresponding remove operations. Runtime gates are separate. Generated client pending. | Shuttle `tools/loom-shuttle`, `shuttle/gates.py` |
| Shuttle `offer-people`, `offer-routes`, page accept/merge actions | Old file-offer protocol retired by offline import and direct owner setup on the new side. Collision checks and explicit ownership must survive import. No new-side fallback to old files. | Shuttle `tests/test_gates.py`, `tests/test_merge.py` |
| Shuttle `propose-person`, allow/deny, optional then-relay | Pending runtime/Approvals-owned proposal composition. A proposal cannot grant itself authority or alter owner authority; bridge links are not gates. No equivalent exists in current bridge operations. | Shuttle `tests/test_propose.py` |
| Shuttle `relay`, `relay-take --via slack` | Pending authenticated runtime relay and bridge transport integration. Preserve original actor, explicit non-recipient authority, quoted payload, one-time dequeue, loop rejection, and current person/workspace identity. Never synthesize a person's message from relay text. | Shuttle `tests/test_relay.py` |
| Shuttle `api bodies …`, `body-host` | Runtime/runner responsibility: requests, claims, reports, follow-ups, stop, turn-over and unknown/stale reports. Not a bridges launcher or permission source. Integration pending. | Shuttle `shuttle/bodies.py`, `tests/test_bodies.py` |
| Shuttle `routes --agent --json`, `gates export/moved` | Offline importer and runtime gates, not live compatibility commands. Old tombstones/export are transition machinery; new side reads only its own DB. | Shuttle `tools/loom-shuttle` |
| Shuttle `cards-backfill --dry-run/--bodies` | People-owned identity/card work; importer links existing slugs and refuses ambiguity. Do not create authority from cards or run a legacy backfill from next mode. Full coordinated importer coverage pending. | Shuttle `tests/test_cards.py` |
| Shuttle `ui`, `ui page`, `ui act` and agent Bridges tab | Kit preview at `/p/bridges-preview`, registry/live data only; pending. Bridge status/routes/counts/staging disposition live here; gates/house rules belong to runtime and owner approvals. | Shuttle `tests/test_loomui.py`, `tests/test_adapter_health.py` |
| Poll cursors, lookback/thread scans, fairness, first-sight reads | Poll machinery retired for sockets; preserve no historical replay on first connection, original thread addresses and per-agent dedup. Durable Discord session/sequence resume and Slack receipt-before-ACK still pending. | Both `test/test_adapter.py` |
| Retry/held queues, reconnect and sent logs | Injected durable inbox/outbox and reconnect backoff exist. Real gateway persistence, metadata-only Attention reporting and platform error mapping pending. | Both `test/test_deliver_contract.py`; shuttle `tests/test_core.py` |
| Shuttle upgrade loops, file locks, ext hooks and runner-specific setup | New daemon/runtime and external runners replace the process machinery. Arbitrary Python hooks are not loaded by next mode. Instance-specific brief/scope behavior must be accounted for by runtime policy, not silently discarded as a bridge feature. | Shuttle `tests/test_upgrade.py`, `tests/test_instance.py`, adapter tests |

## Platform and delivery cases

| Contract cases | Existing evidence | Remaining production proof |
| --- | --- | --- |
| Discord explicit+resolved user/managed-role summons; reply ping is not summons; mention beats primary; other-agent-only mention suppresses primary | `discord.test.ts`, `routing.ts` | Real channel/bot/managed-role metadata and gateway calls use these normalizers. |
| Discord own/system messages, ignore/only, thread parent and safe label, guest/readers, bot peer and paired webhook | Intake/routing tests cover own/system/filter/parent/labels and known bot peer selection | Paired webhook identity is not implemented by `addressed`; runtime guest/reader/peer admission, cap and stop suppression still need composition and cases. |
| Slack human message/file_share only; workspace-bound DM/MPIM; thread under human or bot remains same conversation | `slack.test.ts` normalizer and engine key tests | Real Socket Mode/Web API metadata, sender identity and durable ACK. Never infer workspace trust from a display name. |
| Slack `users.info`: same team, not stranger/guest/restricted/bot/deleted; API failure waits | Injected inspection only | Actual users.info and fresh conversations.info/members, including pagination/full member set and receiving bot. No intake cache before a group post. |
| Slack every group human linked distinctly and runtime admitted, sender included, at least two humans; receiving bot owns routing | `bridges.test.ts` checked-member tests, including non-D IDs and old queued work | Real platform checks and authenticated runtime admission. Temporary failures wait; denial erases intake or holds outgoing reply. |
| Setup edits during asynchronous inspection/admission, even edit-and-restore | Engine revision/freshness matrices for intake/reply and link/route/venue | Preserve these guards when replacing fake roles; revalidate before every outside effect. |
| Readable mentions/links before one escape decode; literal encoded mention stays literal; human-only whole-name labels | Slack pure helper tests; Discord safe parent label tests | Real People name lookup without copying tiers or restrictions into labels or links. |
| Original event time in UTC milliseconds, truncate never round; invalid explicit time holds | `time.ts` and engine tests | Runtime `Deliver` field/source mapping and all legacy malformed-field fixtures, not only timestamps. |
| Runtime delivery: taken/final refusal/transient/held | Injected typed delivery outcomes, stable retry ID and erasure tests | Map authenticated registry Result, not legacy HTTP status alone. Old HTTP 400/415 hold, 403/409/413 consume, 401/429/network/5xx retry explain the semantics; unknown results hold. |
| Safe long replies, thread address, no replay after uncertain partial post | Engine holds thrown or interrupted attempts; thread address preserved | Real split/post limits (Discord 2000, legacy Slack under 3900), full-text preservation and partial-success failure tests. Entire uncertain attempt stays held. |
| First outbound Slack DM; permanent versus temporary post refusals | Legacy send/presence fixtures only | Real conversations.open/post and structured errors; current reply-only engine is insufficient for proactive sends. Never downgrade an uncertain attempt to safe retry. |
| Admitted stop/cancel; idle ordinary message; peer suppression until person speaks | Injected engine stop seam only | Runtime active-body/peer state, authorization, acknowledged stop, and staged acknowledgment. Existing seam does not prove all legacy stop cases. |
| Eyes once, cleanup after reply/done/stale status, Discord typing while working | Legacy presence fixtures only | Runtime lifecycle plus staged platform effects and restart cleanup; no bypass through status effects. |
| Slack files only after admission, max five, bounded bytes, files.slack.com HTTPS only, no redirects/HTML/traversal, agent+place+delivery/body scope, 14-day retention | Pure intake file descriptions only | Secure fetch, scoped runtime handoff/retrieval and retention cases. Shuttle's older 30-day local-path behavior is superseded by the later adapter's 14-day scoped contract. |
| Grant checked before any credential access; no argv/log/feed/result/error token exposure | Foundation injected fake secret seam only | Bridges SERVICE and real `secrets.withValue(name,use)` per merged foundation ruling. Foundation `BridgeSecrets.get` is not production authority or a credential API to export. |

### Delivery differences to keep explicit

Legacy `test/test_deliver_contract.py` on both platforms checks the body fields,
UTF-16 limits, printable labels, from-person versus unknown attribution, UTC time,
and metadata-only alerts, not just HTTP success. Slack's real six-fraction timestamp
`1793828004.242749` becomes `2026-11-04T21:33:24.242Z`. Its group `from` is the
actual sender, never a different admitted member or the owner.

The new runtime role uses venue `slack`/`discord` and a separate place. Foundation
`ConversationKey.venue` is a composite internal key; it must not be copied into
`Deliver.venue`. Runtime composition still has to reconcile Slack DM/group and
Discord channel/thread places, stable IDs and authenticated Caller/Viewer roles.

Legacy malformed intake remains held without TTL and retries after adapter restart.
Current new-side `held` receipts remain held across restart, with no repair command
yet. Record that gap when building disposition/repair; restart is not evidence that
the new engine recovers it. Uncertain outgoing attempts are a separate case: human
disposition must never automatically resend them. Legacy one-hour transient intake
expiry likewise is not implemented by the current durable retry loop; choose and
document its treatment before claiming full retry parity.

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

## Import and completion evidence still required

`loom migrate bridges --home <new> --from <old>` remains unimplemented. Read JSON
people/routes/shuttle/settings references only; never token/env files, legacy
programs or executable hooks. `SLACK_BOTS` names an env-bundle secret containing
BOT_TOKEN/APP_TOKEN/TEAM_ID/BOT_USER_ID fields (with their `SLACK_` prefixes); importing
its reference is not permission to read or persist its contents. The existing venue
schema has separate token/app references and workspace/bot IDs, so bundle conversion
needs explicit tested handling rather than fabricated split secret names.

Require one transaction, source checksum, repeat no-op, different-source refusal,
interruption rollback and exact ids/counts/content comparison on synthetic old data.
Ambiguous claims refuse; a person winning over an agent in an old lookup is not an
import rule. Runtime gates and People records remain their owning pieces' work.

Before closing t-2210, reconcile every pending row with merged implementation and
fake gateway/API tests; register real lifecycle/roles only on the new side; complete
generated CLI output/exit fixtures, preview and fixture registration, CI screenshots
at 390/1280/1920 in both themes, and docs choices/final move steps. Host rollout and
real imports belong to the final coordinator move, not this inventory or this house.
