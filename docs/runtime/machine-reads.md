# Machine reads

A machine read selects one diagnostic by name. For example, `{"machine":"box-example","read":"unit-journal","args":{"scope":"user","unit":"loom-worker.service","lines":10,"since":15}}` requests up to ten journal entries from the last fifteen minutes. The worker reads with its existing Linux account permissions. Missing software, unavailable services and access failures produce a refusal.

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

Use `user` or `system` for `scope`. Specify a literal unit including its suffix. The name must start with an ASCII letter or digit and may contain letters, digits, dots, colons, underscores, hyphens and at signs. The root mount and backslash-escaped names are outside this subset. Journal reads accept 1–100 lines (default 30) and 1–1440 minutes for `since` (default 60). Unknown arguments are refused.

Each diagnostic has a fixed executable, a four-second deadline and a 16,384-byte output limit. An oversized answer is refused in full. The worker checks output for its own credential in plain text and base64 and for recognizable credential formats before returning it. A matching answer is withheld in full. Programs' error output stays on the worker. By default journal output contains only timestamps and priorities. The operator may list exact scope/unit pairs in `journalUnits` to release their message text. Both worker unit names must be listed to release worker-log messages. A journal is as sensitive as what its programs log. An opaque or encoded credential can escape recognition. Choose message access only for units whose output the agent's authorized jobs may read.

Open **Your account → Your machines** and select a machine you own to view its latest 100 read requests. History records the agent, job, conversation, whose word started it, diagnostic, arguments, time, returned byte count and outcome. It stores request metadata and omits the diagnostic output.

Use **Request read grant** or **Request revocation** under the machine's explicit grants. Review the named agent and machine on the pending card, then choose **Allow** or **Deny**. Allowing a revocation removes the explicit grant. An agent may still qualify through its existing permission to run on the machine. The reader list gives an agent inspection access only.
