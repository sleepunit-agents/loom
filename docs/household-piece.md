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

## First run and the old in-place conversion

Start a brand-new household with `loom serve --next --home NEW_HOME`.
First sign-in initializes the household's OS owner, publishes the complete neutral
`assistant` context and prints a short-lived sign-in link. It creates no agent
bearer token. After signing in, Setup can create named agents with their own
creed/rules, deliberately mint a first token, and show the explicit next-mode MCP
configuration. An initialized or imported household is never re-scaffolded on
restart; edited identity files and deliberately missing preference files survive.

The commons needs no conversion for a fresh household. Knowledge and the People
directory use `HOME/commons/knowledge.db` and `HOME/commons/people.db`;
relationships use each agent's private `memories.db`. Empty stores are created by
their normal writers. There is no old combined card or agent knowledge database
to move or split, and no requirement to populate stores merely to sign in.

The old `household init AGENT` moved `HOME/AGENT` into `HOME/agents/AGENT`,
left a compatibility symlink, and moved existing knowledge. The old
`household commons` moved knowledge and split combined person cards. Those
**in-place conversion commands are retired on the new side**, rather than being
run implicitly or routed through a remote API. They mutate portable continuity
files and require a stopped source; a daemon API client cannot safely rearrange
another machine's source directory. The temporary symlink was for the old harness
path during the earlier phased rollout. Next stdio instead selects an explicit
home/agent or standalone context, so that compatibility path is unnecessary.

This disposition does not retire standalone operation:
`loom mcp --next --context-dir CONTEXT` still uses that portable context without
an app database. It also does not claim that the household importer promotes an
unsplit standalone context into a shared household. That importer accepts the
existing household file format; it neither moves contexts nor changes which
person fields are shared. Existing households carry their already-split commons
and agent contexts through the final coordinated move alongside the app import.
An unsplit standalone source stays standalone; no automatic conversion or guessed
merge of several knowledge stores is offered. The old executable retains its
existing commands until the coordinated retirement of the old side.

| Old first-run action | New-side choice |
| --- | --- |
| Initialize a new household | `serve --next` first sign-in, then Setup |
| Move an existing standalone context and leave a symlink | Retired; explicit standalone stdio remains supported |
| Implicitly move knowledge or split combined People cards | Retired; fresh stores already have the separate layout; no automatic standalone promotion |
| Import an existing household's app records | Explicit `migrate household`; continuity files are separate move inputs |

This is a command disposition, with no change to record scope, member authority,
source data or migration behavior. Startup/retry and stopped-default-MCP witnesses
are in `src/core/signin/operator.test.ts`; agent creation/configuration witnesses
are in `src/core/household/bootstrap.test.ts`; standalone and multi-agent stdio
acceptance is in `src/continuity/stdio.test.ts`.

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

The [command/route/job inventory](household-contract-inventory.md) maps each old
household command and page action to its implemented replacement or explicit
gap, including sign-in and offline continuity. Full Setup, credential
administration and settings coverage remain tracked by t-2203.

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
be real directories, not symlinks. Missing contexts and files are refused. Prepared contexts need a nonempty regular `IDENTITY.md`; bootstrap-marked contexts must finish through their original creation request, so registration cannot bypass publication recovery. An
already registered agent is a successful no-op, matching the old CLI helper.
The operation leaves the default agent, members, ownership, projects, unknown
metadata, context contents and credentials intact. Wildcard household owners
own the new agent automatically; scoped members gain no ownership. Registration,
its retry receipt and live sharing/access notifications commit together.

| Old command or route | New operation |
| --- | --- |
| `loom household show` | `loom-household show '{}'` (the same home/agents/default/optional owner summary, as JSON instead of aligned text) |
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

The commands are `show`, `setMember`, `removeMember`, `addAgent`, `setMemberProjects`,
`setOwnedAgents`, `setAgentAccounts`, `createProject`, `setProjectMembers` and
`setProjectAgents`. Each calls the operation of the same name in `household`.
Success prints the operation's JSON value and exits 0; daemon refusal or transport
failure prints a fixed diagnostic and exits 1; malformed invocation exits 2.
Help works offline. An elapsed four-second retry budget spans brief daemon
restarts; individual requests are capped at 1.5 seconds. Retries reuse the exact request body and operation id, so a
lost response cannot repeat the write. Redirects are refused.

