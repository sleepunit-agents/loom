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
An agent's own credential, a terminal session included, also has the approval operations and two for
notices, through `loom_command` or the command door (`POST /api/<piece>/<operation>`):

- `approvals.rule {kind, target}` answers `{tier, scope, person}`: `do`, `tell` or `ask`, with the scope and
  person of the rule that matched, or `ask` with both null. For the agent's own work (a terminal, or a
  lane for no member) the kinds are `merge` and `command`; any other kind answers `ask`. The repository in
  a merge target is written lower case with no `.git`; another spelling is refused. A merge target in a repository loom reads that is not the
  agent's own open change at that commit is refused (`conflict`), as a card for it would be.
- `approvals.request {kind: "merge"|"command", target, what, why, ask, ifYes, ifNo, minutes?, details?}`
  answers `{id, state}`; `approvals.use {id, kind, target}` answers `{id, used}`;
  `approvals.report {id, what}` answers `{id, reported: true}` for a card a tell rule allowed;
  `approvals.withdraw {id}` answers `{id, state: "withdrawn"}`. A card's state is read with the `approvals`
  tool or query.
- `notices.raise {key, title, detail?, quiet?}` answers `{item, raised, pushed}`: the key, whether the
  notice was news to the people who have the agent, and whether any push was queued. Nothing is pushed for
  `quiet`, for a key settled within the last ten minutes, or to a person who already has the notice
  waiting; a person who has gained the agent since is told. A 51st waiting key is refused (`conflict`).
  `notices.clear {key, why}` answers `{cleared}`.

Whose rules answer, what a merge target is held to and who a notice reaches are in
`docs/specs/owners.md`, "An agent's own work, and what it may raise".

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
  denied tools, `docs/runtime/worker.md`) is denied every named tool as well,
  however the stored pattern lists its entries. An entry stored under the
  server's former name, `mcp__loom_secrets`, still denies the tools it denied.
- **Whose.** The body's program is told its agent's name by the worker, and a
  few tools use it: `identity`, `note_read`, `note_list`, `memory_drafts`,
  `person`, `project` and `task_create`. The name selects nothing. Loom takes
  the agent from the credential, so a body told another agent's name is
  refused by those tools or told there is nothing, and every other tool acts
  as the credential's agent.
- **`identity`.** A body is handed its creed, preferences, self-model, Top of
  Mind and last 24 hours when it starts, if its agent has any. In a body that
  was handed them, `identity` with no piece asked does not repeat the creed,
  preferences and Top of Mind: it returns the role or project page asked for
  and the index of pieces, which says so. A piece asked for by name is
  returned.
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

### Answering an approval on the owner's word

An owner can call `approvals.answer` with the card ID, an `answer` of `allow` or `deny`, and optional `onWord: {venue: "terminal", through: "art", quote: "..."}`. A unique retained human turn in an open terminal session for the signing owner and named agent supplies the conversation, turn and machine. Missing, unreadable or ambiguous words leave an unverified attribution. Omitting it gives the ordinary owner answer.

A body working on its owners' word can answer with `onWord: {quote}` when exactly one eligible message in its credential's job contains the quote. If several match, quote a longer passage. A body that knows the inbox item can still use `onWord: {item, quote}` to name it directly. Loom checks a human bridge message against the venue link or reads the signed-in member's Comms message. The writer must still be a household owner and able to answer the card. The quote is 1–500 characters, copied exactly. One message can support multiple cards, including cards filed by the same agent. Card-specific checks, such as a merge head still matching, apply.

