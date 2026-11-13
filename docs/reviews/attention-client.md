# Attention client cold review

ASSESS high: data no (no migration/import); security yes (bearer transport); contract yes (CLI metadata); concurrency yes (same-id retry); environment no (opt-in launcher only); uncaught no (HTTP fixtures and CI).

CLAIM: client bindings transport daemon-owned JSON values and retain one write id across retries.
WHY: a lost response must not repeat a committed action, and clients must not duplicate domain policy.

## Round 1

Frozen f36d15aeafd7dc509adf1deb447bbaa3a620ef3d; TREE sha256:d4719929634c8042a522d18161c835d77bca641f98c08bf4a26f8470d67cb657. Reply: /home/art/scratch/attention-client-review/round-1/reply.md. Verdict BLOCKING.

- MAJOR, actionable: mismatch guard lacked discriminating tests. Added undeclared-operation and write-marker mismatch cases in both directions.
- MAJOR, actionable: help test depended on configured daemon. Added no-argument/--help/-h calls with empty environment and fail-on-call transport.

Author validation also caught the initial client location violating the piece import boundary; moved transport to src/cli/attention-client.ts. All 63 affected tests then passed, including architecture. Round 1 frozen artifact remains unchanged; next round includes the correction. No previous findings or this ledger enter the next frozen patch/tree.

## Round 2

Frozen 493ffa16975dab10bc6e241a147ae33f2c6795aa, own ledger excluded from archive and patch; TREE sha256:6bcb63f293325dfbc431c6d784e8a7eef1ed659814d4d8e662c0bbb1c7c2f197. Reply: /home/art/scratch/attention-client-review/round-2/reply.md. Verdict BLOCKING.

- CRITICAL, actionable: JSON.parse/stringify changed overflowing JSON numbers into null before schema validation. Client now validates object shape but embeds the original JSON text in the envelope. Added a real HTTP own-turn/finding fixture: score 1e400 refuses without a row; explicit null succeeds. The fixture also asserts raw transmitted overflow. This preserves daemon-owned validation and fixes an actual changed-write bug.