| Existing action | Client replacement |
| --- | --- |
| `loom household show` | `loom-household show '{}'` (the same home/agents/default/optional owner summary, as JSON instead of aligned text) |
| `loom household add <agent>` | `loom-household addAgent '{"agent":"…"}'` (success is the JSON agent list instead of `Agents: …`) |
| Page member add/change/remove | `loom-household setMember` / `removeMember` with operation JSON |
| Page scoped ownership, project assignments and account metadata | Corresponding `setOwnedAgents`, `setMemberProjects`, `setAgentAccounts` operations |
| Project creation and membership | `createProject`, `setProjectMembers`, `setProjectAgents` |

The JSON command spelling is the operation name; there is no second command
parser in the daemon. No old invocation is replaced automatically. Token and
session clients, remaining household commands (init/commons/sprite/icons),
agent bootstrap/setup and the Setup screen remain work under t-2203. This client
adds no job and performs no installation, import or host rollout.

`show` is read-only and restricted by the central household-owner policy. It
projects only the legacy summary fields; arbitrary imported metadata, membership,
settings and credentials are never part of its response. The home is the daemon
home, independent of the client environment. No retry receipt is written.

## Member preferences on the new side

`household.preferences({})` reads the calling member's Appearance and Accessibility
choices. `household.setPreferences({...choices})` patches them and publishes a
member-private `household.preferences` record (`id`, `member`, `prefs`). Neither
operation takes a member argument. The existing central member policy also
excludes household owners from other members' preferences. There was no old CLI
for these choices; the shell controls and applying the record in the new shell
remain pending.

The row keeps the old look/mode and tiling spelling; responses normalize `000h`
to Daylight or Low Light and `tiling: false` to `oneWindow: true` unless the latter
was explicitly chosen. Updates preserve other choices and unrelated reader state;
`at` is a strictly increasing server millisecond version. Imported first-owner
choices remain in the session envelope, other members use their reader rows.
When the first owner changes, only preferences rotate between those locations
in the same membership transaction, keeping each person's choices private.
Core's ordinary same-id retry returns the original receipt without applying an
older choice again; after removal, fresh reads and writes are denied.

### Shell appearance controls

The next shell's Appearance menu reads the member-private preference Live record
and writes patches through `household.setPreferences` on the shared socket.
Look (Neon Noir, Low Light, Daylight), reduced motion, higher contrast and zoom
apply to every open window. Follow-device motion/contrast continue responding
to device changes. Missing choices use the existing defaults; local storage
warms first paint and is overwritten by the member's server record, including
when they have no saved choices. Denied access resets these applied choices.

Controls wait for Live data and disable during a save or disconnection. Values
change only when the authoritative record arrives; errors are shown, and an
unavailable save can retry the original request id. The legacy Appearance
endpoint and page are unchanged. The existing shell browser test covers two
windows and captures the open menu at 390, 1280 and 1920 in Neon Noir and Daylight
under the CI shard's `artifacts/next-shell/` directory.

| Old Appearance action | New shell behavior |
| --- | --- |
| Choose look | Appearance → Look, patch `look` |
| Reduce motion / Higher contrast | Appearance selectors, patch `motion` / `contrast` |
| Allow zoom | Appearance checkbox, patch `zoom` |

Ground, sound, pixel faces/icons, haptics and one-window layout still require
shell integration. Their stored backend choices remain supported; this menu
does not claim those features are complete. Setup screenshots remain a separate
delivery under t-2203.

## Household Setup preview

`/p/setup-preview` is the household owner's member/agent administration screen.
It subscribes to the existing owner-only `household.sharing` record and
`household.project` feed and calls the same household operations as the generated
client. The sharing projection now includes the default agent and a whitelist
of each member's person, role and owned agents; arbitrary imported membership
fields and credentials are excluded. No permission rule changes.

