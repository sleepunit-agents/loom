# Attention Inbox preview review

ASSESS high: data no (no schema/import); security yes (answer controls); contracts no (unchanged backend); concurrency yes (fresh checks/pending writes); environment no (no deploy/CI change); uncaught no (component fakes and CI browser).

CLAIM: the central-record preview records ordinary answers only after fresh daemon confirmation.
WHY: a displayed row cannot establish current openness, and a lost response must not permit concurrent UI answers.

## Round 1 — BLOCKING, folded

Frozen 83ef55b89ba8c87a4051fcfa7c213a9d8aae1e26 in `/home/art/scratch/attention-inbox-review/round-1/tree`; TREE sha256:f0116f9b5b7c711ee7202fe5f2103b938ff81c2321d0ee4f8aa8a3c3bb7db5df. Reply beside tree.

- Standards MAJOR, actionable: removed effect-created reads. Opening a row creates the display confirmation; direct links/invalidated checks offer Check again. The immediate pre-write read remains in its event handler. Component and browser tests exercise opening/check actions.
- Standards MAJOR, actionable: replaced unchecked global/element types, documented dynamic renderer props and the renderer dependency's missing declarations.
- Standards MAJOR, actionable: moved component tests alongside `web/src/pieces/attention/index.tsx`.
- Spec CRITICAL, actionable: shared write lock now lives above keyed readers and remains held until the write result, including navigation while a response is pending. New regression navigates to a second ask during a pending write, confirms it, proves no second write, then releases the first response and proves the controls recover.
- Spec MAJOR, actionable: added separate No/Done/Dismiss submission tests with fresh reads.
- Spec MAJOR, actionable: added alphabetical agent-folder/filtering and resolved-history test.
- Spec MAJOR, actionable: regression asserts the delivery limitation is visible.
- Spec MAJOR, actionable: full-reader regression asserts authored references, recorded answer words, actor, CT time and resolution.

Runtime delivery, optional public words on yes/no, private encrypted replies, Home and production composition remain required on t-2205 and docs/attention-piece.md. This preview explicitly labels answers as recorded and does not claim that they have reached an agent.

## Round 2 — BLOCKING, folded

Frozen c5e4d6c41dae6646f8031345db7fbfc687abbda1 in `/home/art/scratch/attention-inbox-review/round-2/tree`, excluding this ledger from archive and diff; TREE sha256:5b59499f726e627c56d4c7c2e56ffe1027918c5b38ae347794d4bf1d1610b033. Reply beside tree.

- Standards NIT, actionable: bundled lock/busy/setBusy as Guard.
- Spec CRITICAL, actionable: display reads now acquire the same shared guard. Check again cannot replay a pending display read; opening another row during a pending answer starts no new read. Regression covers no extra call and recovery when the original write settles.
- Spec CRITICAL, actionable: an opening confirmation is consumed on the reader's first mount, so history departure/return cannot reuse it. Regression leaves the reader through a controlled path change, remounts it, then completes the old display read and proves no answer controls appear.

39 affected tests across component, backend and architecture pass. The third round is the final permitted review round; no fourth.

## Round 3 — BLOCKING, final bound; folded, no fourth round

Frozen 824ea0c31701d2f461609c09c7d48c1ee338317f (signed merge of main0606623) in `/home/art/scratch/attention-inbox-review/round-3/tree`, excluding this ledger; TREE sha256:f6fd4502621e24b87005a288cdef52211d8c823a804a0314e4c1f537753e878c. Reply beside tree. The main merge conflict was only app registration; both Knowledge and Inbox remain registered.

- Spec CRITICAL, actionable: the already mounted reader now accepts and consumes each new opening confirmation, without creating a request in its effect. Re-clicking the selected row after a live-set invalidation now enables controls when its fresh display read succeeds. Regression covers that exact path.
- Spec MAJOR, actionable: tests now separately invalidate a completed display confirmation after a changed live set and disconnection, and refuse denied/closed display reads. They distinguish display confirmation from the immediate pre-write check.

Final 42 affected tests/3files, root TypeScript, web build and diff-check pass. Review COMPLETE at the three-round bound, final verdict BLOCKING; all actionable findings folded, no known remaining hole, no fourth round. The author chooses to ship on green CI and reports the non-clear final verdict in PR/task. Later final changes implement the two findings and their tests, not a claim that reviewed bytes were already clear.
