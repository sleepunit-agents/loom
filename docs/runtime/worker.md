# The worker program

`loom-worker <configuration-file>` is the separate work-plane program. It calls
loom's operation door; it does not open loom's database or start inside its server.
This executable requires POSIX process groups (use WSL on Windows).

The configuration is JSON. For example, with locally supplied builder and runner
programs:

```json
{
  "url": "https://loom.example",
  "box": "workshop",
  "tokenFile": "/run/loom-worker/token",
  "build": {
    "command": "/opt/house-builder",
    "args": [],
    "cwd": "/srv/worker",
    "env": {"PATH": "/usr/bin:/bin"}
  },
  "runners": {
    "claude": {
      "command": "/opt/body-runner",
      "args": [],
      "cwd": "/srv/worker",
      "env": {"PATH": "/usr/bin:/bin"}
    }
  }
}
```

The programs in this example are placeholders for worker-local commands, not
bundled adapters. Harness keys match the roles configured in loom. A model name
does not select a harness implicitly. Credentials belong in the private token
file or the explicit environment needed by a command, never in command arguments.
Worker-local command children receive only the configured environment; the worker's ambient credentials
are not inherited. Keep the configuration and token file private.

The builder receives one JSON line on stdin with `job` (the id) and `house`
(`repository`, `file`, `branch`). When the configured repository needs a secret,
loom checks the assigned starting worker and its startup permission, then sends
`repositoryInput: {encoding: "base64", value: "…"}` on that same private stdin.
The builder decodes it for repository access and must not print or persist it.
It is absent for public repositories. Credentials never enter command arguments,
the assignment, build results or environment; the worker erases its input buffer
after the build settles. It writes only `{"build":"<artifact>"}` to
stdout, with diagnostics on stderr, and exits zero. Build stdout is limited to
64 KiB. The runner receives one JSON line with `job` (the full assignment) and
`build`, after loom acknowledges that the process is running. The assignment
includes the brief, agent, conversation, model, account and harness. The runner
must translate this envelope into its harness's invocation; it must keep bodies
in its process group until completion. Any surviving descendants are killed
when the command leader exits. The last 16,384 characters of output become the
job's log tail; do not print secrets there.

The worker sends a bearer token through loom's standard operation door. Only
HTTPS origins are accepted, except HTTP on loopback. Redirects are refused.
Each request has a unique operation id, a 30-second deadline and 1 MiB limits on
request and response bodies. Calls are never retried locally after uncertainty.
The server's authenticated runner door must derive the machine from the token,
claim only assigned work, and implement:

| Operation | Input | Value in the standard success envelope |
| --- | --- | --- |
| `runtime.health` | `{facts?}` | `{ok:true}` |
| `runtime.next` | `{}` | assignment or `null` |
| `runtime.started` | `{job, build}` | `{ok:true}` |
| `runtime.heartbeat` | `{job, state}` | `{active:boolean}` |
| `runtime.finish` | `{job, exitCode, logTail}` | `{ok:true}` |

A single slot runs one job at a time. Idle or abandoned attempts wait five seconds.
Heartbeat rejection cancels local work. An exception stops the slot, including
failed process cleanup, so it cannot claim more work after uncertain reaping.
SIGINT and SIGTERM cancel active work and idle waiting. The server owns start
retries and silence reconciliation.

The fresh `sharedRoot` mounts these authenticated runner operations on the
same shared connection and write/receipt boundary. The canonical current bearer
runner proof supplies the machine identity; runner-labelled cookies are refused.
Only that live machine may claim or report its jobs; caller-supplied machine identity is refused.
It receives model roles from the trusted root's `modelRoles()` configuration,
never from a worker request. A root without configured roles leaves work queued.
`runtime.next` and heartbeat receipt replays are refused, so an old claim or
`active:true` cannot restore a finished job. The worker already uses a fresh id
for each call and never retries an uncertain request. Other report receipts are
checked against current machine/job authority before replay.

The root owns the silence sweep and closes it on shutdown. Terminal source
notifications run after the job effect and receipt commit. Private Comms briefs
and log words do not enter assignments, job storage or receipt fingerprints;
ephemeral private input and current-body credentials need their separate door.
Native harness adapters and switching an installed server to the fresh root are
separate work; an executable and root factory alone do not deploy a worker.

## Container bodies

Add `"container": {"socket":"/run/docker.sock"}` to the configuration to run
each body in its built image through the local Docker Engine API. The builder
still runs as the configured worker command; its `build` result must name an
image already present on that engine. The runner's command, arguments, directory
and explicit environment apply **inside** the image. The image must contain a
runner that consumes the same JSON envelope. This mode does not supply native
harness adapters, account profiles, startup secrets or tool-denial enforcement.
Docker retains environment values baked into the image; configured values
override matching image keys. The worker's ambient environment is never copied
into the container. Images and their baked settings are trusted house material.