The agent itself can answer for a household owner from a session at that owner's own terminal. The session's credential must be bound to the owner's machine (`terminalMachine` when it is issued); the agent's ordinary terminal credential answers nothing. It calls `approvals.answer` with `onWord: {venue: "terminal", through: "<itself>", quote: "..."}`. The quote must be at least twelve characters and must appear in something loom itself recorded from that owner, said to this agent, in a terminal session on that machine that is still running and whose words are still kept. Where it appears more than once the newest message is the one answered on. There is no unverified form of this answer: words loom cannot find or cannot read are a refusal. The record reads `Allowed by <owner> as told to <agent> at the terminal: “<quote>” (conversation …, turn …, machine …)`, and the owner is told of the answer as for any answer given through an agent. What makes the words the owner's is the terminal hook on that machine, so whoever can run programs as that machine's user can put words in the owner's mouth; that was already true of the owner's own credential kept there.

## Reading back what was said

A private conversation is read by its member. The agent it is with reads it too, in two places only: a body doing that member's own work, and a session at that member's own terminal (the same machine-bound credential). Those are the places where the only person it can show the words to is the one who said them. A body woken by anyone else, in any room, is the agent alone and reads none of it, so nothing a guest or another member asks can bring a private conversation into their view. The rule is about where words can be shown, not about keeping from an agent what it was there for. `commsThreads(agent:)` and `commsMessages(thread:)` are the reads; words follow the household's keep time as for the member. What hangs off a conversation (its jobs and its mail) keeps the narrower rule and stays the member's.

A terminal conversation is titled with the machine's name, the harness and the folder the session began in.

A quoted instruction supplies the confirmation for a dangerous card. The owner receives the decision and quote in their Inbox. Dangerous cards and household proposals that always ask produce a full-volume item. Other quoted decisions produce a dim item. The permanent approval record includes the attribution and timestamp.

## Observing a terminal conversation

A household owner can issue an agent credential for an enrolled machine. At
`POST /api/signin/token`, include `terminalMachine` (the box ID) alongside
`kind: "agent"`, `agent` and `label`. Keep the bearer on that machine. Loom
records its current owner when issuing the credential and checks the binding
on each write. Reassigning or revoking the machine invalidates that binding.
Unbound terminal credentials continue to work for their existing tools.

The hook sends an authenticated `POST /api/terminal/session` operation with
`{id,input}`. Use a fresh operation ID for a new activity and the same ID when
retrying it. Every input names the machine, harness and harness session ID.
Installed hooks also send an `instanceId` identifying this CLI process. On resume, the latest open takes over lifecycle reporting. Delayed usage from the previous process can still settle. Deleting the thread erases its words while the process can finish reporting cost and end.
Loom supplies the member from the binding. Machine control is the trust
assumption here. Anyone with the credential can report what was typed there.

| Action | Additional input | Effect |
| --- | --- | --- |
| open | cwd, model (nullable) | Opens or resumes the same private conversation |
| turn | eventId, role (member or agent), words | Records the submitted prompt or finished answer once |
| usage | runId, description (nullable), revision, report, optional completed flag for a child | Replaces this run’s cumulative usage with a newer measured snapshot |
| heartbeat | none | Refreshes observed activity |
| end | none | Removes the session from running work |

Prompts and finished answers use the Comms message store and sealing key.
The household chooses the word retention period, from one to fourteen days
(default fourteen). Shortening it takes effect on existing messages.
Conversation and usage metadata survive word expiry. Tool counts come from
the transcript. Tool arguments, output, and intermediate reasoning stay out
of the report.

A session ages out after fifteen minutes without a heartbeat or another
submitted turn or open. Usage updates may arrive after end and do not renew presence. This allows quiet stretches during an answer and bounds
how long a crashed terminal appears live. An idle terminal can disappear and
reappear on its next activity. Ended sessions can resume with the same
harness session ID. Control of the process stays on its machine.

Each transcript supplies a cumulative snapshot of the existing job usage
record. The main transcript uses run ID `main`. Each subagent uses its own
run ID under the same conversation. A child completion records its end even when the final counter snapshot arrives later. A report's revision is the byte count of
the transcript snapshot it measured. Duplicate and older revisions do not
add cost. Missing measurements remain unknown. A quoted terminal approval
uses the existing owner's approval door.
