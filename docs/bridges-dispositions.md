# Bridges: legacy behavior and move dispositions

This is the remaining-source disposition ledger for t-2210, audited at main
`52ef22daaeb005a551e6a888d754b1da3242348d`. Read it with the
[behavior matrix](bridges-contract-inventory.md#remaining-behavior-matrix-in-delivery-order)
and the [completed-snapshot importer](bridges-piece.md#completed-snapshot-importer).
It closes the documentation gap about what must happen to these inputs; it does
not complete their implementation or authorize the move. **Required** below
means a blocker to full Bridges completion, even when an importer retains it.

Sources are pinned, not read from an installed home:

- **D**: [loom-discord `5d197bac`](https://github.com/sleepunit-agents/loom-discord/tree/5d197bacbe80e82b5546656db538cee43c09c835).
- **S**: [shuttle `c4a188b6`](https://github.com/sleepunit-agents/shuttle/tree/c4a188b6e3e362ff34903e0ad79b25c1bca77c62).
- **L**: [loom-slack `4acf0562`](https://github.com/sleepunit-agents/loom-slack/tree/4acf056239ae1c431d645068a3be8e71f2623837).

## Required semantic replacements

| Input and legacy evidence | Disposition and owning work | Completion evidence still required |
| --- | --- | --- |
| `webhook_peers` and channel `peer`/`pair`: D `lib/loomdiscord/routing.py`, `test/test_routing.py::test_webhooks_route_only_as_a_listed_peer`; S `adapters/discord.py::webhook_peers`, `tests/test_discord_adapter.py::test_channel_notes_peers_and_pair` | **Required, not retired.** Bridges must preserve authenticated webhook identity separately from a human/person link. Runtime owns peer/pair admission and attributed turns (t-2209); Bridges owns routing and platform evidence (t-2210). A webhook display name is not a human or agent credential. | Positive actual-Runtime fixtures for listed webhook + matching author ID, explicit mention in a peer venue, and the configured primary's paired webhook without a mention; refuse unlisted/mismatched hooks and ordinary venues. Preserve peer attribution and human-only stop authority. Existing wait/drop fixtures do not satisfy this row. |
| `notify`, Discord guest brief's `notify_chan`, Slack `flag_to` with explicit `chan` or dotted `chan_from_routes`: S `adapters/discord.py::render_brief/startup_check`, `adapters/slack.py::_routes_value/startup_check`, both adapter test families | **Required escalation behavior, not retired.** Runtime owns guest/field brief and restrictions; Attention/Approvals own the owner question/decision; Bridges owns any authorized platform notification. Replacing a script path with an Inbox card is allowed only when the owning flow carries the original escalation and its outcome. No arbitrary command or file path becomes executable next-side setup. | Actual owning-flow fixtures for guest and tier-two escalation, correct owner audience, selected destination/brief, unavailable destination and refusal. If a venue notification is replaced by an Inbox-only flow, document the exact equivalence and retained caller behavior before closing this row. Imported metadata alone supplies neither notification nor approval. |
| `peer_turns_each`, persisted `peer_turns`, `peer_stopped`, reset/one-time budget notice: S `adapters/discord.py::leftover_blocked/count_spawn/main`; D `lib/loomdiscord/adapter.py::stopped`, `test/test_presence.py::test_in_a_peer_venue_a_stop_holds_peer_turns_until_a_person_speaks` | **Required policy disposition, not silently dropped.** Runtime owns turn spending, human renewal, stop and restart continuity; Bridges must deliver authenticated peer/human facts. S's positive configured budget is optional: its main loop treats null/zero as disabled, explicitly recording the owner's disabled-budget ruling. Do not impose a positive default. D retains the human stop brake but does not implement S's budget counter. | Positive installed peer fixtures for configured exhaustion, retry/restart without replenishment, renewal by any allowed human message in the venue even when it does not route to this agent (including a non-routing-message fixture that rearms the notice), one notice per exhaustion cycle with duplicate suppression across retry/restart and rearming after renewal, and human stop followed by peer hold until a person's non-stop message. Prove disabled-budget behavior separately; the stop brake still applies. Offline source fidelity: the Bridges inventory accepts canonical nonnegative integer budgets, preserves literal zero as `peerTurnsEach: 0` in file inventory, and retains exact accepted store documents in private evidence. Null/absent stays absent in the projected inventory. Synthetic file and store snapshots cover all-import and both independent verifiers, including refusal of evidence that normalizes zero to null. This does not implement Runtime budget policy; the positive installed fixtures above remain required. |
| `channel_notes`, named route keys, parent inheritance and referenced brief content: S `adapters/discord.py::render_brief/startup_check`, `tests/test_discord_adapter.py::test_channel_notes_peers_and_pair`; D `lib/loomdiscord/routing.py::describe/lists`, `test/test_presence.py` | **Required context, not retired.** Bridges owns exact channel/parent note selection; Runtime owns brief composition and enforced restrictions. Preserve source-selected key membership and referenced content through the offline move; never follow an old path at runtime. Current importer makes route `notes: []`; retaining a reference is not installing its content. | A reviewed offline projection for the selected documents, plus actual Runtime channel/thread fixtures showing the right content, parent inheritance, missing-reference refusal and guest-floor/restriction enforcement. Audit arbitrary source note-key shapes, not just a fixed list of key names. No public describe/brief support is claimed today. |

The distinction between S and D is deliberate: a later adapter may no longer
carry every S mechanism. Account for the union of relevant household behavior;
a missing mechanism in one pinned source is not proof of an approved retirement.
The table records who must reconcile it, without granting Bridges Runtime policy.

## State that must not become new authority

| State | Disposition and reason | Existing evidence / remaining proof |
| --- | --- | --- |
| Old Python poll cursors, handled/acked IDs, cached parents, process locks, child PIDs, sent-log reply detection and native-session identifiers | **Retire the old process mechanism at the whole-side move.** New next-side receipts/outbox and Runtime jobs replace it; importing these fields as a fresh live socket checkpoint, job or authentication would invent continuity. Keep the completed source snapshot for reconciliation under the final move plan; this ledger authorizes no deletion. Old Runtime conversation/history import is separately owned and is not retired here. | `import-projection.ts::bridgeImportTables` expects empty next-side raw receipts, Discord sessions, inbox, outbox, conversations and status. `importer.test.ts` compares the projection and refuses a populated adapter destination. Final move must explicitly reconcile unfinished old work with Runtime; an empty new queue does not prove it was delivered or may be resent. |
| Old token/env paths, send/alert/ext commands, private socket URLs and native credentials | **Retire path execution and credential copying through Bridges import.** Explicit secret-name mappings and authenticated service grants replace them. Exact source snapshot/store evidence is not a usable credential or an executable command. | `import-source.ts` reads explicit configuration files only; `import-plan.ts` requires explicit connection mappings and emits disabled venues. Existing importer fixtures refuse incomplete split Slack setup and preserve source integrity. Final service provisioning and move activation are separate owning work. |
| New-side Discord session checkpoints and pending raw words from an obsolete bot/workspace/agent/venue/secret-reference/credential generation | **Required next-side lifecycle cleanup, still pending on Bridges t-2210.** Bridges defines obsolete receiving bindings, implements the bounded cleanup and supplies restart evidence; Runtime t-2209 must supply any live-job/delivery facts needed to preserve outstanding work. This is not the old-state retirement above. `discord-inbox.ts` isolates each physical receiving binding; a replacement gets neither old cursor nor old words. `reset()` removes only the current binding's checkpoint and preserves dedup tombstones. It does not sweep obsolete bindings. | `discord-inbox.test.ts` proves identity/generation isolation and same-binding restart recovery. Add owning bounded cleanup and restart fixtures that distinguish permanently obsolete bindings from recoverable current ones, erase obsolete words/checkpoints without redelivery, and preserve the needed dedup fence. Define that lifecycle before deleting; this ledger supplies no new deletion permission. |
| New-side Slack raw receipts under a replaced receiving identity | **Required next-side lifecycle cleanup, still pending on Bridges t-2210.** Bridges defines obsolete receiving identities, implements the bounded cleanup and supplies restart evidence; Runtime t-2209 must supply any live-job/delivery facts needed to preserve outstanding work. `slack-inbox.ts` binds venue/platform/workspace/agent/bot/app, not a credential epoch. A fresh receiver for the same identity can recover saved work; a replacement cannot read or consume the old identity's words. The active drain's one-hour expiry does not sweep unreachable identities. | `slack-inbox.test.ts` proves same-identity recovery and replacement isolation. Add bounded obsolete-identity cleanup/restart fixtures, preserving current pending work and dedup tombstones. Do not copy Discord's epoch semantics onto Slack or claim that adapter shutdown erases durable words. |

## Move acceptance ledger

Before marking t-2210 complete, replace each **Required** row with merged
implementation/positive fixture references or a separately justified, recorded
retirement. A required row stays open when only private evidence, an internal
fake permit, a negative fixture or an owning-task request exists. The
[main inventory](bridges-contract-inventory.md) remains the full checklist;
this page covers only the dispositions named above.

At the eventual whole-side move, its coordinator must record the source snapshot
and checksum, explicit household/connection mappings, unresolved source rows,
Runtime's disposition of outstanding old work, and the fixture/PR evidence for
all required semantics and obsolete-state cleanup. Keep imported venues disabled
until that reconciliation and the owning service/effect checks are complete.
Neither this page nor an importer success is approval to enable one. No runtime
fallback to old stores, source files, briefs or programs is permitted.