The worker creates a uniquely named non-TTY container, inspects its mounts,
attaches its pipes, then starts it. Image-declared volumes and any other
unexpected mounts cause rejection and removal before starting. It releases
the assignment on stdin only after loom's running
acknowledgement. It requests GPU devices only for `run.gpu`; it publishes only
the assignment's explicit TCP address/port pairs, mapping each to the same port
inside. It uses the `runc` runtime, disables privileged mode and automatic port
publishing, and disables Docker's persistent log driver. Output is streamed into
the bounded in-memory log tail. A failed capability request fails the launch;
there is no fallback to a host runner or a container with broader settings.

Nested containers additionally require a local `container.nestedSocket` path.
Only assignments with `run.nestedContainers` receive that socket at
`/var/run/docker.sock`. This is broad authority over that configured engine;
the local operator must deliberately opt in. No socket or host directory is
otherwise mounted. The worker never discovers a socket or credentials from HOME
or the ambient environment.

`container.setupTimeoutMs` and `container.cleanupTimeoutMs` each default to
30,000 and accept integers from 1 through 300,000. Setup bounds create, attach
and start together. A running body has no time limit. After either output ends
or Docker reports an exit, the cleanup deadline bounds waiting for the other.
Cancellation removes the container forcibly with a separate cleanup deadline,
including after an uncertain start response. The worker waits for removal
acknowledgement before reporting completion or allowing a start retry. Failed
removal stops the slot. Requests are not retried. A lost create response can leave
an inert, never-started container if creation completes after cleanup; its unique
name and `loom.job`/`loom.agent` labels identify it for operator reconciliation.

The wire format follows Docker's [Engine API](https://docs.docker.com/reference/api/engine/version/v1.56/)
create, attach, start, wait and remove endpoints. The worker uses the explicitly
configured local Unix socket and unversioned routes; it does not start or install
an engine.

### Worker-local account runner bindings

A shared `runners` command can implement account selection from the startup JSON
itself. For separate local profiles or private runner commands, configure
`accountRunners`, keyed first by the account ID and then by harness:

```json
{
  "accountRunners": {
    "subscription-a": {
      "codex": {
        "command": "/private/runner-a",
        "args": [],
        "cwd": "/work",
        "env": {"ACCOUNT_PROFILE": "/private/profile-a"}
      }
    }
  }
}
```

When this map is present, every job needs an exact account/harness entry. Missing
entries fail before the builder or body starts; they never fall back to the shared
runner or another account. Plans are copied when the worker executor is created.
The builder retains its own explicit environment, and the body receives the
selected command's environment plus the existing account/model/harness startup
envelope after the running acknowledgement. The same selection applies to
container entrypoint, arguments and environment. Container paths refer to files
inside its trusted image; this adds no host credential/profile mounts.

These bindings select a configured runner. That program must still implement its
native harness's model choice and tool restrictions; this feature does not infer
provider CLI flags or supply an account profile that is not locally configured.

## Home current-job selection

The shared GraphQL door mounts `currentJobs(agent: String!)` for an agent's Home
card. It returns only current job ID, agent, title, state, assigned box ID and
queue time, ordered by queue time and ID. Terminal attempts disappear. Execution
briefs, logs, account identities, build details and repository settings are not
query fields.

The query reuses the published agent/project/private-member SQL policy used by
Approvals and bridge conversation labels: household owners see every job;
private member jobs require that member or a household owner; other jobs are
visible through an owned agent or project membership. Retained reads use current
sharing facts. HTTP buffers and live socket publication use the same existing
freshness fence as other shared selections. This field is available to the Home
UI; its rendering is a separate consumer.
The projection does not grant write or worker authority.

## Machine-reported facts

An optional `facts` array in the worker configuration reports capability labels,
for example `"facts":["gpu:5090","os:linux"]`. These are explicit local worker
configuration; the worker does not probe a GPU or infer facts from a model name.
Each poll sends the configured snapshot through `runtime.next`. Loom derives the
machine from the current bearer runner proof, records the report, refreshes
health and uses the facts for placement in that same committed operation.
Report-only machines can report facts and health but receive no job.

Reports replace only that machine's previous `from_owner=false` facts. Labels set
by its owner survive, including labels also reported by the worker. Omitting
`facts` preserves the previous report; an explicit empty array clears only the
machine-reported labels. No other machine's labels change. A report accepts at
most 128 distinct trimmed nonempty single-line labels, each up to 256 characters.
Invalid configuration is refused before token reads or execution. Poll replay is
still refused, so an old receipt cannot overwrite newer facts; receipt failure
rolls back facts and health along with any job claim.

