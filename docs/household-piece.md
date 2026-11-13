# Household on the new side

The household piece holds household metadata, agents, members, tokens, sessions,
passkeys, one-time links, push state, member preferences and read marks, and piece
settings in `loom.db`. It reuses the lossless, keyed household row stores already
in core. Existing commands and the old server continue using their current stores.
The importer does not enable any new request path or change the running household.

## Importing for the final move

With the owner present, stop both instances and back up the old home. Run:

```
loom migrate household --home <new-home> --from <stopped-old-home>
```

Both homes must be different directories, and the new home cannot be inside the old one. The destination's household tables must
be empty. The command acquires the destination daemon gate and uses one database
transaction for schema, rows, comparison and receipt. Source files are read only.
The importer compares full reconstructed content (including all ids, optional and
unknown fields), and rechecks the source checksum before committing. Repeating
an unchanged source is a no-op; a changed source is refused, even after later
changes on the new side. A no-op never resets live state to the imported state.

`ui-cookie.key` stays a file, copied byte for byte with exclusive creation and mode
0600; a different destination key is refused. An interrupted import can leave that
same key behind, harmlessly; retry accepts it. No secret is re-minted. Token
hashes, session bindings, passkey public keys/counters and push keys survive exactly.
Missing optional token/session files mean empty stores. A source session file
requires its cookie key; malformed documents fail rather than silently signing
people out. No import runs automatically at startup.

After all pieces are imported, start the new server on the new home and verify
sign-in and stdio continuity. This importer never deletes or rewrites old data;
reverting means restarting the old server on the untouched old home. Context and
commons stores and other key files must be copied as part of the overall move;
they are not app tables and are not imported here.

## Old-to-new mapping

