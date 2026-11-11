# Collection refresh deployment handoff

The change is prepared for review only. No merge, deployment, or production CPU result is implied.
The production acceptance check remains open on t-2026: LAN listener below roughly 3% of one
core with an idle desktop subscriber, and approximately zero `collection refresh` stalls in ten minutes.

## Measured evidence in the house

Same snapshot-provider fixture, 2,100 tasks plus 300 changes, two subscribed windows; real provider
processes with the clock advanced through five minutes:

| Measure | Base a81639e | Change |
| --- | --- | --- |
| Provider processes per quiet minute | 18, 6, 6, 6, 6 | 6, 0, 0, 0, 0 |
| Five-minute total | 42 | 6 |
| Announced write / action | 5 / 5 processes | 5 / 5 processes |
| Unannounced legacy write, recent reader | within 60 s | 300 s |
| Last update of a 12-write burst | 502 ms | about 503 ms |

`npx vitest run src/collections/pulls.bench.integration.test.ts --maxWorkers=1`
reproduces the process bench. The targeted agent-status seam uses a real HTTP subscription and
stub runtime manifest, without a browser; the update reached the authorized viewer in 104–108 ms
and did not reach an owner of another agent. The new change-driven tests show zero source reads
over 19 maintenance rounds (285 simulated seconds), one full check at 300 seconds, and no further
full checks after the recent-reader window expires. These are source/process counts and latency,
not a claim about production CPU.

## Steps for the deploying body, after separate merge/deploy authorization

1. Wait for the exact merged main commit's `CI results` and `deploy build` to pass. Record both
   the reviewed PR head and the merged commit (merge queue may produce a different commit).
2. On loom's machine, leave the desktop app open with its normal subscriptions and no interaction.
   Capture a 60-second baseline before deploying:

   ```sh
   python3 ~/Code/loom/scripts/collection-cpu-sample.py > /tmp/collections-cpu-before.json
   ```

   If the live checkout predates this sampler, bring over this read-only script first; do not
   build or run test/browser suites on the live machine. The sampler includes every process in
   all three service cgroups (stable proxy and worker), reports individual PIDs and service totals,
   and fails if a process exits, is replaced, or joins during the sample. Repeat after handovers settle.
3. Use the installed artifact deployment entry point (it fetches the green exact main artifact,
   health-checks, and hands over all three listeners):

   ```sh
   flock -n /tmp/deploy-loom.lock ~/Art/bin/deploy-loom t-2026-collections
   ```

   Leave `LOOM_COLLECTIONS_CHECK_MS` unset for the five-minute default. No runtime piece update is
   needed for this PR. Keep the script's deployment output as evidence of the actual commit deployed.
4. Once the handover has settled, leave the same subscriber idle and capture another sample:

   ```sh
   python3 ~/Code/loom/scripts/collection-cpu-sample.py > /tmp/collections-cpu-after.json
   ```

   Compare the LAN service total and its individual worker against the under-3% target. This
   includes legacy manifest work, which this change deliberately preserves for old page consumers.
5. Mark a ten-minute observation window, then count stall lines from just that window:

   ```sh
   date --iso-8601=seconds > /tmp/collections-observation-start
   ```

   After ten minutes (schedule a continuation; no body needs to sit in a wait loop):

   ```sh
   journalctl --user -u loom-http.service -u loom-http-lan.service -u loom-http-local.service --since "$(cat /tmp/collections-observation-start)" --no-pager > /tmp/collections-stalls-after.log
   rg 'stall.*collection refresh|collection refresh.*stall' /tmp/collections-stalls-after.log
   ```

6. Attach before/after JSON, the ten-minute log and the deployed commit to t-2026/PR Evidence.
   If the CPU or stall target fails, keep the task open and diagnose the remaining work; don't
   infer acceptance from test counts. Reverting this PR restores prior behavior; its two extra
   cache tables can remain, with no data deletion or migration rollback needed.

Legacy attention still builds its bounded Inbox before filtering keyed hints; arbitrary piece
snapshot providers keep full invalidation until their own producers/changes offers name rows.
Unknown or lost producer hints are repaired only while a recent reader keeps checks active.
A dead owner may take up to its 30-second lease to fail over; a cleanly idle listener releases
its lease. Those limits must stay visible when assessing rollout results.
