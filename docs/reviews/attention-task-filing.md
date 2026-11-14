# Tasks central filing — bounded permission review

ASSESS high: local replacement/redaction of source metadata, no migration or external effect; scoped trusted source permission boundary; cross-piece role contract; transaction/live/receipt retry behavior; no deployment changes; focused real-next tests and hosted CI discriminate the behavior.

CLAIM: source task filing preserves audience and source decisions atomically.
WHY: central Needs-you must include source work without ineffective or unauthorized central answers.

At most three frozen rounds under the 2026-11-12 ruling. The reviewer receives only the artifact and contract. This ledger is excluded from subsequent review artifacts.

## Round 1 — BLOCKING

Frozen signed 28ea6346472a2d58a762c107251d43cb1de8a47b. TREE sha256:59857db7aa26c7fc6e9ef75dc84cf68c975b4a72ff9b3da05bd6975ad9d72670 (1981 files), scratch task-filing-review/round-1/tree. Reply beside tree.

- CRITICAL, valid/actionable: withdrawn task projections retained old audiences on subsequent source moves. Complete snapshots now include inactive tasks; retained withdrawn projections update to the exact current source audience. A closed-then-moved next-mode regression proves prior project member denial in get/live.
- CRITICAL, valid/actionable: public Attention validation narrowed valid legacy Task ids, empty labels and unrestricted scope strings. Task-only parsing preserves the Tasks domain, hashes only the central identity and uses a fixed label for empty titles. Import regressions cover empty ids/titles/scopes and 201-character scope strings, alongside the existing long-id case.
- CRITICAL, valid/actionable: public raises with another source label could occupy future task filing ids. Reserve the task: namespace for all public raises; regression tries conversation/piece/approval/task before owner assignment then proves normal source filing.
- MAJOR, valid/actionable: missing in-progress counterpart. A real-next Tasks claim by a household owner proves the source remains open centrally while Tasks is in_progress.

All four findings folded with tests. No rejection or waived hole. Round two reviews the new frozen artifact.

## Round 2 — BLOCKING

Frozen signed 386c0fe0fe659af2e7bb1cc6de3e8e214c4a5e1a. TREE sha256:eae74cd2cef612d40ff9d602ea1abcd6240a72954d2baff457349fa7dfd9ea70 (1981 files), scratch task-filing-review/round-2/tree. Ledger excluded from tree and patch.

- NIT, valid/actionable: duplicate withdrawal constructors. Folded into one constructor used for current inactive sources and deleted sources.
- CRITICAL, valid/actionable: imported dot/tilde task ids did not navigate to their exact owning task. Attention now uses Tasks' canonical route codec. Source URL round-trip fixtures include dot/dot-dot/tilde/slash/colon ids; existing Task component fixtures cover actual reader selection.
- CRITICAL, valid/actionable: URI-encoding every source id narrowed Tasks' arbitrary-string import domain and could abort writes/startup for lone surrogates. Removed backend URI encoding; source navigation handles empty/malformed legacy ids through a lossless owning-route code-unit marker. Normal existing canonical task URL spelling stays unchanged. Empty/malformed Task reader, navigation, aged-out lookup and import cases cover this. Author also found UTF-8 hash replacement would alias distinct lone surrogates: source keys now hash UTF-16LE code units; three distinct source ids remain distinct.
- MAJOR, valid/actionable: source-collision guard lacked a discriminator. A trusted next-mode fixture operation seeds an existing unrelated record, then asserts source preservation and enclosing Tasks rollback on conflict. No production authority change for this test.

All findings folded. Three round-one defect regressions were separately run against the original first revision and all failed there; in-progress positive case already passed. Final third round reviews the new frozen artifact; no fourth round.

## Round 3 — BLOCKING; bound reached

Frozen signed 5cc459501ff4ad705ec767b438a2ff41abcc52c0. TREE sha256:7a0a83abee9848a4b36dee01fcc1f654cb96fd7d6610e5e1a5ab15bb34a989d9 (1982 files), scratch task-filing-review/round-3/tree. Ledger excluded from tree and patch.

- CRITICAL, contract misread/out of scope: prompt's unqualified “import” conflated the changed `tasks.import` registry operation with the unchanged stopped offline importers. The source-owning Tasks importer and coordinator projection still verify Tasks rows only (`src/cli/migration-projection.ts` case tasks); `src/pieces/attention/importer.ts` explicitly requires an empty Attention destination for the separately checked conversation import. Injecting source-derived task asks into that stopped batch would change both existing importer contracts. The registry write remains atomic. The stopped batch has no running readers and is followed by startup reconciliation before serving. Carrier: docs/attention-piece.md now explicitly distinguishes both lifecycles and requires the final t-2205 migration/count audit to verify source asks after startup. Added an actual copied-source offline import/repeat/next-startup fixture proving that lifecycle, without changing either existing importer. This is not a claim that offline import itself creates projections.
- MAJOR, valid/actionable: no actual Tasks-service authorization failure proof. Added real next-mode startup and owner-membership reconciliation denials, checking unchanged projections, exactly code-only warnings, and continued successful owner-authorized Tasks writes with synchronous filing. The original unauthorized-caller test was insufficient. Test-only fold after the third frozen artifact; implementation unchanged.

Review stops at the three-round bound, final BLOCKING tags explicitly reported. No fourth round. All implementation findings from rounds 1–2 were folded; the round-three failure-path test is folded and the offline lifecycle contract clarified with a carrier and real fixture. Implementer judgment: no known implementation hole; ship after final-head CI/browser/evidence. The non-clear verdict is not hidden or called CLEAR.

GitHub subsequently reported CONFLICTING with main9dc5868d01011808cb145064b91b5eaf5e9e0d35. The signed merge resolves CHANGELOG only, preserving both entries and moving this unit's entry beside prior Inbox work. Incoming Secrets, Clock, Bridges, Runtime and push work is retained; own implementation remains the third frozen artifact. Integration validation and hosted evidence are reported in the PR.

## Author correction after the review bound — no-op receipts

Broader CI43545109168 on the earlier386c0fe failed two unchanged invariants: core/signin/browser-link freshness hops and secrets/retry-rotation v1 restart preservation. Both were reproduced locally on merged400a752: two failures, not treated as unrelated and no rerun/waiver. Cause: startup and core.access always wrote a fresh tasks.reconcileAttention receipt even when the source projection was unchanged.

A direct-only Tasks-service read now compares the projection through the same source projector before calling the write operation. No-op startup/sign-in refresh has no receipt, no mutation and no Attention publication; real drift still uses the existing authorized transactional writer. Actual service denial still holds/reports its code. Both existing test files stay unchanged; a new projection/receipt/publication regression plus both read/write door-policy checks cover the correction. This is an author implementation change after the three frozen rounds, explicitly not independently reviewed; no fourth review under the standing bound. Final exact-head tests/CI are required again.