| Old state | New rows |
| --- | --- |
| household.json | household_settings, household_agents, household_members |
| tokens.json / tokens.used.json | household_tokens / household_token_use |
| ui-sessions.json sessions, links, challenges, passkeys | corresponding household tables |
| ui-sessions.json push | household_push |
| ui-sessions.json per-member preferences/read marks | household_readers |
| ui-sessions.json first-owner preferences/read marks and remaining metadata | household_settings envelope |
| pieces/*/settings.json | household_piece_settings |
| ui-cookie.key | byte-identical key file |

The command/route/job replacement table, next-mode authentication, owner operations,
generated clients, offline continuity and Setup screen remain tracked by t-2203.

## Stdio metadata composition (new side)

`src/continuity/household.ts` is the explicit read-only metadata seam for the
new stdio composition. `readContinuityHousehold(home, agent?)` reads an existing
`loom.db`, chooses the named agent or household default, and returns ownership,
context and commons paths. Each call closes its connection and takes a fresh
snapshot; it sees committed WAL data while a daemon is up, too. It never opens
old JSON, migrates tables, creates app records, or runs jobs. SQLite may create
its WAL/SHM sidecars for a read-only connection; immutable mode is deliberately
avoided because it can miss a daemon's committed WAL.

`continuityTarget({home?, agent?, contextDir?})` makes the composition explicit:

- A home without a context chooses the named agent or household default.
- An explicit context inside that home's `agents/` chooses that registered
  agent, including through symlink aliases; an unknown agent is an error.
- An explicit standalone context needs no app database. It takes precedence
  over the home/agent selection.
- A missing database, absent schema or inconsistent household rows fails
  loudly when a household was selected. An import receipt never selects a
  backend, and contradictory old JSON has no effect.

This is a composition prerequisite, not the completed stdio cutover. Existing
`householdOf`, `contextFromHome`, CLI and MCP entry points still behave exactly
as before. The next stdio composition must pass this metadata to identity's
Owners block, knowledge and people paths, with end-to-end two-agent and
standalone identity/memory/knowledge/people tests before its entry point ships.

The People/Owners consumers now accept explicit selection too:
`createLoomServer({contextDir, peopleSelection})` passes a trusted
`{household, agent}` snapshot to every person tool, the Owners block and the
identity room cards. `readContinuityHousehold` supplies that shape directly.
Passing `null` selects only the standalone context; omitting the property
retains legacy JSON discovery. Selection stays per server, with no global path
registry or environment changes. Person ensure/merge helpers accept the same
selection for later new-side route composition. The room reader closes its
explicit store and keeps its existing rendering limits and failure handling.

Knowledge tools now also accept explicit selection (`knowledgeSelection` on
`createLoomServer` and `registerKnowledgeTools`). Every call, including freshness,
uses the selected commons or standalone database without JSON discovery or the
legacy knowledge-path environment override. Omitted selection preserves existing
callers. Maintain receives the explicit People selection for its person-page
check; isolation checks inspect the selected knowledge path, including hard links.

This still does not enable a new stdio entry point: the remaining server household consumers must be composed explicitly before that
entry point is exposed. The new MCP continuity tests cover two simultaneous
agents' Owners and room cards, shared directory/private relationships,
standalone override beside legacy JSON, and an agent-scoped merge with the
other agent's relationship database unchanged.

Conversation list/view readers accept `conversationSelection: {household, agent}`
(or `null` for standalone) on `createLoomServer`. Explicit readers use the
context's conversation records and core's generic render, with core venue labels
or the recorded venue name. They never discover installed venue pieces, open the
legacy venue registry, or run an external renderer. Omitted selection preserves
legacy venue rendering. `homeFor` also accepts the selection for subsequent
composition. This slice does not change the house conversation gate, digest,
profile, Comms, or project-hub composition, and exposes no new entry point.

During the remaining memory cutover, explicit knowledge isolation checks both
`<contextDir>/memories.db` and the active legacy memory environment override.
An override cannot hide a hard link between local memory and selected knowledge;
the active legacy store also remains protected. Memory tools still need explicit
routing before the new stdio entry point can ship.

Project hubs accept the same explicit People and conversation selections. Their
People section uses the selected commons and private relationships; their
conversation section reads local digest-backed records with core venue labels.
With an explicit conversation selection (including standalone `null`), the MCP
hub does not discover installed-piece feeds or open the legacy Comms app for
filed threads. A caller may supply its own `pieceSections` source explicitly.
Omitted selections retain the existing app-backed behavior. This is another
reader prerequisite; the stdio entry point remains unchanged.

Vector-backed memory tools accept `memorySelection: {agent}` (or standalone
`null`) on `createLoomServer`, passed to their optional final selection argument
and `createBackend(contextDir, selection)`. The context determines the private
store; the trusted selection bypasses `LOOM_SQLITE_DB_PATH`. Omitted selection
retains that override. The backend cache remains keyed by resolved database path,
so selected agents keep separate handles while callers selecting the same store
share one handle. Remember, recall, list, update, forget, prune, similarity, audit,
archive/restore, merge and revision tools all pass the selection.

The same selection now reaches raw tape reads (episodes and conversation
digests), salience reads/recomputation and the proposal queue, including the
ratified memory write and staging-row deletion. Identity forwards it to tape,
Top of Mind and its private project card. Low-level tape/digest options expose
`memorySelection`; proposal helpers take a final selection argument. People
metadata selection remains independent. Omission preserves legacy overrides.

This is still a prerequisite: project-hub memory readers and other conversation
readers/writers need explicit routing separately, and the server's household
gates still use legacy discovery. No entry point selects this configuration yet.
Keep the local-and-active isolation guard until the entire memory path is
explicit; this change does not enable the stdio cutover.

Explicit offline servers now refuse `describe_self`, `comms_title` and
`comms_thread` before discovering a legacy household or Comms store. These are
app operations and require the daemon API; stdio metadata is not authority to
change a profile or read thread words. A local offline `conversation_digest`
still records continuity in the context, but does not infer a project from an
app-backed thread or nudge the old app. Project inference from the local
conversation's venue links stays available. Omitted selection keeps legacy
behavior. Remaining conversation store path selection and the entry-point
acceptance test are still required before next stdio is exposed.

| Old MCP app behavior | Explicit offline replacement |
| --- | --- |
| describe_self updates old household profile | Refused; use the daemon's profile operation when available |
| comms_title reads and changes the old Comms thread | Refused; use the daemon API |
| comms_thread reads old thread words | Refused; runtime delivery to the bound body replaces transcript reads (web-foundation.md) |
| digest uses old Comms project fallback and nudges old attention | Local continuity digest only; app project fallback and app notification are dropped offline |

### Selected conversation storage

Conversation SQL helpers accept the existing optional `MemorySelection`, including
turns, digests, findings, needs, project-name resolution and retention. Explicit
selection uses the context's `memories.db` and ignores `LOOM_SQLITE_DB_PATH`;
omission retains the legacy override. Venue/household selection stays independent
of memory selection. MCP conversation lists, views, findings, digest writes and
the project hub forward both selections where needed.

| Existing path | Explicit offline composition |
| --- | --- |
| Conversation list/view/findings read the global memory override | Selected context's records, including nested digests, stats and open asks |
| Digest writes and project aliases use the global memory override | Selected context's digest and project tables |
| Project conversation section reads the global memory override | Selected context's conversations; missing store means no section |

The stdio entry point is still unchanged. This is storage routing, with no new
app authority, schema change or import requirement.

### Explicit next stdio entrypoint

`loom mcp --next --home /path/to/home [--agent art]` now composes every
per-server selection from `continuityTarget`. Omitting `--agent` uses the
row-backed default. `loom --next --home /path/to/home` is the equivalent
stdio shorthand. For a portable standalone context, use
`loom mcp --next --context-dir /path/to/context`; it needs no app database.
An explicit context outside a supplied household home is standalone, as in
`continuityTarget`. Unknown in-house agents and missing household metadata fail.

These explicit flags supply the target; legacy `LOOM_HOME`, `LOOM_AGENT`,
`LOOM_CONTEXT_DIR`, memory/knowledge path overrides and `LOOM_IDENTITY` do not
select it. No import receipt or discovered file enables next stdio. Without
this opt-in the executable retains its old CLI and stdio behavior, including
legacy environment resolution. `loom serve --next` remains the daemon command.

The entrypoint reads household metadata once and closes that connection before
serving MCP. In-process transport acceptance tests run two agents and a
standalone context together after the old household/token/session JSON has
been removed, and repeat with contradictory old files. They exercise identity,
Owners, memory write/list/recall, shared knowledge and directory cards, and
private relationships; the app database remains byte-identical. Both local
and active memory/knowledge isolation guards remain in force. App-only tools
retain the explicit offline refusals described above.

| Old invocation | Explicit new-side invocation |
| --- | --- |
| bare `loom` using legacy context/environment discovery | `loom mcp --next --home HOME [--agent AGENT]` |
| bare `loom` with a standalone context | `loom mcp --next --context-dir CONTEXT` |

During the final coordinated move, update the harness's stdio arguments to the
explicit new-side invocation after import verification. This PR performs no
host or harness rollout. Earlier sections describe the incremental reader
slices; this section supersedes their pending-entrypoint status.

### Scoped agent ownership

`household.setOwnedAgents({person, agents})` replaces an existing scoped member's
owned-agent list. It is a household-owner operation through the central policy;
a scoped owner cannot administer it. Agents must already belong to the household.
Duplicates collapse, ordinary members may own none, and imported scoped owners
retain their role and must still own at least one agent. Unknown member fields
and project memberships survive. The write and its retry result commit together;
`core.access` refreshes open windows immediately to evict lost agent records.

| Old owner action | New operation |
| --- | --- |
| Change a scoped member's owned agents (`setMember`) | `household.setOwnedAgents` |

This operation does not create members or promote/demote household owners; those
operations remain separate. Keeping wildcard ownership unchanged also keeps the
first household owner and existing credential bindings unchanged.

### A member's project list

`household.setMemberProjects({person, projects})` replaces one existing member's
explicit project assignments in one transaction. Only a household owner may call
it. Every project must exist; duplicates collapse and an empty list clears all
assignments. Each affected project keeps its other members, agents, repositories
and unknown fields. Household membership and agent ownership stay as they were.
The operation emits each changed `household.project` and `core.access` after the
write and retry receipt commit, refreshing open windows immediately.

| Existing action | New operation |
| --- | --- |
| Set a project's member list | Existing `household.setProjectMembers` |
| Edit all project assignments for one member | `household.setMemberProjects` (new member-oriented form of the same project lists) |

There is no old command or route for member project lists: projects are the new
sharing boundary in web-foundation.md. This operation uses the existing project
rows, with no second list stored on the household member. It neither creates
members nor changes owner authority or credentials. Setup and the generated
household client remain tracked by t-2203.

### Registering an existing agent

`household.addAgent({agent})` registers an existing portable context under
`HOME/agents/<agent>`. Only a household owner may call it. The name follows the
existing lowercase agent-name format; the context and its `agents` parent must
be real directories, not symlinks. Missing contexts and files are refused. An
already registered agent is a successful no-op, matching the old CLI helper.
The operation leaves the default agent, members, ownership, projects, unknown
metadata, context contents and credentials intact. Wildcard household owners
own the new agent automatically; scoped members gain no ownership. Registration,
its retry receipt and live sharing/access notifications commit together.

| Old command or route | New operation |
| --- | --- |
| `loom household add <agent>` | `household.addAgent({agent})` |
| Page `add-agent`: register its newly bootstrapped context | `household.addAgent({agent})` |
| Page `add-agent`: bootstrap identity/rules, choose appearance, create first token | Separate setup and credential operations; not part of registration |

There is no registration job. This operation creates neither a context directory
nor a creed or token. The Setup screen and generated CLI binding remain in the
full household task; the legacy command and page retain their existing behavior
until the coordinated move.

### Members and household ownership

`household.setMember({person, agents})` adds a member or replaces their ownership,
including `agents: "*"` for household ownership. `household.removeMember({person})`
removes membership. Both require a household owner through central policy; a
scoped owner cannot call them. At least one wildcard household owner must remain.
New members have role `owner`, matching the old page action; existing ordinary
members keep their role for scoped lists and become owners on wildcard promotion.
Scoped owners must own at least one agent. Agent references must already exist.
Setting membership requires an active, exact People directory entry, read through
the next-mode People operation; a missing directory, archived entry or redirect
slug cannot create household authority. Removal needs no directory entry.
Unknown household/member fields and project assignments are preserved.

| Old page action/helper | New operation |
| --- | --- |
| `member-set` / `setMember` | `household.setMember` |
| `member-remove` / `removeMember` | `household.removeMember` |

When the first wildcard owner changes, every unbound owner-token row is pinned to
its original person in the same transaction as membership and the retry receipt.
Explicit member bindings and other token roles stay unchanged. Removed members'
tokens and browser sessions fail authentication immediately; narrowing retains
the same member identity with the reduced scope. Revoked token rows are pinned
too so no later first-owner fallback can reassign them. Existing credentials are
not deleted. As on the old side, re-adding the same person restores their retained
credentials and project assignments. Removing a person is not credential revocation;
use the sign-in revoke operation when credentials must stay disabled.

Both operations emit sharing and access changes after commit, refreshing open
windows synchronously. No membership job, People-directory write, session mint or
legacy-file write is added. Setup and generated clients remain in the full task.

### Generated household API client

`loom-household <operation> '<json-object>'` is an opt-in client for next mode.
The operation registry and client share the command list and response schemas in
`src/core/household/commands.ts`. Set `LOOM_URL` to the daemon's HTTP(S) origin
and `LOOM_TOKEN_FILE` to a file holding the caller's token. The client never
selects a home, opens a database, discovers JSON or repeats policy decisions.

```
loom-household addAgent '{"agent":"new-agent"}'
loom-household setMember '{"person":"guest","agents":["art"]}'
loom-household setMemberProjects '{"person":"guest","projects":["pond"]}'
```

The commands are `setMember`, `removeMember`, `addAgent`, `setMemberProjects`,
`setOwnedAgents`, `setAgentAccounts`, `createProject`, `setProjectMembers` and
`setProjectAgents`. Each calls the operation of the same name in `household`.
Success prints the operation's JSON value and exits 0; daemon refusal or transport
failure prints a fixed diagnostic and exits 1; malformed invocation exits 2.
Help works offline. An elapsed four-second retry budget spans brief daemon
restarts; individual requests are capped at 1.5 seconds. Retries reuse the exact request body and operation id, so a
lost response cannot repeat the write. Redirects are refused.

| Existing action | Client replacement |
| --- | --- |
| `loom household add <agent>` | `loom-household addAgent '{"agent":"…"}'` (success is the JSON agent list instead of `Agents: …`) |
| Page member add/change/remove | `loom-household setMember` / `removeMember` with operation JSON |
| Page scoped ownership, project assignments and account metadata | Corresponding `setOwnedAgents`, `setMemberProjects`, `setAgentAccounts` operations |
| Project creation and membership | `createProject`, `setProjectMembers`, `setProjectAgents` |

The JSON command spelling is the operation name; there is no second command
parser in the daemon. No old invocation is replaced automatically. Token and
session clients, remaining household commands (show/init/commons/sprite/icons),
agent bootstrap/setup and the Setup screen remain work under t-2203. This client
adds no job and performs no installation, import or host rollout.
