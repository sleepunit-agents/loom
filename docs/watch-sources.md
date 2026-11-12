# Watch sources, step 1

`src/watch-sources.ts` defines the read-only `WatchSource` contract and
`WatchRegistry.register`. Core currently registers `runtime.lane`, `tasks.task`,
`approvals.pending` and `clock.deadline`. GitHub is owned by the Changes piece;
core has no GitHub integration. No manifest offer is added in this step.

A caller builds a registry for one authorized snapshot. `list(agent)` gives
stable items, `identity(item)` gives a kind/agent/producer-id target key, and
`observe(item)` gives deterministic JSON of state, deadline and run identity.
Labels, ages and activity timestamps do not affect equality. An unavailable
provider or missing target throws on observation; it is never an observation
value. `WatchRegistry.list` isolates source errors as unavailable groups with
`count: null`, rather than claiming zero.

The built-in adapters use public piece manifests, never piece stores or code.
They receive the same owner and conversation filters as agent cards, including
`asksFor` for approval visibility. Counts cover the items these reports publish,
not an inventory of a producer's entire store. Tasks include reported backlog
and waiting tasks; runtime lanes include running lane jobs; deadlines include
scheduled clock jobs with an `at`; approvals include pending attention asks with
a stable action id. Household-wide approvals without an agent are not assigned
to an arbitrary agent. A source lacking stable approval ids is unavailable.

`loom/agent-status@1.3` adds optional `watches`: groups with kind, label, status,
count and items. Home and live reads use the same builder. The existing collection
subscription updates the desktop, compact and phone cards, where each count
expands to its items. This builds on PR #818, with no separate refresh loop.

## Step 2: clock parking

The clock must obtain fresh, authorized source snapshots and authoritative
per-target observations before parking. A bounded manifest dropping an item
cannot prove completion; current adapters throw rather than invent a terminal
value. Source absence and unknown/computing values are probe errors. The clock
needs a program read seam (this step only publishes member-facing cards), full
membership/coverage from providers, terminal observations for tracked ids, and
its own acknowledged baselines, level-triggering, heartbeat and one-run rule.
These mechanisms are not implemented by this registry. Never persist a viewer's
item words in a shared change log or reuse one viewer's registry for another.

Step 3 can register piece-backed implementations through the same interface;
manifest validation, process isolation and permission checks must precede that.
