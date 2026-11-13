# Activity app cold review

Implementer-chosen, high: readonly data, private content projection, role/live contracts,
source refresh/expiry concurrency and hosted evidence; discriminating tests cover the
mechanism. No permission rule, credential/session/sign-in handler, schema migration or
spec changes. Maximum three frozen rounds, no fourth. Claim: authorized Activity stories
remain readable and current without losing navigation or exposing private Comms.

## Round 1 — BLOCKING

TREE sha256:77bc44251e96e008ace82dbb6e0e8cd697ab2f7c24d8c43301c3729f50988dd8.

- CRITICAL independent content access: actionable. Conversation-only services now use
  conversation type access, episode sources use memory type access independently.
  Tests discriminate both service kinds and direct readers.
- CRITICAL normalized episode conversation ids: actionable. Dedup now uses plainEpisode's
  normalized conversationId, including ids from title/content, not metadata alone.
  Test supplies a preamble without metadata, hours before the covering digest.
- CRITICAL open conversation reader expiry: actionable. NEW run role carries expires;
  reader schedules it and withdraws at the exact fake-clock deadline. Window aggregate
  expiry remains supported. Test opens the reader over a socket then expires it.
- CRITICAL reader errors mistaken for missing: actionable. Explicit generic error and
  unavailable records are distinct from undefined/not-found; UI and operation tests cover it.
- CRITICAL broken source blocks healthy sources: actionable. Per-source connection errors
  and schema/read failures become generic source errors; healthy stores remain visible.
  Corrupt SQLite fixture and missing-source reader tests cover both outcomes.
- MAJOR shown-day/hour checks: actionable. UI checks day-specific zero counts and address
  changes; the one hosted browser test changes day, activates the hour and checks focused row.
- MAJOR original viewer role assertions: actionable. All three role methods are spied and
  must receive the exact original viewer object.
- MAJOR midnight rollover: actionable. Socket test advances through local midnight and
  checks recent days, access today and withdrawal of a thirty-day reader.
- NIT duplicate backend/web DTO vocabulary: valid trade-off. Small consumer-owned readonly
  transport types follow the existing reading-app pattern, keeping web independent of a
  server implementation import. Discriminating UI/source tests and build check compatibility.

Raw reports and hosted evidence are retained in loom/2026-11-13-activity-app-evidence.
