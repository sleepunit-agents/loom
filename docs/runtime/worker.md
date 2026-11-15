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
Children receive only the configured environment; the worker's ambient credentials
are not inherited. Keep the configuration and token file private.

The builder receives one JSON line on stdin with `job` (the id) and `house`
(`repository`, `file`, `branch`). It writes only `{"build":"<artifact>"}` to
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
| `runtime.next` | `{}` | assignment or `null` |
| `runtime.started` | `{job, build}` | `{ok:true}` |
| `runtime.heartbeat` | `{job, state}` | `{active:boolean}` |
| `runtime.finish` | `{job, exitCode, logTail}` | `{ok:true}` |

A single slot runs one job at a time. Idle or abandoned attempts wait five seconds.
Heartbeat rejection cancels local work. An exception stops the slot, including
failed process cleanup, so it cannot claim more work after uncertain reaping.
SIGINT and SIGTERM cancel active work and idle waiting. The server owns start
retries and silence reconciliation.

The fresh `sharedRoot` mounts these four authenticated runner operations on the
same shared connection and write/receipt boundary. Only a live runner token's
machine may claim or report its jobs; caller-supplied machine identity is refused.
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
