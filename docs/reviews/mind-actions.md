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

Round 2 pending on the revised frozen artifact.