The screen edits ownership, adds/removes members, replaces a member's project
list, registers an already prepared agent context and edits GitHub attribution.
Ownership and removal forms require an explicit confirmation. A successful
change appears in other windows through Live. Loading/disconnection disables
writes, loss of owner access removes the forms, and errors appear on the page.
An uncertain write blocks further changes and retains its original retry handle
even if the app is docked or navigated away from in that window.

| Existing action | Setup control |
| --- | --- |
| `member-set`, `member-remove` | Add member, Save ownership, Remove member |
| Member's project assignments | Save projects |
| Register existing agent context | Register existing agent |
| Agent account attribution | Save accounts |
| Project creation and full lists | Open Project sharing |
| Person directory creation | Open People |

This is not complete agent bootstrap or complete Setup: first token/harness
snippet, read-only identity, health/backup,
profile and artwork still require their replacements. Registration explicitly
does not create an identity or token. No legacy editor or detached program is
called. The one Setup browser test uses two windows and captures this actual
screen in Neon Noir/Daylight at 390, 1280 and 1920 pixels under
`artifacts/household-setup/` in CI; these images document the implemented controls,
not the remaining agent-bootstrap screens. No live move is performed.

### Token and session administration clients

`loom-token` and `loom-sessions` are explicit new-side API clients, generated
from the same command/response declarations the daemon registers. Both require
`LOOM_URL` (an HTTP(S) origin) and `LOOM_TOKEN_FILE`; neither opens local app data.
They accept a command and a JSON object. Help exits 0, malformed invocation 2,
refused/unavailable requests 1, and successful commands 0.

```
loom-token list '{}'
loom-token create '{"role":"agent","agent":"art","label":"house build","service":"build","house":"house"}'
loom-token create '{"role":"owner","member":"jonathan","label":"operator"}'
loom-token revoke '{"label":"house build","withPasskeys":true,"withDevices":true}'
loom-sessions list '{}'
loom-sessions revoke '{"ref":"0123456789abcdef"}'
loom-sessions revoke '{"label":"screenshots"}'
```

Creation prints the bearer alone, once, for redirection to its destination.
It never retries or stores its response in the operation journal. If the reply
is lost, list tokens and revoke the named token before deliberately minting a
replacement. List/revoke return JSON metadata instead of the legacy aligned
text; no digest, raw session ID, credential key or push endpoint is returned.
Revocation uses the normal stable operation ID and can retry a lost response.
HTTP API replies use `Cache-Control: no-store`.

| Old command behavior | New operation / disposition |
| --- | --- |
| token create: agent, service/house suffix, owner | `token.create`; owner requires an explicit member; agent must already belong to the household |
| old peer, piece, runtime and review token roles | Not minted: next policy has member, agent, runner and service viewers. Old piece/peer gates and runtime token routes belong to the withdrawn architecture. Runner/service minting requires an explicitly active `signin.setPrincipal` entry; minting does not activate or grant it |
| token list | `token.list`, safe metadata including role, member, lifecycle and passkey origin label |
| token revoke with optional passkeys/devices | `token.revoke`; plain revoke leaves descendants/devices; compromise follows passkey ancestry and removes affected push rows atomically |
| sessions list | `sessions.list`, 16-hex refs, labels, device, sign-in method, issued/seen dates and ended status |
| sessions revoke ref / agent label | `sessions.revoke`; ambiguous refs refuse, labels match agent/headless sessions only; associated push subscriptions stop |
| token link | Existing explicit next-mode sign-in link command; unchanged |

These operations and the owner-only `signin.admin` Live snapshot use the central
household-owner policy. They do not implement Account's own-person passkey/device
screen or Setup's first-token/bootstrap UI; those remain in the inventory.
The generated clients deliberately use JSON instead of maintaining a second
legacy flag/parser/formatter contract. Existing unflagged CLI behavior stays on
the old side until the coordinated move.

### Setup tokens and sessions

