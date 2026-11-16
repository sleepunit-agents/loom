# Terminal MCP on the shared program

Start the shared program with `serve --next`. Its `/mcp` endpoint uses bearer
credentials and the same command executor and GraphQL queries as its HTTP API.
A terminal session does not need a browser or a worker job. An owner can issue
its agent credential through `/api/signin/token` with `kind: "agent"`, an
existing `agent`, and a unique `label`; omit `job` for a terminal session.

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

For private Memory, use `memory.remember` and `memory.recall`; their opaque IDs
can be read with `memoryProjectMemory(id:){title content}`. For Notes, use
`memory.noteWrite` with `{path,body,lifespan}` and read
`memoryNote(agent:"fern",path:"project/work"){body by}`. A new note requires
`lifespan` (`keep`, `while`, or `short`). These operations select the authenticated
agent's declared source, never a caller-supplied directory.

Knowledge uses `mind.knowledgeAdd` and the existing Knowledge queries. Tasks use
`tasks.command` for create, claim, comment and close, and the generated Tasks
queries for reads. The terminal receives no current-worker authority: job and
conversation controls still require their existing bound credentials.

Private query responses retain the original credential, sharing and selected-word
retention lease through the outer MCP response, including delayed reads and
clones. Existing precious source files are not upgraded by startup. An existing
Notes file remains readable under its ordinary policy; native writes require
retry metadata prepared by the separate data move. Fresh source files are
prepared at creation.
