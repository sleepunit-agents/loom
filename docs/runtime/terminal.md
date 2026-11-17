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

Register it in the client under the server name `loom`. A body's tools server has
that name too (below), so in Claude Code a tool is `mcp__loom__<name>` in a
terminal session and in a body, and a page of instructions can name it once.

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
Splitting a project is two steps: propose the new project, then move the
tasks into it (`docs/specs/owners.md`, "Moving a task, and merging or splitting projects"). The terminal receives no current-worker authority: job and
conversation controls still require their existing bound credentials.

## The same tools in a body

A body that loom started is served the same named tools, from the same
definition (`src/shared-mcp-named.ts`; `src/runtime/body-named-tools.ts` puts
them on the body's own tools server). It is served them beside the tools only
a body has: `request_secret`, `use_secret`, and `loom_commands`, `loom_command`
and `loom_query` with the body's credential, which also reach the conversation
operations (`docs/runtime/worker.md`, "Composing native tools").

- **Names.** Every harness is given the server as `loom`. Claude Code shows a
  tool as `mcp__loom__<name>`, the string a terminal session sees. A page that
  is read in both places, or by another harness, writes the tool's own name
  (`task_claim`) or the Claude Code name (`mcp__loom__task_claim`).
- **Reach.** In a body a named tool is the body's `loom_command` or
  `loom_query` under a plain name: it sends what they send, with the body's
  credential, through the same doors, and is refused with the door's words
  where they are refused. A body working for a member sees through `approvals`,
  `inbox` and `task` what that member's reach allows, as its `loom_query` does.
- **Denials.** A room that is denied `loom_command` or `loom_query` (an agent's
  denied tools, `docs/runtime/worker.md`) is denied every named tool as well. A
  pattern stored under the server's former name, `mcp__loom_secrets`, is read
  as the same pattern under `mcp__loom`.
- **`identity`.** A body is handed its creed, preferences, self-model, Top of
  Mind and last 24 hours when it starts. In a body `identity` with no piece
  asked does not repeat the creed, preferences and Top of Mind: it returns the
  role or project page asked for and the index of pieces. A piece asked for by
  name is returned.
- **Which.** All of them: none of the named tools is about the terminal's own
  session. A body built without `loom_command` and `loom_query` gets none.
- **Cost.** Nothing is added to the words a body starts with. The tools' own
  definitions are about 19 KB of JSON in the harness's tool list (the five
  tools a body had before are under 4 KB); no token count was taken from a
  running harness. `body-named-tools.integration.test.ts` holds the definitions
  under 20,000 bytes. A body is served at most 64 tools.

Private query responses retain the original credential, sharing and selected-word
retention lease through the outer MCP response, including delayed reads and
clones. Existing precious source files are not upgraded by startup. An existing
Notes file remains readable under its ordinary policy; native writes require
retry metadata prepared by the separate data move. Fresh source files are
prepared at creation.
