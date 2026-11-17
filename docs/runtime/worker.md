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

A worker runs several jobs side by side, each in a slot of its own. `slots` in
its configuration says how many, from 1 to 16; left out, it is 4 for a worker
with container bodies and 1 for one whose bodies are processes (see "Several
jobs at once"). Each slot runs one job at a time and asks loom for its next when
it is free; loom itself keeps no count of a machine's jobs. Idle or abandoned
attempts wait five seconds.
A heartbeat loom answers with `active: false` cancels local work at once. One loom
does not answer at all (a timeout, a dropped connection) is sent again at the
next interval: loom needs one report in its two-minute silence interval, so the
worker gives a job up only when none has been answered for so long that loom
will have taken the job for lost. Before, a single unanswered heartbeat ended
the job, and a machine busy with a long build lost jobs that way. An exception stops the slot, including
failed process cleanup, so it cannot claim more work after uncertain reaping; it
stops the worker's other slots too, each of which ends its own body first.
SIGINT and SIGTERM cancel active work and idle waiting in every slot. The server owns start
retries and silence reconciliation.

## Attempts, retries and exit codes

The server decides whether work runs again; the worker never retries a job
itself. The rule lives in `Jobs.retry` (`src/runtime/jobs.ts`).

- One piece of work gets its first attempt and at most three more
  (`JOB_RETRIES`). Each new attempt is a new job row whose `retry_of` names the
  attempt before it, so the chain is the history.
- An attempt is tried again when it failed or was lost (its worker went silent
  for two minutes) before the body started, or when the body started and left
  mail it had not settled. A body that failed after settling its mail is not
  run again.
- That holds for a body that exits 0 too. One that settled none of its own mail
  did not do the work (a machine's own runner is given no credential and can
  never settle any), so it is tried again inside the same chain and its row
  says "Finished without settling its mail". Only a body that exits 0 having
  settled part of its batch, because it took less than the whole to stay
  inside its input limit, leaves the rest as fresh mail for a new job.
- Start retries wait 1, 2 and 4 seconds. Retries after a body has started wait
  5, 30 and 120 seconds, so the chain as a whole lasts longer than a loom
  restart: a body that failed only because loom was restarting gets an attempt
  after loom is back.
- When the chain is used up, the unsettled mail stays with the last attempt and
  shows as failed. Nothing runs until fresh mail arrives in the conversation;
  the next job then takes the old mail with the new.
- A job stopped by a person is never retried.
- A queued job does not wait for ever. One that no machine has taken 24 hours
  after it could first be claimed (`QUEUE_DEADLINE_MS`) is ended as failed with
  exit code 31 and is not tried again. Its mail stays with it and shows as
  failed until fresh mail arrives.

A failed job says where it failed by its exit code, the one field kept for a
private conversation (its log tail is dropped, because output can hold the
conversation's words). The tables are in `src/runtime/job-exit.ts`; job history
shows the stage name beside the number (`JobRecord.exitStage`).

The row also keeps who chose the number (`jobs.exit_by`, `JobRecord.exitBy`),
because a machine's own runner may exit with any of these numbers and mean
something of its own. The worker says it when it reports the job:

- `body`: loom's body program, which the worker knows by having given it a
  body's credential (`"bodyBootstrap":true`).
- `worker`: the worker itself, for a body it could not get running or lost, or
  one a signal ended.
- `runner`: a machine's own runner, which is given no credential.
- `loom`: loom itself, for a job no machine took. No worker can report this one.

A stage is named only when the number is in the table of whoever chose it. A
runner's code is shown as the bare number. So is the code of a job that ended
before the column was kept, or was reported by a worker from before it: nobody
said whose it was, and no stage is guessed.

| Code | Stage | Meaning |
| --- | --- | --- |
| 0 | | Success. |
| 1 | body input | Failed before the body knew what it was asked to do. |
| 10 | body stopped | Not a failure: the body saw a Comms Stop and left. loom records the job as stopped if a Stop really is waiting for it; otherwise the exit is an ordinary failure. |
| 11 | body startup | Startup secrets or other startup inputs. |
| 12 | body mail | Taking and accepting mail. |
| 13 | body identity | Loading the agent's memory identity. |
| 14 | body harness | The native model run. |
| 15 | body record | Recording the answer in loom. |
| 16 | body config | The machine's body file could not be read or is not valid. |
| 17 | body envelope | What the worker handed over on stdin is not a body's input. |
| 18 | body assignment | The assignment names a harness or venue this body cannot serve, or one the harness would refuse. No mail has been taken. |
| 19 | body report | The first report to loom failed: loom unreachable, or the job no longer this body's. |
| 20 | body contact | A later report failed while the body was at work: it lost loom, or loom had ended the job. The body dropped what it was doing, whatever stage that was. |
| 21 | worker input | Fetching the private repository input. |
| 22 | worker build | The build command; or, with container bodies, fetching the house's repository or building its image. |
| 23 | worker launch | Starting the body's process. |
| 24 | worker enroll | Registering the body's credential with loom. |
| 25 | worker release | Handing the started body its input. |
| 26 | worker reap | The body's process could not be watched or reaped to its end. |
| 27 | worker runner | This worker has no command for the job's harness, or none it can hold to the account loom placed the job on (see "Worker-local account runner bindings"), or no sign-in directory for the job's account and harness (see "Worker-local account sign-in directories"). |
| 28 | body tools | The body's own tools server, which the harness is given, could not be started. |
| 29 | body killed | The body did not end by itself: a signal ended its process (the system's memory killer, an operator's kill), or its container was ended that way (a container exit of 128 plus a signal's number). The worker reports it; the body said nothing. |
| 30 | worker house | The house's image does not say how a body of the job's harness starts in it (see "What a house image must say"). The house has to change, not the machine. |
| 31 | loom unplaced | No machine took the job within the queue deadline (24 hours from when it could first be claimed). Nothing ran; the job is not tried again, and its conversation takes fresh mail. |
| 32 | worker build time | The house was not fetched and built within the build limit (`buildTimeoutMs`). The worker reported on the job all the while. |

Any other code is the runner's own (a builder or a custom runner). A job swept
as lost has no exit code; its log tail says in which state it went silent. When
a body ends by itself before the worker could hand it its input, the job carries
the body's own code (for example 16), not the worker's 25.

### When the worker itself stops

The worker program's own exit code is a different thing from a job's. It prints
one fixed line, `Worker stopped: <reason>`, and exits with the code beside it
(`src/runtime/worker-stop.ts`). The line is never the underlying error's words,
which could hold a credential. 0 means it was asked to stop.

| Code | Reason printed |
| --- | --- |
| 1 | an unexpected failure |
| 40 | expected the path of one configuration file |
| 41 | the configuration file could not be read or is not valid |
| 42 | the token file could not be read |
| 43 | the worker could not be set up from its configuration |
| 44 | the state directory is not a private directory of this user |
| 45 | another worker is running on the state directory |
| 46 | a process a previous worker left running could not be ended |
| 47 | the first health report to loom failed |
| 48 | the account usage refresh stopped |
| 49 | a body it started could not be ended, so it takes no more work |
| 50 | the account command did not complete (`--account-usage`) |
| 51 | `--account-signin` was removed; the line says what to use instead (see "Signing in from anywhere" in [`accounts.md`](accounts.md)) |
| 52 | a path the configuration gives to containers, or an engine socket, cannot be used: a mounted directory that is not an existing directory of this user written as its real path, an engine socket that is not an existing socket, a path not written as a plain absolute path, or a mounted directory that overlaps another, an engine socket, the state directory or the token file. The line ends with the configuration key at fault in brackets, for example `(container.mounts.art[1].source)`: a key, never a path (see "Mounted directories" under "Container bodies") |
| 53 | the configuration has a key that a worker with container bodies no longer takes: it builds each house itself from the agent's repository, the image says how a body starts, and mounts are listed by agent. The line ends with the key in brackets: `(build)`, `(runners)`, `(accountRunners)` or `(container.mounts)` (see "Container bodies") |
| 54 | git 2.29 or later, which fetches each house's repository, could not be run on this machine |
| 55 | the directory the worker is installed in cannot give containers the body program: dist/body.js or a package it depends on is not inside it (its packages must be in its own node_modules, as a global npm install puts them) |

A worker that stops cannot report its own end, so loom records the job it held
only as lost ("its worker stopped reporting"). Which stage stopped the worker
is in that machine's log, by this line and code.

Mail that cannot become a job at all (the agent was removed, or has no run
settings or no model) leaves no job row. loom tells the agent's owners why in a
notice, once, and closes the notice when the mail is admitted.

## Several jobs at once

```json
{"slots": 4, "accountSlots": 4}
```

`slots` is how many jobs a worker runs side by side: an integer from 1 to 16.
Left out, a worker with container bodies runs 4 and a worker whose bodies are
processes runs 1. The difference is on purpose. A container worker fetches,
builds and starts bodies itself, and was built to do several at once. A process
worker's build command and runners are the operator's own programs, written for
one job at a time; set `slots` for one when its programs can run beside
themselves. Memory, disk and GPU are not counted: `slots` is the only limit.

What two jobs on one worker never have at the same time:

- **An account, beyond `accountSlots` bodies.** `accountSlots` is how many
  bodies may run on one account at once: 4 when it is left out (or `slots`, when
  that is fewer), and never more than `slots`. Bodies on one account share its
  sign-in, as several sessions of one person do. A job placed on an account
  that is full is claimed, fetched and built, and then waits for one of its
  bodies to end. Two provider programs renewing one sign-in at the same moment
  can leave one of them refused; a machine that sees that sets `accountSlots`
  to 1, which runs an account's bodies one after the other (see "Two bodies on
  one account share one sign-in directory" in
  [`../accepted-tradeoffs.md`](../accepted-tradeoffs.md)).
- **A port** a job publishes on the machine, on whatever address: always one
  body's at a time.
- **A build command**, for a process worker: one runs at a time, and the build
  limit of the next counts from when its turn comes. A container worker builds
  different houses side by side, and builds one image once for every job that
  wants it.

A job that waits is reported to loom as starting all the while, takes what it
needs all at once and in the order jobs asked, and stops waiting when it is
stopped. Only a running body holds a place on an account or a port: a job that
is still building holds neither.

A Stop ends its own job and no other, whether that job is building, waiting or
running; a build other jobs are waiting on goes on. When the worker is asked to
stop, every slot ends its body and the worker exits when each has. As with one
slot, a stopping worker reports nothing to loom for the jobs it held: loom
records each as lost after two minutes of silence and tries its work again.

## What a killed worker leaves, and how the next one ends it

A worker that is killed cannot stop its bodies: each is a process group of its
own, or a container, and goes on running while loom marks the job lost and
queues the work again. So before it reports or claims anything, a worker ends
what the worker before it left on the machine. If it cannot, it does not start.

- The worker keeps a state directory: `state` in its configuration, or
  `loom-worker-<uid>-<hash of box>` under the temporary directory. It must be a
  directory of the worker's user alone (mode 0700); the worker creates it. Each
  body's scratch directory is made inside it, beside a record of the body's
  process group. A build command's process group is recorded too. Records and
  scratch directories are removed when the process ends.
- At start, a recorded process group is killed only when its leader is still
  the recorded process (same pid and same start time). On Linux, every process
  whose environment names a left scratch directory is killed as well, which
  finds a body's descendants after the leader has gone. Scratch directories are
  then removed, with whatever a harness left in them.
- Container bodies carry the labels `loom.job` and `loom.box`. At start the
  worker removes every container labelled as a job of its machine.
- Only one worker may hold a state directory. A second one started on it while
  the first is alive stops with an error.

What this does not cover is listed in `docs/accepted-tradeoffs.md` under
"Running work".

Mail and its answer. A body takes its mail, reports it received (`conversation.accept`:
the sender sees it delivered) and settles it (`conversation.confirm`) only after
the answer is recorded. loom itself settles the mail in the same write as a
thread reply or a bridge reply, so a body that dies after answering cannot have
the mail answered again, and a body that dies before answering leaves the mail
for the next attempt.

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
each body in a container through the local Docker Engine API. The socket must be
there when the worker starts. A worker with container bodies runs any agent's
house with nothing set up on the machine for that agent: it needs the engine,
`git`, and its own configuration.

```json
{
  "url": "https://loom.example",
  "box": "workshop",
  "tokenFile": "/home/worker/.config/loom-worker/token",
  "container": {"socket": "/run/user/1000/podman/podman.sock", "runtime": "crun"}
}
```

Such a worker has no `build` command, no `runners` and no `accountRunners`. A
configuration that has `container` and one of them, or `container.mounts` as one
list, stops the worker with exit code 53 and the key that must go. A machine
with no `git`, or one older than 2.29, stops it with 54.

**How the worker must be installed.** Every container is given the directory the
worker is installed in, and nothing else of it, to run the body program from. So
`dist/body.js` and every package in the worker's own `package.json`
`dependencies` must be inside that directory, in its own `node_modules`:

- supported: `npm install -g`; a release directory or a checkout with
  `npm install` run in it;
- not supported: a project that depends on the worker, where npm hoists the
  worker's packages into the project's `node_modules`; the npx cache; pnpm, which
  links packages in from a store.

A worker installed the second way stops at start with exit code 55: the body
program would fail to load in every container.

### The worker builds a house itself

A job's house is what its agent's run settings say: a repository, the path of a
Housefile in it, and a branch ("Agent house settings").

1. **Fetch.** The worker keeps one bare mirror for each repository under its
   state directory (`houses/`), fetches the job's branch into it with the
   machine's `git`, and reads which commit that is. A mirror holds git's objects
   and nothing that says where they came from: no remote, and no `FETCH_HEAD`
   (which is why git 2.29 is the oldest it runs with). It keeps the eight
   mirrors used most recently.
2. **Find or build.** The image of that repository, Housefile and commit is
   named `localhost/loom-house-<16 hex>:<commit>`. If the engine has it, it is
   used. If not, the worker streams that commit's files (`git archive`) to the
   engine's `/build` as the build context, with the Housefile's path. One build
   runs at a time for one image; a second job that wants it waits for the same
   build.
3. **Start.** The worker reads from the image how a body starts in it (below)
   and creates the container.

The worker never checks a repository out, never reads the Housefile and never
runs anything from a repository. The Housefile is the whole definition of a
house: it must build from what the repository holds and what the engine can pull.
The build context is the repository at that commit and nothing else; submodules
and Git LFS files are not in it. The worker passes no build argument, secret,
host path or socket to a build.

**Only `https://` repositories are fetched.** A job whose house is anything else
(an `ssh` address, a path) fails as a failed build (exit code 22). So does one
whose branch is not a plain name (letters, digits, `.`, `_`, `/`, `-`; no `+`,
`@`, `..` or spaces) or whose Housefile path is not a plain relative one. `git` is run with none of the
machine user's configuration: no stored credentials or helpers, no rewrites, no
hooks, no prompt, no other protocol, no redirects. So a job can never fetch with
the machine user's own access.

**A private repository.** When the agent's house names a repository secret
(`secrets.houseSet`), loom hands it to the worker for that job, and the worker
gives it to that one `git fetch` as a header for the repository's own address.
It is in no command line, not in the mirror, not in the build context or the
image, and in nothing the worker prints or reports. The secret's value is either
`user:password`, or a token alone, which is sent as the password of the user
`x-access-token` (GitHub takes that; where a host wants another user name,
write the secret as `user:token`). A registry that needs a sign-in
for a Housefile's `FROM` is the engine's own to be signed in to.

**While a house builds, the job is not lost.** The worker goes on reporting the
job as starting every 15 seconds for as long as the fetch and the build take.
`buildTimeoutMs` is how long they may take together: 30 minutes when it is left
out, 60 at most. A job still waiting then fails with exit code 32, "the build ran
out of time", and is tried again by loom like any failed start. A house being
built takes one of the worker's slots and no more: a job of another house is
claimed by a free slot, finds its image and starts. With every slot taken,
further jobs for this machine wait in loom's queue; they are not claimed and not
lost.

**What is kept on the disk.** A house image holds no copy of loom, and its name
does not depend on the worker's version, so deploying a new loom rebuilds
nothing. After a build, once the job has its image, the worker looks after the
disk beside whatever it does next: it lists loom's own house images, keeps the
two newest of each house and the ten most recently built in all, and removes the
rest; it never removes one a container uses or one a job holds. It then asks the
engine to remove images that have no name and are older than a day, and build
cache unused for a week. That last request reaches every unnamed image on the
engine, not only loom's (see "A worker treats its engine's unnamed leftovers as
its own to remove" in [`../accepted-tradeoffs.md`](../accepted-tradeoffs.md)).
This upkeep is no job's: it is outside every build's limit, has five minutes of
its own, and runs one at a time. When the images cannot be listed (the engine
does not answer, or its answer is longer than 4 MiB) nothing is removed and the
worker prints `Worker could not look at its house images: old ones stay until it
can`; it looks again after the next build.

### What a house image must say

A house image tells the worker how a body starts in it with labels:

```dockerfile
LABEL loom.house="1" \
      loom.house.node="/usr/local/bin/node" \
      loom.house.body.claude="/etc/loom/body/claude.json" \
      loom.house.body.codex="/etc/loom/body/codex.json"
ENV HOME=/home/agent PATH=/home/agent/.local/bin:/usr/local/bin:/usr/bin:/bin
WORKDIR /home/agent/house
```

- `loom.house` is the version of this contract: `1`.
- `loom.house.node` is the node program in the image, as an absolute path.
- `loom.house.body.<harness>` is that harness's body file in the image (see
  "Private body bootstrap"), one for each harness the house serves.
- The body starts in the image's `WORKDIR`, with the image's `ENV` and as the
  image's `USER`. The worker adds one variable, `LOOM_BODY_SCRATCH=/tmp`.
- The image declares no `VOLUME` and keeps nothing at `/opt/loom`.

The body's command is `<node> /opt/loom/dist/body.js <body file>`. `/opt/loom` is
the directory the worker itself is installed in, mounted read-only: every body
runs the body program of the loom that is running the worker, and no image
carries one. The body program is JavaScript only, so any node that loom supports
runs it.

Everything of this that an image's own description shows is checked before a
container is made of it: the three labels, that their paths are absolute and
plainly written, a `WORKDIR` that is not `/`, and that the image and its base
declare no `VOLUME`. An image that fails one fails that job with exit code 30,
and the job's line names the label or rule, as in `the house image does not meet
the image contract (loom.house.node)`. The worker goes on with its next job.

What the description does not show is checked by nothing: whether the node
program and the body file are really in the image at the paths the labels name.
An image whose node is not there fails when the body is started (exit code 23);
one whose body file is not there fails in the body program (exit code 16).

### The container

The worker creates a uniquely named non-TTY container, inspects its mounts,
attaches its pipes, then starts it. Image-declared volumes and any other
unexpected mounts cause rejection and removal before starting. It releases
the assignment on stdin only after loom's running
acknowledgement. It requests GPU devices only for `run.gpu`; it publishes only
the assignment's explicit TCP address/port pairs, mapping each to the same port
inside. It asks for the `runc` runtime by name, or for `crun` when
`container.runtime` says `"crun"`; no other name is accepted and nothing is
discovered, so the operator states which of the two their engine has. It
disables privileged mode and automatic port publishing, and disables Docker's persistent log driver. The body is
loom's own body program and is handed a credential on its input, so what the
container prints is read and dropped: the body reports for itself. A failed
capability request fails the launch; there is no fallback to a host process or
a container with broader settings. The worker's ambient environment is never
copied into the container.

Nested containers additionally require a local `container.nestedSocket` path.
It must name an existing Unix socket, through a symbolic link or not, and neither
the path as written nor the socket's real place may be at or inside any
directory the configuration mounts. So must `container.socket` itself, which is
never mounted (exit code 52 otherwise, for a relative path too; see "Mounted
directories"). Only assignments
with `run.nestedContainers` receive that socket at `/var/run/docker.sock`. This
is broad authority over that configured engine; the local operator must
deliberately opt in. A job given the engine can ask it to mount anything the
engine's user can reach on this machine, every account's sign-in directory
included: what the sections below say about which container sees which
directory holds for every job that is not given the engine, and for no job
that is. No socket is otherwise mounted, and
no host directory except the worker's own program directory and those the
configuration names (next section). The
worker never discovers a socket or credentials from HOME or the ambient
environment.

### Mounted directories

`container.mounts` lists, for an agent, directories of this machine that every
container of that agent's bodies is given: a little state a house keeps between
bodies, or a read-only mirror of a repository. It is keyed by agent id. A body
gets its own agent's list and no other agent's; an agent with no list gets none,
and needs none to run.

```json
{
  "container": {
    "socket": "/run/user/1000/podman/podman.sock",
    "runtime": "crun",
    "mounts": {
      "art": [
        {"source": "/var/lib/houses/art/stamps", "target": "/house/stamps", "readOnly": false},
        {"source": "/var/lib/houses/art/mirror", "target": "/house/mirror"}
      ],
      "mark": [
        {"source": "/var/lib/houses/mark/stamps", "target": "/house/stamps", "readOnly": false}
      ]
    }
  }
}
```

Beside these, every container is given the directory the worker is installed in,
read-only, at `/opt/loom` ("What a house image must say"). It takes part in the
rules below like a configured directory, except that it need not belong to the
worker's user; when it is at fault the line names "the directory the worker is
installed in".

`readOnly` is true unless the entry says false. The rules below are checked once,
when the worker starts. A configuration that breaks one stops the worker with
exit code 52 before it takes any work. The same rules hold for the sign-in
directories of `accountLogins`.

- `source` is an absolute path to an existing directory that belongs to the
  worker's user. Neither it nor any directory above it is a symbolic link: it is
  written as its real path, with no `.`, `..`, doubled or trailing slash.
- `target` is an absolute path inside the container, written as plainly, and not
  `/`.
- No target is, holds or is inside the target of another directory that can be
  in the same container: another mount of the same agent, a sign-in directory,
  or `/opt/loom`. Two agents' mounts are never in one container and may use the
  same target. None is, holds or is inside `/var/run/docker.sock` or
  `/run/docker.sock` (the same place in most images, where a mount at `/run`
  would hide the socket).
- `container.socket`, and `container.nestedSocket` when there is one, is written
  as plainly and names an existing Unix socket. It may be reached through a
  symbolic link, as `/var/run/docker.sock` is on most machines where `/var/run`
  links to `/run`: the worker follows it once, at start, and the rules below
  hold for the socket as it is written and for where it really is. It need not
  belong to the worker's user. The two may be the same socket. A socket that is
  not there, or not plainly written, stops the worker at start with 52 whether
  or not anything is mounted. That changes two older answers: a missing
  `container.socket` used to stop the worker with 46 when it first asked the
  engine, and a relative one used to be 41.
- No two mounted directories (every agent's mounts, every sign-in directory and
  the worker's own directory, taken together) have sources that are the same, or
  one inside the other. Otherwise a body could be handed another agent's
  directory or another account's sign-in under another name, a read-only
  directory could be written under a second one, or a body could change the
  program every other body runs.
- No mounted directory's source is, holds or is inside either engine socket, the
  worker's state directory (`state`, or its default place) or its token file
  (`tokenFile`). Each of the four is compared both as it is written and where it
  really is, so a body can reach neither the thing nor a link that leads to it. A body that could reach the engine's socket would hold the
  engine. One that could write the state directory could change what the next
  worker ends at start. The token is the machine's.

A path that is written wrongly (a relative one, say) breaks these rules like any
other and is exit code 52, not 41: the configuration file's own check reads only
that each of these is a string. The line the worker stops with ends with the
key of the entry at fault, such as `(container.mounts.art[1].source)`,
`(accountLogins.subscription-a.claude.target)` or `(container.socket)`; of two
entries that overlap it names the later. It names an account's id and a harness
at most, never a path.

The paths are fixed when the worker starts; a later change to the file changes
nothing until the worker is started again. The directory itself is looked at
only then. One that is removed or replaced afterwards is the operator's to
answer for.

After creating a container and before starting it, the worker reads the
container's mounts back from the engine. They must be exactly the ones it asked
for: each a bind mount of the same source at the same target, writable or
read-only as asked (the nested socket writable), and no others. Anything else, an image's declared volume
included, removes the container unstarted and fails the launch (exit code 23).

The paths are this machine's own. The worker puts no mount path, credential or
file content in anything it prints or reports of its own: not in the line it
stops with, a failed start's report, the startup envelope, a container's labels
or its environment. What a body's container prints is not passed on at all: the
body program holds a credential, so the worker reads its output and drops it.

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

Another engine that serves the same routes on a Unix socket is used the same
way. `scripts/check-container-engine.mjs` runs the built worker against a socket
you name (a house fetched and built, bodies started in it, then the raw answers
to a few requests) and prints what the engine took and what it refused. The
script as it now is, which builds a house, has not yet been run against an
engine. Its earlier form, which started bodies in an image already there, was
run against rootless podman 5.4.2 on 2026-11-17 and showed: podman takes these requests, reports a
container's mounts in the same form, and honours the `none` log driver. It
ignores the runtime's name and runs the runtime it is itself configured with,
whichever of the two the worker asks for. It also creates a bind mount's source
directory when that is missing, where Docker refuses the container.

### Worker-local account runner bindings

A shared `runners` command is signed in to one account by its own environment,
and the worker cannot check which. That is right while one account of the job's
provider is signed in on the machine. When several are, loom says so in the
assignment (`accountChoices`) and the worker refuses the job (exit code 27)
rather than run it on an account loom did not pick. Two things lift the refusal:
a shared runner that reads the account from the startup JSON and signs in to it
itself says so with `"selectsAccount": true` on its command; or, for separate
local profiles or private runner commands, configure `accountRunners`, keyed
first by the account ID and then by harness:

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
envelope after the running acknowledgement.

`runners` and `accountRunners` are for a worker whose bodies are processes. A
worker with container bodies has neither (exit code 53): its image says how a
body starts, and an account reaches a body only as its sign-in directory (next
section). Without `accountLogins`, such a worker refuses a job when loom says
several accounts of its provider are signed in on the machine (exit code 27).

These bindings select a configured runner. That program must still implement its
native harness's model choice and tool restrictions; this feature does not infer
provider CLI flags or supply an account profile that is not locally configured.

### Worker-local account sign-in directories

A subscription sign-in is a directory of files that the provider's program
rewrites when it renews. It cannot be baked into an image. With container
bodies, `accountLogins` names that directory for each account, keyed like
`accountRunners`: first by the account ID, then by harness.

```json
{
  "accountLogins": {
    "subscription-a": {
      "claude": {"source": "/home/worker/logins/subscription-a/claude", "target": "/home/agent/.claude"}
    },
    "subscription-b": {
      "claude": {"source": "/home/worker/logins/subscription-b/claude", "target": "/home/agent/.claude"}
    }
  }
}
```

A job placed on an account, for a harness, gets exactly that one directory in
its container, mounted read-write so the program can renew. No other account's
directory, and no other harness's, is ever mounted into that container. A job
with `run.nestedContainers` is the exception to what that is worth: it holds the
engine, and can have the engine mount any of these directories into a container
it starts itself (see "Container bodies"). Two
accounts may use the same `target`, since only one of them is in any container.

When this map is present, every job needs an exact account/harness entry. A job
without one fails before the builder or the body starts (exit code 27). It never
runs without a sign-in directory and never with another account's.

`source` and `target` follow the rules of "Mounted directories", are checked
when the worker starts (exit code 52) and are fixed from then on. The mount is
one of those the worker expects when it reads the created container's mounts
back. `accountLogins` needs `container`: a body run as a process is not given
anything by a mount, so a configuration with `accountLogins` and no `container`
is not valid (exit code 41).

Two bodies on the same account and harness share the one directory, as two
processes signed in to one account do (see "Two bodies on one account share one
sign-in directory" in [`../accepted-tradeoffs.md`](../accepted-tradeoffs.md)).
With a rootless engine the worker's user is the container's root, so the
image's `USER` must be one that can write the directory.

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
reports it received, then invokes Claude with the assignment's exact model. It
settles the mail only after the answer is recorded (see "Attempts, retries and
exit codes").
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
replay cannot restore active authority. A running body's Stop remains with the
receiving body: its status reports tell it of the Stop, it drops its work and
exits 10, and loom takes the Stop when the worker reports that exit. A status
report cannot take a Stop. Preparation changes the thread working indicator, without
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

A private current body can request runtime.proposeAgentModels with an agent and
ordered configured models. Root derives the requesting member and conversation,
checks that member owns the target agent, and files the complete before/after in
an inline setting approval. Models remain unchanged until Allow. The static
approved operation rechecks current ownership, configured model roles and the
previous ordering; stale cards require a new request. It has no shell or provider
side effects. The ordinary member-only agentModelsSet command remains unchanged.

runtime.proposeAgentRunSettings lets a current private chat body request its
member's agent run configuration. The existing inline approval carries the
previous house, machine order, ports and capabilities alongside the proposed
ones. Allow rechecks the requesting member's agent ownership and current
machine availability or lending. A stale card needs a fresh request. Direct
owner edits and approved changes share validation/application. This path never
changes repository-secret references or executes a house.

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
records wordless action and reply turns with their observed models, then a
generic completion digest if none was already authored for this conversation/job.
Authored decisions, task entries and owner questions survive. Successful Comms
and bridge jobs use the same fallback; native reply words are never copied into
a second durable field by runtime completion.
These venues do not create a Comms thread or message;
Discord and Slack retain their guarded bridge reply path.


A current native body can use `conversation.handoff` through `loom_command`
with an assigned peer agent, stable client ID, short label and brief words.
Root derives the parent job and member/project labels, checks the peer's current
assignment again after encryption and on replay, and reuses one canonical
handoff conversation per peer/parent job. Its one Inbox item enters ordinary
Tempo settling and job admission. No Comms thread is created.

Briefs remain encrypted in the existing Inbox words cell with an original
household retention deadline of at most 14 days. Only the bound receiving body or a currently authorized member through the
existing Inbox read may open them; current policy can shorten that deadline, and expiry withdraws
original/cloned HTTP responses and acceptance before confirmation. The normal
conversation lifetime removes ciphertext while preserving item/turn metadata.
Handoff and member-private jobs keep no copied durable brief or stdout/stderr.

For public work with neither a member nor a project, both agents must have a
current explicit owner in common. Project work requires both agents to remain
assigned to the project; private work requires the receiving agent to remain
assigned to that member.

A current private wake, handoff, Discord or Slack body can include an owner
question in `conversation.digest`, addressed only to that conversation's private
member. The question and its answer use retained encrypted words in their existing
Inbox rows; no Comms thread is created. Inbox records the responder and outcome,
and the same conversation's receiving body gets the answer with the original
question while its words remain available. Both word stores obey the original
keep deadline and any shorter current household policy. Rewriting a digest
retires its previous waiting question without removing answered history.
Task and approval answers returning to an agent in a private conversation inherit
that conversation's member and project labels. A different member's private
source cannot be relabelled into it. The strict receiving mail-scope guard remains
in place; ordinary work-source records keep their own scope.
