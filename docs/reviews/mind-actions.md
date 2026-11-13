# Knowledge actions/source receipts review

Assessment: high. Data: additive source metadata migrations. Security: new write
boundary uses central policy; external replay must preserve the existing retry
contract after permission loss. Contract: Context receipt/recovery API and two
operations. Concurrency: independent source/core commits and retries. Delivery:
no host or environment changes. Mechanism: source/core INSERT failure injection,
restart, exact expiry, denial and two live windows discriminate guarantees.

Claim: retries acknowledge one committed Knowledge verification across a failed
core receipt and restart. Why it matters: notes and audit must not duplicate.

Frozen recipe: git archive the named commit, excluding docs/reviews, then add
REVIEW.patch from origin/main..that commit. All replies/prompts live outside the
frozen tree. No current or earlier review ledger is supplied to the reviewer.
Maximum three rounds under ~/Art/CLAUDE.md.

Round 1: commit 8f7228b3f285cfea31443f7b97c7fe99811e0e56,
TREE sha256:77689d4db3bc7249e81103c08b092aeed92ede8a7fee7bdb34910f1b942908a6.
Raw BLOCKING: two CRITICAL, two MAJOR. All folded:

- CRITICAL, actionable: delayed source recovery extended the core receipt expiry.
  RecoveredWrite retains the original deadline; day-29 recovery/day-30 reuse test.
- CRITICAL, actionable: current policy prevented replay after permission loss.
  Operation.recover runs before may; revoked caller replays but fresh id is denied.
- MAJOR, actionable: unversioned request-time DDL. Numbered source migrations run
  at installer startup; ledger mismatch/newer version and atomic failure tests.
  Portable source tables are outside the spec's loom.db migration scope, but
  versioned schema is useful here as well.
- MAJOR, actionable: unexplained any in the socket fixture. The erasure now has
  a comment explaining its purpose and structural assertions. New action fixtures
  also run startLoom in next mode.

Round 2: commit 36b8508268cc7c24704fca63e87e0e3f9294ba59,
TREE sha256:87bfa8b44b9885c8cfb96fbe5627da7be1e89d05263aeb38a23e78b612fc6c1f.
Raw BLOCKING: one CRITICAL, one NIT. Both folded:

- CRITICAL, actionable: source recovery was looked up only for the requested
  operation, allowing an unrelated write to reuse a source-committed id whose
  core receipt failed. All registered write recovery hooks now check the shared
  namespace before any write. A restart regression registers an unrelated write,
  verifies conflict and zero SQL effects, then recovers the original result.
- NIT, actionable: confirm outcome and a second successful viewer were missing.
  Tests assert both audit outcomes and attribution to another named owner.

Round 3: commit b2d80d556dc6bf694efe100513aebfcfc9401ad3,
TREE sha256:a31f7099d84857fdf6c2c9374e5d5281bdf0427322f5e3630c9c0d94422f538f.
Raw CLEAR: no findings. Stop under the three-round bound. All real findings from
rounds 1–2 were folded with regression tests. The final implementation passes
86 affected Mind/foundation/touch/architecture tests plus TypeScript and diff
checks. This ledger-only update changes no reviewed implementation or tests.

Author judgment: source receipts commit with effects, retain their original
expiry and reserve the global write-id namespace. Versioned source metadata
migrations are additive and reversible by leaving their unused tables in place.
No known hole remains in this unit. It remains additive/unenabled pending the
source socket composition and four apps. No host rollout was performed.

Raw transcripts and the frozen recipe are retained in loom note
loom/2026-11-12-mind-action-receipts-evidence. Review evidence is not merge
permission; current-head checks and the live merge rule still govern.
