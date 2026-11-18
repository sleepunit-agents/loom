# Machine reads

A machine read selects one diagnostic by name. For example, `{"kind":"unit-journal","scope":"user","unit":"loom-worker.service","lines":10,"since":15}` requests up to ten journal entries from the last fifteen minutes. The worker reads with its existing Linux account permissions. Missing software, unavailable services and access failures produce a refusal.

| Kind | Arguments | What the worker reads |
| --- | --- | --- |
| `unit-state` | `scope`, `unit` | Unit identity, load, active and substate, result, restart count and main process exit status |
| `unit-journal` | `scope`, `unit`, optional `lines`, `since` | Recent timestamped journal entries for one unit |
| `failed-units`, `restarting-units` | `scope` | Units currently failed or awaiting automatic restart, with load, active and substate |
| `worker-log` | Optional `lines`, `since` | User journal for `loom-worker.service` and `loom-new-worker.service` |
| `disk`, `memory`, `load`, `swap` | None | Local filesystem space, memory in bytes, load averages, or swap usage |
| `uptime`, `boots` | None | Uptime or up to ten recent journal boots |
| `containers` | None | Running containers' IDs, names and states from the local Docker socket |
| `proxmox-vms`, `proxmox-containers` | None | Local Proxmox VM or container list |
| `zfs`, `zpool` | None | Dataset names, types and space usage, or pool health from `zpool status -x` |

Use `user` or `system` for `scope`. Specify a single literal unit name including its suffix. Journal reads accept 1–100 lines (default 30) and 1–1440 minutes for `since` (default 60). Unknown arguments are refused.

Each diagnostic has a fixed executable, a four-second deadline and a 16,384-byte output limit. An oversized answer is refused in full. The worker checks output for its own credential in plain text and base64 and for recognizable credential formats before returning it. A matching answer is withheld in full. Programs' error output stays on the worker.