## Private body bootstrap

A runner command may set `"bodyBootstrap":true` when its fixed child implements
the private bootstrap envelope. Ordinary envelope commands receive no body token.
The parent completes the build and observes child spawn, then generates a
`body_` token locally and calls the canonical `runtime.enrollBody` metadata door
with only `{job,fingerprint}`. This requires the coordinator's enrollment door;
it does not create another issuer in the worker or return raw bytes from Loom.
The metadata acknowledgement must be `{registered:true}`.

After the ordinary running acknowledgement, stdin contains
`{job,build,bootstrap:{origin,job,token}}`. The child must keep bootstrap out of its
model prompt, argv, environment, stored configuration and diagnostics. The raw
token belongs only to that current job. The parent erases its byte buffer after
stdin acceptance and on cancellation/failure. A late enrollment or running
acknowledgement never releases private input after cancellation. Uncertain
enrollment is not retried.

Credential-bearing body output is drained without keeping a job log tail in
both process and container adapters. The outer worker also sends an empty tail,
including for an injected adapter. Body replies and tool cards use their private
current-body producers instead. The parent transport alone does not execute a native model: its configured
child must implement the envelope and use the canonical body/Secrets clients.
The fixed Claude receiver below connects this envelope to native execution and
the body client; other native harnesses and the full body lifecycle remain part
of the machines/models task.

### Fixed Claude child

loom-body <configuration-file> implements that private envelope as a separate
worker child. Opt the exact account/harness runner into bodyBootstrap:true;
its command is the fixed loom-body entry, with its configuration filename as
the only argument. Its configuration is {"command":"/path/to/claude","cwd":"/house"}.
The worker's explicitly configured account environment reaches the child and
native CLI; no ambient worker environment is added.

The child takes mail through the canonical body client into its own context,
confirms acceptance, then invokes Claude with the assignment's exact model.
Always-denied tool patterns and applicable outside/unknown guest-only patterns
go into native --disallowedTools. A household person's missing outside tier
does not make that person a guest. The CLI uses dontAsk permission mode,
an empty settings-source list, no unrelated MCP servers, and no persisted native
session. Calls needing interactive native approval are refused.

The child publishes a reply only with the observed main assistant response model,
and records observed tool-action models separately. Requested, initialization,
usage-map, synthetic, aborted and subagent model values never stand in for that
response. Native diagnostics stay private. Serialized status beats keep work reported;
a Stop cancels native execution and suppresses its reply. A failed status beat
also stops the body. The parent still owns and reaps the
whole process group.

This initial Claude entry handles one private Comms mail batch and its response.
The claim includes its current Comms thread identifier when that reply surface
exists. The child refuses assignments without it before startup inputs or native
execution; this routing metadata never replaces the Root's current body proof.
Other venues need their own receiving/output adapter and remain unfinished.
The in-child bodyProgram.startup extension point precedes mail/model input;
startup Secret alias retrieval is a separate integration. Codex, additional
Comms tools and multi-turn question/wait handling remain unfinished.

## Outside tiers and tool denials

`POST /api/runtime/agentBodyPolicySet` uses the ordinary `{id,input}` envelope:

```json
{"agent":"art","people":[{"platform":"discord","workspace":"server-id","user":"user-id","tier":2}],"deniedTools":[{"pattern":"Bash","guestsOnly":true},{"pattern":"Write","guestsOnly":false}]}
```

Current agent owners, including co-owners, replace these two lists atomically
with their receipt. Current ownership is rechecked on cached replay; runner,
agent and service principals cannot edit them, and a household owner role alone
is insufficient. Each list has at most 128 distinct entries. Outside-person keys
include platform, workspace and user, with tiers 1, 2 or 3. These keys configure
how the agent treats outside people; they never establish household identity.
Workers derive each job's senders from its actual stored bridge receipts rather
than trusting message words. A claim receives only its current senders' tiers.

Tool patterns have 1–512 characters, cannot begin an option dash or contain NUL or
line breaks, and can apply to all work or only guests. The same pattern may have
both rules. The native receiving adapter applies the current denial rules; a
claimed assignment keeps its snapshot across later settings edits. Failed writes
preserve both lists, and replay never reinstates an earlier configuration.
Configuration neither runs a model/provider nor changes the household policy.

Outside workspace and user identifiers are preserved exactly, without trimming.
Workspace/user identifiers must be nonblank and control-free. Tool patterns keep
literal spaces; leading/trailing control characters and whitespace padding do not
bypass their raw character or length checks. Option dashes after leading whitespace
are rejected too.

