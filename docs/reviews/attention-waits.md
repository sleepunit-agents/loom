# Attention wait checks

ASSESS high: data no (no schema/delete/outside effect), security yes (original-viewer dependency and nested-operation visibility), contract yes (new operation), concurrency yes (receipts/outer rollback/first answer), environment no (no deploy), mechanism covered by affected fixtures and CI. CLAIM: reconcile visible terminal wait facts through owning read roles and existing central resolution. WHY: clear stale asks without impersonation or invented human answers.

## Round 1 — BLOCKING

Frozen implementation accc4ef7d4e3db4e1a429833985236f8fe78d3b2. TREE sha256:b4abcb9c9243005cdd4c5d0281943d99ac5ea3ea4cab12a8201ac33c8828a5cd. Three MAJOR missing-test findings, all actionable and folded without an implementation change:

- Pending check retry: reuse pending receipt after task closes; original open result persists, fresh id resolves.
- Atomic nested success: an outer operation aborts after a real successful check; ask, both inner receipts and outer receipt roll back, no live publication. Success publishes only outside the transaction.
- Original viewer and central grant: successful project-visible nonowner check asserts the actual nested viewer. A real service grant for checkWait alone cannot resolve; adding resolve allows the exact failed id to retry.

Signed merge of verified main ff20b2ee26046ff2888366de6857c8aed3623b10 resolves only a changelog conflict; no Attention implementation change. No Attention implementation changes were needed for the findings.

## Round 2 — CLEAR

Frozen head 4de8812090e869de932e3150759a3b3be4b46f9b. TREE sha256:ce96d21682394922768da01c564dc4cfafa9590b3c59fcc3d369ff5a82489fef. Standards no findings; Spec one NIT: terminal-state fixtures asserted resolved without each exact explanation. Folded test-only by parameterizing all five expected explanations. No further review owed; stopped on CLEAR within the three-round bound. Implementer judgment: ship this bounded explicit operation after green exact-head CI; automatic member reconciliation and task-comment matching remain in docs/attention-piece.md and t-2205. No known hole in the shipped scope.