The owner’s `/p/setup-preview` shows the safe `signin.admin` Live snapshot and
creates member, agent or already active runner/service tokens through the shared
browser socket. The same operation/policy is used by the generated clients.
Creation uses a single-send data-layer call: it refuses offline, never queues or
replays after connection loss, and offers no retry. A lost reply may have committed;
check the list and revoke its label before deliberately creating a replacement.
The bearer is held only by the creating mounted screen, hidden on connection or
access loss, leaving the active Setup tile (including Home/minimize), or Hide token. It is never a Live record or retry receipt.
Other windows see only metadata. Token revocation confirms the label and optional
passkey/device cascade; session revocation confirms a safe unique session ref.
Token revocation includes an opaque stable ref, so an old row or confirmation cannot revoke a replacement that reused its label. Expired rows lose their revoke action at the server-clock deadline. Only a nonsecret attempted-label recovery breadcrumb survives a lost mint or navigation.
Those revocations retain the shared same-id retry handle across navigation.
No clipboard or local-storage copy is made. First-token bootstrap and own-person
Account controls remain separate inventory entries.

### Last use

Next sign-in records accepted bearer requests and browser requests in the row
stores. The session-status route also records browser use; accepted incoming
Live messages refresh use for an already open socket. Token `last_used` uses
server ISO time, throttled to once a minute per digest; session `seenAt` uses
server seconds, throttled to five minutes. Persisted timestamps preserve the
throttle across restarts. Neither timestamp extends credential expiry.

Pure credential checks, admin-list reads, idle sockets and background access
refreshes do not record use. Failed credentials, failed cookie CSRF and rejected
socket upgrades do not record use. Diagnostic writes are best effort and atomic;
a busy store does not reject a valid credential. Changed usage publishes the
existing safe owner-only `signin.admin` snapshot, without `core.access` churn or
new records, commands, jobs or schema changes.

### Creating an agent from Setup

Setup's Create an agent form calls `household.bootstrapAgent` (also available in
`loom-household`) with short name, display name, purpose, voice, rules and when
to ask first. Only a household owner can create a context. It writes the existing
voice-neutral scaffold, preferences and self-model in a private directory,
flushes every file and publishes through exclusive directory reservation and file links before registering the complete context.
Existing agents, directories, links and files are refused; no overwrite option
is offered. Existing household metadata, projects and credentials are retained.

The filesystem and SQLite cannot commit together. A private context receipt binds
publication to its original viewer, operation id and input fingerprint. If the
row or retry-receipt commit fails, registration and events roll back; only that
same request can adopt the byte-identical context after restart. A changed
context refuses recovery. Hidden staging directories left by abrupt interruption
are inert and never registered. Interrupted reservations without a complete receipt, or with unresolved staging hard links, refuse recovery rather than adopting an unproven context. After a receipt is published, an original-request retry can finish missing files with exclusive links, checking every existing byte first. No automatic deletion of abandoned contexts is
performed. Successful same-id retries return the ordinary stored result without
rewriting an agent's later preferences or creed.

After creation the existing single-send token form selects the new agent and a
first-token label. The owner deliberately creates and saves that bearer; context
creation neither mints nor journals a secret. Token failure/recovery, hiding and
revocation are the same as the token controls above. Setup shows a JSON MCP
snippet using `loom mcp --next --home HOME --agent AGENT`, with the home on the
machine running MCP. It works while the daemon is stopped; the token is for
remote API access, separately. No harness or host config is installed by Setup.

This flow creates an agent in an initialized household. Fresh-household ownership
and offline `household init`/commons migration remain in the inventory, as do
appearance/profile/health controls. Setup does not edit existing identity files.

### Fresh next-mode household

Starting `loom serve --next --home NEW_HOME` on a fresh private home creates the
OS-user-bound household owner and a complete `assistant` context before printing
the existing five-minute first sign-in link. The context contains a voice-neutral
identity, preferences and self-model, using the same exclusive publication,
flush and recovery checks as Setup. The owner can sign in, deliberately mint the
assistant's first token, or use Create an agent for a named agent with their own
purpose, voice and rules. No token is implicitly minted for the context.