## Agent house settings

`POST /api/runtime/agentRunSettingsSet` uses the ordinary `{id,input}` envelope:

```json
{"agent":"art","houseRepository":"https://example.com/house.git","houseFile":"Housefile","houseBranch":"next","nestedContainers":false,"gpu":false,"boxes":["workshop","attic"],"ports":[{"address":"127.0.0.1","port":9000}]}
```

Current agent owners configure their house, ordered preferred machines and allowed
listening ports. The existing agent setup policy applies, including current
ownership on receipt replay. Runner, agent and service principals cannot edit it;
a household owner role alone does not replace agent ownership. Preferred machines
must be enrolled, unrevoked and visible to the configuring member, or explicitly lent to the
agent. Listing a machine does not grant permission to run there. An empty preference
list holds work until a machine is configured.

Repository references cannot contain URL passwords, HTTP user information, queries
or fragments. The
house file is a relative path inside the repository. Machine and port lists are
distinct and bounded at 128 entries. Ports use literal IPv4/IPv6 addresses and
integer ports 1–65535. This command preserves the existing Secrets-owned repository
credential reference; secret aliases and grants stay with Secrets.

All settings and the receipt commit together, followed by an existing Tempo
capacity notification. Rollback preserves previous settings and cached replay
does not apply the change again. First house setup wakes settled mail. Each job
keeps the house repository/file/branch recorded at admission. Worker claims use
current preferred machines, ports and capabilities; enabling GPU after admission
also requires a GPU-capable machine. Already claimed assignment snapshots stay
unchanged. Configuration does not execute a builder or model provider.

Listening IP addresses are normalized before uniqueness checks and storage, so
equivalent IPv6 spellings cannot configure duplicate endpoints. House reference
text rejects control characters, including tabs that a URL parser would remove.

## Owner machine settings

An authenticated current machine owner (or current household owner) sends
`POST /api/runtime/boxSettingsSet` with the ordinary `{id,input}` envelope:

```json
{"box":"workshop","name":"Workshop","hostsAny":false,"reportOnly":false,"alwaysOn":true,"agents":[{"agent":"art","lent":true}],"facts":["rack:attic"]}
```

This replaces hosting flags, explicit agent permissions and owner-supplied facts
atomically with the command receipt. Machine ownership, enrollment, heartbeat and
revocation are not writable fields of this command. Missing/revoked machines,
unknown agents, duplicate entries and another live machine's name are refused.
Runners, agents and services cannot change this setup. A committed change notifies
the existing capacity lifecycle; receipt replay and rollback do not notify again.

Worker-reported facts remain separate from owner labels. Adding an owner label
promotes an overlapping report to owner authority, so subsequent worker reports
cannot erase it. Report-only workers continue health reporting and always-on
outage detection but never claim agent work. Lending an explicit agent does not
grant its owner access to the machine registry or machine settings.

The lent flag is true for another member's agent and false for the machine owner's
agent. The command checks this against current ownership. An existing explicit
non-lending row cannot authorize a foreign agent after ownership changes. Remove
an agent from the explicit list to withdraw that permission.

## Command discovery inside a receiving body

The current body can call `POST /api/runtime/commandCatalog` with the ordinary
`{input}` envelope. Empty input lists code-defined HTTP command names and write
flags; `{name:"conversation.status"}` returns that command's structural JSON
input schema from its registered Zod definition. Input transforms and refinements
remain enforced by the actual command; the structural hint does not replace
validation or imply permission to invoke it.

Discovery returns no household records and invokes no discovered command. Direct-only
operations are excluded. Bare agent, member, runner and service credentials cannot
inspect this catalogue; the existing current conversation/body scope applies,
including job lifetime, machine revocation, current conversation linkage and
private ownership. A still-bound waiting body may inspect it. Calling a discovered
command uses the normal HTTP operation door and current permission checks; the
catalogue grants no worker control, private read access or household authority.

## Stop while preparing a body

Claiming a private Comms job marks its thread as working while the worker prepares
its repository and house. Starting heartbeats refresh that metadata. A thread Stop
for that exact starting job atomically ends it as stopped, consumes the request,
and returns inactive to the assigned worker. The normal worker cancellation path
aborts a pending repository-consent wait; it does not build, launch a body, send a
finish report or create a start retry. Untaken mail remains held by the stopped
attempt until fresh mail resumes work.

