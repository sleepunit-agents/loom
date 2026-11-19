# Machine reads

A machine read selects one diagnostic by name. For example, `{"machine":"box-example","read":"unit-journal","args":{"scope":"user","unit":"loom-worker.service","lines":10,"since":15}}` requests up to ten journal entries from the last fifteen minutes. The worker reads with its existing Linux account permissions. Missing software and commands that exit with an error produce a refusal. Journal reads cover entries visible to the worker account. Journalctl can return a successful empty or partial result when that account lacks access to other journal files. An empty result does not establish that the unit logged nothing.

| Kind | Arguments | What the worker reads |
| --- | --- | --- |
| `unit-state` | `scope`, `unit` | Unit identity, load, active and substate, result, restart count and main process exit status |
| `unit-journal` | `scope`, `unit`, optional `lines`, `since` | Time and priority for one unit, or message lines for a locally listed journal |
| `failed-units`, `restarting-units` | `scope` | Units currently failed or awaiting automatic restart, with load, active and substate |
| `worker-log` | Optional `lines`, `since` | User journal for `loom-worker.service` and `loom-new-worker.service` |
| `disk`, `memory`, `load`, `swap` | None | Local filesystem space, memory in bytes, load averages, or swap usage |
| `uptime`, `boots` | None | Uptime or up to ten recent journal boots |
| `containers` | None | Running containers' IDs, names and states from the local Docker socket |
| `proxmox-vms`, `proxmox-containers` | None | Local Proxmox VM or container list |
| `zfs`, `zpool` | None | Dataset names, types and space usage, or pool health from `zpool status -x` |

Use `user` or `system` for `scope`. Specify a literal unit including its suffix. The name must start with an ASCII letter or digit and may contain letters, digits, dots, colons, underscores, hyphens and at signs. The root mount and backslash-escaped names are outside this subset. Journal reads accept 1–100 lines (default 30) and a default `since` of 60 minutes. The maximum lookback is 1,440 minutes (minimum 1). Unknown arguments are refused.

Each diagnostic has a fixed executable, a four-second deadline and a 16,384-byte output limit. An oversized answer is refused in full. The worker checks output for its own credential in plain text and base64 and for recognizable credential formats before returning it. A matching answer is withheld in full. Programs' error output stays on the worker. By default journal output contains only timestamps and priorities. The operator may list exact scope/unit pairs in `journalUnits` to release their message text. Both worker unit names must be listed to release worker-log messages. A journal is as sensitive as what its programs log. An opaque or encoded credential can escape recognition. Choose message access only for units whose output the agent's authorized jobs may read.

Open **Your account → Your machines** and select a machine you own to view its latest 100 read requests. History records the agent, job, conversation, whose word started it, diagnostic, arguments, time, returned byte count and outcome. It stores request metadata and omits the diagnostic output.

Use **Request read grant** or **Request revocation** under the machine's explicit grants. Review the named agent and machine on the pending card, then choose **Allow** or **Deny**. Allowing a revocation removes the explicit grant. An agent may still qualify through its existing permission to run on the machine. The reader list gives an agent inspection access only.

### Art lane observations

The separate `cleanup-week-journal` projection keeps the publisher on Art's user journal and the worker on its own user bus. As Art, capture `journalctl --user --user-unit=art-worktree-cleanup.service --since="8 days ago" --quiet --no-pager --output=json --output-fields=PRIORITY,_SYSTEMD_USER_UNIT` successfully, then pass its output to the publisher. It releases the seven-day count and up to 100 recent priorities and times. Treat unavailable retention or a gap in journal coverage as missing evidence. Journal message text remains with the operator.

The optional reads `mirror-freshness`, `alert-ledger`, `cleanup-receipt`, and `login-expiry` take empty arguments. Their inputs are operator-published JSON files named for the read under `/var/lib/loom/machine-facts/`. Keep that directory and its ancestors outside house mounts and writable only by the publishing account or root. Give the worker read access to the projections. Enable the corresponding read names only on the machine that actually owns these records. Every agent authorized to inspect that machine can request its enabled reads.

Use the tracked `scripts/project-lane-machine-fact.py KIND` outside the worker to prepare each projection independently. Supply the following sources on standard input.

| Kind | Complete input to the publisher | Released evidence |
| --- | --- | --- |
| `mirror-unit-state` | As the owner of the mirror service, capture `systemctl --user show --property=Id,LoadState,ActiveState,SubState,Result art-live-sync.service`. | Only the four measured state fields for that fixed service. User-scope systemctl in the enrolled worker sees its own bus. |
| `login-expiry` | The publisher reads the single configured Claude account login JSON locally on stdin. Keep that input outside the worker. | Only the observation time and refresh expiry as integer Unix seconds. Withdraw the projection when the source is unavailable. |
| `mirror-freshness` | Fresh stdout of Art's `bin/taskstore-mirror-check` from its live checkout. A stale result exits 1 and still prints the measured counts. A failed lookup supplies no counts. | Highest tracked and live task numbers. The groom threshold is live minus tracked greater than 15. |
| `alert-ledger` | Art's complete append-only `.alerts/ledger.jsonl`, including the previous 30 days | Each entry's timestamp, kind, source, optional alert ID and verdict. Up to 100 records in 26 hours. tuneSources lists recent sources whose normalized false-alarm cause recurred in 30 days. Detail, messages, causes, and facts stay private. |
| `cleanup-receipt` | Art's complete append-only `.local/state/art/worktree-cleanup.jsonl`, including the previous seven days | Timestamped starts and finishes with worktree counts and apply mode, removed commit IDs, counts kept, removed and marked for removal, and counts by recognized keep reason. Start and finish counts can differ. |

The operator must supply continuous history across rotations for the stated window. Never replace a missing source with an empty input. Capture each source successfully before publication, writing the resulting projection to a temporary file in the destination directory and renaming it into place only on success. Refresh at least every 15 minutes and withdraw the file on a known input failure. The publisher refuses malformed, oversized or unknown records in its observation window. An over-budget alert window is unavailable in full. The worker checks the schema and observation time, and applies its normal output and credential limits. A planning cursor older than the snapshot's start needs separate reconciliation before it can advance. A snapshot read never advances a mark.