The initial context and household/link rows cannot commit together. Failed row
or audit writes leave no registered household or usable credential. Restart may
recover only the unchanged publication bound to this OS uid and initialization
version. Missing files in an interrupted initial publication fail closed; startup
does not recreate a deleted orphan file. Such incomplete reservations remain
unregistered and require explicit recovery outside this flow. Existing directories refuse adoption. Once initialized, startup never
recreates or rewrites an agent's files, including a missing or edited identity.
A stopped daemon still permits the default `loom mcp --next --home NEW_HOME`
identity load. Existing imported households are unchanged.

This closes the fresh-start missing-context gap. It does not move an old
standalone directory, create a compatibility symlink, or split old knowledge and
People into commons. Those explicit offline migration deliveries remain in the
replacement inventory; this is no claim of a complete old `household init` or
`commons` replacement.

### Your account

`/p/account-preview` provides member-private passkey and browser management.
`account.read` and the `account.self` Live record contain only the caller's safe
passkey/session metadata. The central member scope excludes other members even
for a household owner; there is no member selector. Opaque action references
never expose credential ids, public keys, token digests, cookie ids or push
endpoints. Duplicate token digests with conflicting membership fail closed.

The screen registers named passkeys through the existing fresh-session,
same-origin/CSRF WebAuthn routes. Removal confirms an exact key reference;
`account.removePasskey({ref, withMade?})` removes its credential and revokes its
dedicated token, ending the browsers it opened. Descendants are retained unless
selected; selected cascades follow digest ancestry within the same member only.
Legacy keys without a dedicated token lose just their credential, matching the
old removal path; their shared sign-in token is never revoked accidentally.
A reference binds both credential id and token, so a stale confirmation cannot
remove a newly registered replacement. `account.revokeSession({ref})` ends one
own browser and removes its notification devices atomically. Both writes use
normal stable-id retries; failed writes roll back credentials and receipts.

All windows refresh through Live, including expiry and access changes. The screen
hides private data on access loss, disables disconnected/inactive edits, confirms
removals and retains uncertain write retries across navigation. The existing own
logout route signs out this device. The generated `loom-account read '{}'`,
`removePasskey '{"ref":"…","withMade":true}'` and `revokeSession '{"ref":"…"}'`
use the same command/response declarations and bounded API-only retry binding
as the token/session clients. There was no legacy Account CLI; these are explicit
new-side commands, with JSON output and the same 0/1/2 exit convention.

This replaces Account's credential list/removal controls, not its notification
subscription/test controls. Push, backup and artwork reconciliation remain in
the inventory; device links and profiles are described below. Registration, sign-in and
logout keep their existing cryptographic/CSRF policy. No schema, job, legacy
route adaptation or host installation is added. Account's single browser test
uses two windows and actual virtual-authenticator WebAuthn registration; CI
captures 390/1280/1920 Neon Noir and Daylight in `artifacts/household-account/`.

### Agent profile descriptions

`household.profile({agent})` and agent-scoped `household.profile` Live records
project the imported `about` description and an unexpired `aboutAsk` timestamp,
without returning the household envelope or reading an identity file. Only callers
who can see that agent through central policy can read its profile.

An agent’s owners use `household.setProfile({agent,text})` to set/clear a description
(up to 600 normalized characters), or `household.requestProfile({agent})` to ask
for one. Both have Setup controls, available to scoped owners for their agents even without household administration. Central policy’s agent-setup action supplies this authority. The authenticated agent answers with
`household.describeSelf({text})`: no agent selector, at most 300 characters and
two sentences, only once during the next 24 hours. Blank replies refuse without
consuming the request. Owner edits close an open request. Future or expired imported
timestamps grant no answer. Reads/expiry use the daemon clock, with Live expiry
scheduled at the request deadline; no poller or external job is added.

These operations mutate the existing household envelope, preserving unrelated
metadata and other agents' descriptions. Mutation, request consumption, retry
receipt and notification commit together. Retrying a committed answer returns
its original result without overwriting later owner words. Setup keeps the
original uncertain request handle and disables inactive/offline edits and retries.
Neither an edit nor a request changes a creed. Explicit offline `describe_self`
continues to refuse app writes; the daemon exposes `household.describeSelf` over
its registry MCP endpoint. Generated `loom-household profile`, `setProfile`,
`requestProfile` and `describeSelf` use the same schemas (JSON argument/output).