The terminal job and heartbeat receipt commit before Tempo is notified. A failed
receipt preserves the previous active job and Stop request, while cached heartbeat
replay cannot restore active authority. Running-body Stop remains with the receiving
body's status protocol. Preparation changes the thread working indicator, without
inventing a reported agent status or consuming another conversation's Stop.

## Machine registry

An authenticated member registers their own machine with
`runtime.boxCreate({name,sameMachineAsLoom})` through the normal HTTP command
and stable receipt. A new machine starts in report-only mode, with hosting and
always-on alerts disabled; its owner configures those independently through
`runtime.boxSettingsSet`. Registration issues no credential. Runner credentials
are issued by canonical Sign-in for the recorded machine.

The machine owner or a current household owner can call
`runtime.boxRevoke({box})`. Revocation retains job history and immediately
withdraws existing machine/body credentials through the normal current-credential
checks. It cannot restore a revoked machine or transfer ownership. A replacement
may reuse the visible name, but receives a different machine ID. Neither command
accepts an owner, token, heartbeat or caller-chosen enrollment timestamp.

## Body command/read consumer

`bodyCommandClient` calls the existing Root HTTP operation and generated GraphQL
doors using only the receiving body's existing credential. Callers supply a stable
operation ID; uncertain writes are never retried automatically. Current Root policy,
input validation and receipts remain authoritative. A command name cannot change
the destination origin or select a different credential or caller.

Requests are limited to one MiB of UTF8 JSON and responses to sixteen MiB, with
a bounded request deadline (15 seconds by default, at most 30). Redirects, malformed
JSON/UTF8, invalid response envelopes/statuses and accidental Root-bearer echoes
are refused with a generic error. Command failures keep Root's structured result;
GraphQL validation errors remain generated read errors.

The client shares the private bootstrap's origin validation. Abort/close cancels
pending work and erases owned partial response bytes at the cancellation point;
completed requests erase received chunks and retained byte copies. A late response
is cancelled, and a closed client starts no further requests. Native tool
composition is a subsequent step using this consumer in the body-local MCP server.

The constructor snapshots its credential and origin; later reuse of the options
object cannot change request authority or the echo check. It requests identity
content encoding, rejects unnegotiated coding, and requires a declared content
length to match the received UTF8 bytes. Echo checks include every JSON string,
even an escaped value discarded by a duplicate property. Final lifetime checks
after response completion prevent cancellation from publishing decoded data.

GraphQL responses validate standard error locations, paths and extensions. HTTP400
is accepted only for errors without a data entry; partial execution data and its
errors remain HTTP200 results. Loopback HTTP includes localhost,127.0.0.1 and::1.
The client rejects whitespace or controls in its fixed bearer before Fetch can
normalize a header. A GraphQL errors entry is nonempty whenever present.

## Composing native tools

`bodyProgramTools` projects three standard MCP tool descriptors and a call callback
for the receiving body's one local MCP listener: `loom_commands`, `loom_command`
and `loom_query`. It starts no listener and supplies no new credential. Discovery
uses the registered Root catalogue, command calls keep stable caller IDs and
current Root permissions, and reads use the generated GraphQL schema. This
projection is a composition port; the native listener/CLI wiring is separate.

Mail confirmation, observed model/latency telemetry and Stop acknowledgement stay
with the receiving runtime. The model cannot supply those fields or invoke the
private take route. Successful status reports notify the runtime so its heartbeat
can preserve the reported waiting status; a returned Stop request invokes the runtime's
Stop callback before publishing a tool result. Request cancellation closes only
that call, while body close cancels every current and future call.

Native model tools report only working/waiting while a turn is live. Idle/offline
reports and Stop acknowledgement belong to the receiving runtime after execution
ends, so a model cannot clear the working flag or remove the live Stop control.

A member-private conversation reports its actual status state, but its progress
words never enter the global agent status row. That row is shared with other
owners of the agent: working and waiting use “Working privately” and “Waiting
privately”; idle and offline use an empty work description. Public conversation
progress keeps its reported words. Receipt rollback and replay preserve the same
transaction boundary as other conversation output.

runtime.proposeBoxSettings files a private chat request for the machine owner or
a household owner. Its card includes the current and proposed name, hosting
flags, agent lending and owner facts. Allow rechecks the current member's
authority, machine ownership/revocation, the full previous owner settings,
lending and name uniqueness. Worker-reported facts are independent of that
comparison. The direct owner command and approved operation share validation and
application; no worker credentials or enrollment are issued by either.

The default receiving program also accepts wake and handoff conversations.
Their canonical Inbox mail is accepted before native execution. Completion
records a wordless reply turn with the observed model and a digest summary
bounded to 600 characters. These venues do not create a Comms thread or message;
Discord and Slack retain their guarded bridge reply path.
