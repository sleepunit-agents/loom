# Terminal MCP on the shared program

Start the shared program with `serve --next`. Its `/mcp` endpoint uses bearer
credentials and the same command executor and GraphQL queries as its HTTP API.
A terminal session does not need a browser or a worker job. An owner can issue
its agent credential through `/api/signin/token` with `kind: "agent"`, an
existing `agent`, and a unique `label`. That door makes no token bound to a job: a job's
body is enrolled by its worker.

For a stdio MCP client, configure:

```sh
loom mcp --next --url https://loom.example --token-file /private/terminal-token --agent fern
```

`LOOM_URL` and `LOOM_TOKEN_FILE` can provide the URL and credential file instead.
The URL is an origin, with HTTPS required except on loopback. The optional
`--agent` constrains the authenticated identity on every request; it cannot
select another agent. `--home` is refused: stdio connects to the running program
and never opens a household database or starts another root.

The tools are:

- `identity`: load the authenticated agent's declared Identity and retained
  context. Client/model/conversation/run hints confer no authority.
- `loom_query`: read the generated GraphQL schema under the caller's current
  permissions. For example, `{memoryIdentity(agent:"fern"){creed topOfMind}}`.
- `loom_command`: call a registered HTTP operation with `{operation,input,id}`.
  Choose one stable `id` for each intended write. Do not automatically retry an
  uncertain outcome with a new ID.
- `loom_commands`: use the existing command catalogue where that caller is
  admitted. Calling an otherwise granted operation does not require catalogue
  access.

A terminal session also gets the names it already calls. Each is a thin mapping
onto one registered command or one query on this same door, so a named tool
that works proves its data layer works:

| Tool | Maps to |
|---|---|
| `identity` | `memoryIdentity(agent:)`, with `page(kind:, name:)` for harness, model, role and project pages |
| `remember` | `memory.remember` |
| `recall` | `memory.recall`, then one query for the matches' titles and content |
| `update`, `forget` | `memory.update`, `memory.forget` |
| `episodes` | `memoryActivity(to:)` |
| `knowledge_recall` | `memoryKnowledgeSearch(query:, domain:, first:)` |
| `knowledge_write` | `mind.knowledgeAdd` |
| `note_read` | `memoryNote(agent:, path:)` |
| `note_write` | `memory.noteWrite` |
| `note_list` | `memoryNotes(agent:, prefix:, first:)` |

`identity` returns the creed, preferences, Top of Mind and an index of further
pieces. `piece` or `pieces` selects `self-model`, `last-24h`, `harness` (with
`client`), `model` (with `model`; a dated name falls back to its family's page)
or `all`. `role` and `project` add that page to the core. Pages are Markdown
files in the agent's own declared folder (`harnesses/`, `models/`, `roles/`,
`projects/`, `clients/`); a name cannot leave its folder.

`memoryNotes` lists paths, lifetimes and sizes without text.
`memoryKnowledgeSearch` returns active pages in which every query word appears
in the title, body or domain; it is one statement and records no access. The
named tools need an agent credential and always act on that agent's own source.

Through the generic tools: for private Memory, use `memory.remember` and `memory.recall`; their opaque IDs
can be read with `memoryProjectMemory(id:){title content}`. For Notes, use
`memory.noteWrite` with `{path,body,lifespan}` and read
`memoryNote(agent:"fern",path:"project/work"){body by}`. A new note requires
`lifespan` (`keep`, `while`, or `short`). These operations select the authenticated
agent's declared source, never a caller-supplied directory.

Knowledge uses `mind.knowledgeAdd` and the existing Knowledge queries. Tasks use
`tasks.command` for create, claim, comment, close and moveToProject, and the generated Tasks
queries for reads. `task_move_to_project` moves tasks to another project, all of them or
none; `propose` with `projectMerge` asks a household owner to merge two projects, and
with `projectJoin` asks for the agent itself to be let onto a project.
An agent's own credential, a terminal session included, also has the approval operations and two for
notices, through `loom_command` or the command door (`POST /api/<piece>/<operation>`):

- `approvals.rule {kind, target}` answers `{tier, scope, person}`: `do`, `tell` or `ask`, with the scope and
  person of the rule that matched, or `ask` with both null. From a terminal the kinds are `merge` and
  `command`; any other kind answers `ask`.
- `approvals.request {kind: "merge"|"command", target, what, why, ask, ifYes, ifNo, minutes?, details?}`
  answers `{id, state}`; `approvals.use {id, kind, target}` answers `{id, used}`;
  `approvals.report {id, what}` answers `{id, reported: true}` for a card a tell rule allowed;
  `approvals.withdraw {id}` answers `{id, state: "withdrawn"}`. A card's state is read with the `approvals`
  tool or query.
- `notices.raise {key, title, detail?, quiet?}` answers `{item, raised, devices}`;
  `notices.clear {key, why}` answers `{cleared}`.

Whose rules answer, what a merge target is held to and who a notice reaches are in
`docs/specs/owners.md`, "An agent's own work, and what it may raise".

Splitting a project is two steps: propose the new project, then move the
tasks into it (`docs/specs/owners.md`, "Moving a task, and merging or splitting projects"). The terminal receives no current-worker authority: job and
conversation controls still require their existing bound credentials.

Private query responses retain the original credential, sharing and selected-word
retention lease through the outer MCP response, including delayed reads and
clones. Existing precious source files are not upgraded by startup. An existing
Notes file remains readable under its ordinary policy; native writes require
retry metadata prepared by the separate data move. Fresh source files are
prepared at creation.