| Old profile action | Next replacement |
| --- | --- |
| `about-set` (including Setup description) | `household.setProfile`; empty text clears and closes the request |
| `about-ask` / Regenerate | `household.requestProfile`; server-timed 24-hour request |
| Agent `describe_self` | Authenticated daemon `household.describeSelf`; same once-only request/length/sentence rules, no caller-selected agent |

The existing single two-window Setup browser test edits, requests and observes an
agent reply through Live, and captures the profile section at all three widths in
Neon Noir and Daylight. CI supplies these screenshots; no local browser run is
required or claimed. Push devices/delivery and backup remain separate inventory gaps.

### Sign in another device

Account offers a single-use ten-minute link for the signed-in member. Setup offers
the same control for each member to household owners. `signin.browserLink` is an
ephemeral socket operation for authenticated cookie windows only. The resolver
attaches an in-memory proof of the exact source session to the authenticated viewer;
input cannot name a source session or supply a sign-in time. Central own-member
policy allows self links and existing household-owner policy allows another member.
The receiving browser inherits the earlier of the source session's issued and
signed-in times, including through repeated hops. A stale browser cannot manufacture
a fresh session to register a passkey for itself or another person.

| Old action | Next replacement |
| --- | --- |
| Account `signin-link` | Account's “Sign in another device”, `signin.browserLink({})` |
| Members `member-link` | Setup member control, `signin.browserLink({member})`, household owner only for another member |
| `loom token link` | Existing bearer-only `signin.link` / explicit command; intentionally fresh operator sign-in |

The operation has no durable retry receipt, and the browser uses `callOnce` (no
queue or reconnect replay). A lost response can leave an unseen link that expires
within ten minutes. The displayed URL remains only in the active connected screen
and clears on Hide, navigation, loss of access or connection. Screenshots show the
controls with no URL displayed. GET shows a confirmation form without consuming or
reflecting the code; POST consumes it once. The existing row-backed importer,
passkey freshness check and link spend route stay in use; no migration, job or
generated command is added for a capability that specifically requires a browser.


### Next notification worker

The new-side service worker can display push notifications and handle taps. It
shows a fixed `loom` title and an empty body, even if a payload contains a thread
title or message words. This deliberately uses less lock-screen detail than the
old worker: current Comms candidate bodies include a private thread title. The signed-in
page shows the detail after a tap. Tags retain notification replacement behavior.

A tap opens the payload's same-origin URL, including next Comms thread routes or
Inbox keys. Invalid, external and credential-bearing URLs fall back to Home. An
existing loom window is navigated and focused; if it closed, another window or a
new one is used. No private response or push payload is added to a cache.

This is the display/tap part of the old worker contract only. Imported push rows
do not yet trigger new-side delivery: test sending, daemon dispatch, per-member eligibility revalidation,
deduplication, rate limits and staging are still pending. The old SessionStore
and push watcher are never called. No migration or live rollout is needed for
this worker change; finish those remaining operations before the final move.


### Next notification devices

`notifications.read` and the member-private `notifications.devices` Live record
return only opaque device/session references, trusted session device labels and
second-based first/last registration times. Even household owners see only their
own devices. `notifications.remove` removes one own device and remembers its
endpoint hash, bounded to 100 tombstones. Retrying a committed removal does not
remove a later re-enabled device.

Cookie-window-only `notifications.key`, `notifications.subscribe` and
`notifications.unsubscribe` replace GET `/push/key`, POST `/push/subscribe` and
POST `/push/unsubscribe`. The key operation lazily retains the existing imported
VAPID pair and returns only its public key. Subscription credentials go directly
into existing `household_push` rows, never into records or receipt results.
Trusted Signin resolver proof supplies session, token and device label; a member
Viewer alone, a bearer alongside a cookie, an agent session and a headless
session cannot register. Inputs cannot select a member, session or device label.
Only known HTTPS push services with bounded URL-safe keys are accepted; URL
credentials, nonstandard ports and fragments are refused.

