# Member Inbox read facts review

ASSESS high: data additive schema six; security member-private reading metadata; contract operation/live type; concurrency nested rollback/retries; environment no host/deploy; mechanism focused tests and CI. Claim: member read facts persist independently of answering. Why: reading must not disclose another member's activity or remove an unanswered ask.

Round 1 TREE sha256:4c59bdbcaa035cd09f56b05295a619a58b14bc9cd5ff83d07cb76a0e91b98507, from signed 08aafb5, BLOCKING.
- MAJOR actionable missing-test: nonowner isolation did not prove another household owner cannot read the mark. Added Alice-owner reading Bob's mark and Bob promoted to owner reading Alice's mark assertions. Implementation unchanged.

At most three rounds, no author ledger in frozen review trees.

Round 2 TREE sha256:67735e2243f1c193b38ebc5f856a129fa053f069323aaf846d81ef590bff46c9, from signed6fc3a6d, BLOCKING.
- MAJOR actionable test harness: upgrade/reopen used createFoundation. Converted all new server scenarios to startLoom(next:true), fixture home; upgrade seeds version5 in the install hook then exercises real next composition and reopen.
- NIT actionable retry proof: assert stored receipt and committed replay after ask-access revocation while fresh-id write refuses.
- NIT actionable publication proof: assert exact attention.readMark type and returned id, not only call count.
All changes test-only; production remains08aafb5. Focused4 cases pass. Final round3 follows; no fourth.

Round 3 TREE sha256:bd731390e474600c4bb8381444ef9042536351a331acbbff41b9988dfffa5d8c, from signed3abbaab, CLEAR, no findings. Review complete at three rounds. Production unchanged08aafb5 throughout. All actionable findings were test-only and folded. Final203 affected tests/20files plus12 architecture contract tests and root tsc/diff checks pass. No UI change or screenshot inspection claim. Merge requires final exact-head CI and approvals rule.
