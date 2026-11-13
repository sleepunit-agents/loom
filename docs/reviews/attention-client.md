# Attention client cold review

ASSESS high: data no (no migration/import); security yes (bearer transport); contract yes (CLI metadata); concurrency yes (same-id retry); environment no (opt-in launcher only); uncaught no (HTTP fixtures and CI).

CLAIM: client bindings transport daemon-owned JSON values and retain one write id across retries.
WHY: a lost response must not repeat a committed action, and clients must not duplicate domain policy.

## Round 1

Frozen f36d15aeafd7dc509adf1deb447bbaa3a620ef3d; TREE sha256:d4719929634c8042a522d18161c835d77bca641f98c08bf4a26f8470d67cb657. Reply: /home/art/scratch/attention-client-review/round-1/reply.md. Verdict BLOCKING.

- MAJOR, actionable: mismatch guard lacked discriminating tests. Added undeclared-operation and write-marker mismatch cases in both directions.
- MAJOR, actionable: help test depended on configured daemon. Added no-argument/--help/-h calls with empty environment and fail-on-call transport.

Author validation also caught the initial client location violating the piece import boundary; moved transport to src/cli/attention-client.ts. All 63 affected tests then passed, including architecture. Round 1 frozen artifact remains unchanged; next round includes the correction. No previous findings or this ledger enter the next frozen patch/tree.