Devices survive ordinary logout, cookie expiry, session eviction and later
sign-in. Quiet `again` refreshes a same-member device without resetting its first
registration time, but cannot undo removal or take another member's device.
Explicit enable clears a tombstone and can reassign a shared tablet, resetting
its first registration time. The household cap remains 20 bound devices, oldest
last-seen first; unresolved import evidence does not take active device capacity.
Existing Account/session/compromise revocations still remove associated rows.

Member-less imported devices resolve through their retained token (or retained
session's token), including revoked token records; all records for that digest
must agree on an owner. Existing membership edits pin unbound owner tokens before
first-owner rotation. Orphans or conflicting bindings are retained as import
evidence and omitted from member records; they are never reassigned to the new
first owner. Turn notifications on explicitly on the device to bind it anew.
No schema, importer or old-side change is needed.

| Old surface | Next replacement |
|---|---|
| `/push/key` | `notifications.key`, cookie window, public key only |
| `/push/subscribe` | `notifications.subscribe`, trusted cookie proof, explicit/quiet registration |
| `/push/unsubscribe` | `notifications.unsubscribe`, own-member removal only |
| Profile's notification device list / `push-remove` | `notifications.read`, `notifications.devices`, `notifications.remove`; Account live device list and confirmed removal |
| `push-test` | `notifications.test` queues a staged own-device test; Account button pending |
| legacy push watch | Pending daemon job; never call SessionStore/watch from next |

These are page operations; no previous notification CLI needs replacing. The
Account controls and browser subscription API are implemented below. The staged
test-send backend is implemented at the end of this page; its Account control
and routine daemon dispatch remain part of t-2203 before the final move.


### Account notification controls

Account reads member-private `notifications.devices`, shows opaque device and browser
references together, and requires confirmation for `notifications.remove`. Its browser
control uses the existing next worker registration and cookie-only notification
operations. Existing browser subscriptions are quietly registered once per window;
a remembered removal turns the local subscription off instead of resurrecting it.
Explicit Enable requests browser permission and can bind a shared tablet anew.
Turn off waits for a definite server unsubscribe reply before discarding the local
subscription. Standard browser `expirationTime` is accepted by the operation.

The window-lifetime browser flow retains each original mutation handle across
navigation and unavailable replies. Retry sends the original id/input and resumes
that flow; a late key or browser reply after leaving the active connected screen
cannot start another registration step or automatically restart quiet reconciliation. Return and explicitly Enable to finish an invalidated flow. Inactive/offline/denied views cannot write.
No subscription endpoints or keys appear in the device list. Account shares its
mutation lock with passkey/session changes. CI extends the single two-window
Account acceptance using a fake browser Push API with real cookie/socket operations,
Live updates and six notification-focused images. It does not contact a push host.

The Account test-send control queues an exact device request and shows member-private Live outcomes. Routine dispatch remains pending. Registering
a device alone does not send notifications. The existing worker display/tap behavior is unchanged.

Quiet reconciliation intentionally runs automatically, rather than asking for a
click to restore an already-enabled browser. This is a narrow exception to the
app guide's event-handler request pattern: a window-lifetime controller owns its
once-only guard, shared mutation lock and stable retry handle, outside React.
Replaying the screen effect cannot create another reconciliation request.
Entering while another mutation is uncertain waits for that same request to settle.
The browser adapter rechecks activation after its worker lookup and immediately
before calling the browser's subscribe API.

### Staged test notification sender

`notifications.test({ref})` is a stable-id write on a real, signed-in cookie
window. It queues one own device's opaque reference and returns `{id,state:
'queued'}`. The member-private `notifications.test` Live record reports queued,
sent, gone, failed, uncertain or cancelled; queued is an acknowledgement, not a
delivery claim. The request and retry receipt commit together. A new
`notifications_tests` table contains only member/device references, a binding
fingerprint, time and status, never subscription bytes or VAPID secrets.

The daemon uses the same member resolver and subscription validator as device
registration. Each accepted registration gets a unique generation, including same-second
remove/re-enable with identical subscription bytes. Each request binds that
exact device and imported VAPID pair at
submission and resolves them again before sending. Every attempt claims its
stable `notifications:test:<id>` effect outside the operation transaction.
Staging holds it for `core.releaseEffect`; startup resumes held/queued work,
but interrupted attempts become uncertain and are never automatically resent.
Shutdown stops admission and waits for in-flight IO. An absolute 15-second
daemon-clock deadline aborts the owned HTTPS request, even if the service keeps
trickling response data. Web-push still encrypts and signs the request; the
transport drains responses without retaining diagnostics.
A fresh explicit request is needed after failure or uncertainty. At most twenty
requests per member may remain queued at once.

Payloads have fixed `loom` title, empty body and `/p/account-preview` destination.
Sent means the push service accepted the request, not that the device displayed
it. A 404/410 removes only the exact unchanged subscription; a late reply cannot
remove a re-enabled or reassigned device. Other service responses are failed;
transport errors are uncertain. Errors and stored results contain no external
diagnostics. The next device is resolved afresh after every awaited send.

This replaces the backend of Profile's `push-test` action. Its Account button
and Live status UI remain pending, as does routine announcement dispatch. There
is no new notification CLI, no old SessionStore/watch call and no secret migration.

### Account test notifications

Each device has a deliberate **Send test notification** action on the shared Account
mutation slot. An uncertain reply retains the original handle, operation id and exact
device input through navigation; Retry resends that handle. A receipt means queued,
then its id and device reference join `notifications.test` Live status. History remains
visible after a device is removed. Sent means push-service acceptance, never device
delivery. Unknown attempts are not resent automatically. Denied feeds hide retained
private outcomes; offline or inactive screens disable sending. No subscription,
endpoint or key is rendered. The existing CI-only two-window Account acceptance uses
an injected fake transport with real cookie/socket/backend/Live and captures the six
notification-focused screenshots. No new CLI or backend operation is introduced.

### Routine notification daemon

The new daemon samples current Inbox asks through Attention's metadata-only role
and unread, not-in-front replies through the real Comms role every minute. Both
roles apply current central member policy; no service grant or credential is
created. Source words are never copied into the job records or payload. The
worker still displays a fixed loom title and empty body; taps open the exact
Inbox ask or private Comms thread on the new side.

The first sample seeds the existing candidates without sending a backlog.
Thereafter the daemon admits at most five candidate/member pairs per rolling
minute; excess candidates stay unmarked until a later sample. Each pair is
deduplicated durably, including when there are no devices, so subscribing later
does not deliver old work. This deliberately makes the old per-member expansion
explicit and preserves its global five-per-minute limit. Imported old push-watch
markers remain evidence in the household envelope; the new-side baseline owns
its new candidate keys and never resumes the old watch or imports its timer.

Admission records the exact current devices and their binding hashes in new
`notifications_announcements` and `notifications_announcement_attempts` tables.
Each device attempt has a stable `notifications:announcement:` effect id and
passes the common staging gate immediately before IO. A release resumes only
that attempt. Startup resumes held/queued work, while interrupted effects become
uncertain and are never automatically resent. No new operation or CLI is needed
for this daemon job; the existing core release operation controls staging.

Before each send, including after every preceding awaited send, the daemon
re-reads the current candidate, member policy, subscription validator, member
binding, registration generation and VAPID pair. Withdrawn candidates and changed
devices cancel rather than being silently rebound. A 404/410 removes only the
unchanged exact device; other responses fail and transport errors are uncertain.
Errors contain no service diagnostics. A daemon-clock absolute fifteen-second
abort deadline bounds each request, and close stops admission and drains IO
before SQLite closes. Sent means service acceptance, not device delivery.

The old watch's process lease and SessionStore timer are retired: next mode has
one owned in-process daemon. Existing deliberate test sends use the same exact
binding resolver and abortable transport. Tests use startLoom, synthetic data,
the fake clock and fake transport; there is no real push or host change. Account
screens and their existing CI screenshots are unchanged by this backend unit.
