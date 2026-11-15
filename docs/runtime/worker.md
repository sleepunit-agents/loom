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

This document describes the executable and adapter seam. Production mounting of
the authenticated runner operations is separate composition work; the presence of
the executable alone does not make a configured worker operational.

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
