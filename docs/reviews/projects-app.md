# Projects app review

Optional author-selected cold review, high: private projections and cross-role
interfaces. No central permission rule, sign-in/session/credential handler,
content migration or host rollout changed. Maximum three rounds.

## Round 1 — BLOCKING

TREE sha256:638edd4629606a5546bcb537e9db5cf96b57deecb30710cd55621da62cf3d6bf.

- Activity source restriction: rejected. `docs/specs/projects.md` explicitly says:
  “the latest of the card's updated, its newest matching memory and its newest
  note.” Keeping task/Changes/conversation dates in Lately and the seven-day line,
  while sorting card activity by its defined sources, preserves that contract.
  Added a discriminating aggregate test with a newer conversation than the note.
- Incomplete positive waiting count: actionable. Both cards and hubs now retain
  the incomplete warning alongside known items; UI fixture includes both.
- Ages absent: actionable. Rows, Lately and card activity render relative ages
  from the projection clock; UI checks 2h ago. Day bucket deadlines also refresh
  derived records without polling.
- Avatars/faces: actionable. Existing avatar and pure drawn-face components,
  with authorized agent inventory, render card people and People rows. UI tests
  assert the face and avatar output; hosted shots provide visual evidence.
- Memory destination: actionable. Added a scoped full memory reader inside
  Projects, `project.memory` / `mind.projectMemoryRead`, separately gated by
  central memory+agent policy, active/unexpired only. Direct reads/navigation
  and denial/expiry get tests. No legacy routes or IO.
- Changes role untested: actionable. Tests exercise actual role/registry caller,
  alias/repo selection, waiting/destinations, and aggregate open/failing/checking.
- Aggregation untested: actionable. Tests exercise newest-three, waiting exclusion,
  people dedup and seven-day counts including waiting.
- Tasks ready/done test gap: actionable. Added actual blockers, recent/old closes
  and nested descendants with assertions of each returned group.
- Notes default-prefix test gap: actionable for our query; now computed on
  `ProjectQuery.notePrefixes` and tested. Dedup/initial expiry belong to the
  absent Notes owner, not a Projects store adapter. Carrier:
  `docs/projects-piece.md` explicitly assigns Notes newest20/total/prefix/expiry
  duties and coordinator role wiring. The fake proves the synchronous contract;
  no production Notes implementation is claimed.
- Exact memory union: actionable. Assert exact ref set, not only count/endpoints.
- Duplicate aggregation: actionable. Normalize groups and items, aggregate once.

Author additions during the round: malformed section validation, 50-item Tasks
cap, precise ISO expiry comparisons, and isolated hosted-runner guard coverage.
The before screenshot build exposed a duplicate import already present in the
frozen base. The evidence workflow removes only that duplicate in its disposable
before checkout, so it can compile; head production code removes the duplicate.
No unchanged failed job was blindly rerun.
