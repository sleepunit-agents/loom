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
request and response bodies. A logical write keeps its operation id across the retries described below.
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
The worker sends job heartbeats every 15 seconds during a build, while waiting for
an account, and while a body runs. A heartbeat that says the job is inactive ends
local work immediately. When the server cannot be reached, the worker keeps the
slot and measures 120 seconds from the first unanswered heartbeat attempt. An
answered heartbeat clears that timer. Each heartbeat gets a fresh operation id
so the worker always checks the job's current state. Started and finish reports
use the same id across attempts so a lost response cannot start or finish a job twice.

On startup the server gives previously claimed jobs a full 120 seconds to report.
Each sweep measures silence from the later of server startup and the last job
report. The first sweep strictly past 120 seconds of observed silence marks a job
lost and records the elapsed seconds. The usual retry policy then applies. Queue
deadlines still use their original timestamps.

With the updated worker and body already running, an active job on a healthy
worker can survive a server-only restart that restores reporting within 90 seconds,
including a compatible database upgrade. This leaves time for the next heartbeat
or backed-off call. The operator must preserve the job database, credentials and
origin. A worker restart ends its processes. An outage during an uncertain
one-shot credential exchange can still fail that start.

An exception stops the slot, including
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
| 18 | body assignment | The assignment names a harness or venue this body cannot serve, or one the harness would refuse. No mail has been taken. One exception: mail from a sender nobody looked up turned the job's word after the mail was taken, and the harness always has a shell ("What a body may use"). That mail was taken and not settled; it goes back to the job. |
| 19 | body report | Loom refused the first report or its response was invalid. |
| 20 | body contact | A required call exhausted its two-minute contact budget, including the first report, or Loom refused a later status report. The body ended its work. |
| 21 | worker input | Fetching the private repository input. |
| 22 | worker build | The build command; or, with container bodies, fetching the house's repository or building its image. |
| 23 | worker launch | Starting the body's process. |
| 24 | worker enroll | Registering the body's credential with loom. |
| 25 | worker release | Handing the started body its input. |
| 26 | worker reap | The body's process could not be watched or reaped to its end. |
| 27 | worker runner | This worker has no command for the job's harness, or none it can hold to the account loom placed the job on (see "Worker-local account runner bindings"), or no sign-in directory for the job's account and harness (see "Worker-local account sign-in directories"). |
| 28 | body tools | The body's own tools server, which the harness is given, could not be started. |
| 29 | body killed | The body did not end by itself: a signal ended its process (the system's memory killer, an operator's kill), or its container was ended that way (a container exit of 128 plus a signal's number). The worker reports it; the body said nothing. |
| 30 | worker house | The house's image does not meet the image contract: it does not say it is a house of this layout (`loom.house="2"`), it does not list the job's harness, or it declares a `VOLUME` (see "What a house image must say"). The house has to change, not the machine. |
| 31 | loom unplaced | No machine took the job within the queue deadline (24 hours from when it could first be claimed). Or, at once: the job works on anybody else's word and every model the agent has runs on a harness that always has a shell ("What a body may use"). Nothing ran; the job is not tried again, and its conversation takes fresh mail. |
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
| 52 | a path the configuration gives to containers, or an engine socket, cannot be used: a mounted directory that is not an existing directory of this user written as its real path, an engine socket that is not an existing socket, a source or a socket not written as a plain absolute path, a harness named under accountLogins in anything but lower-case letters, digits, - and _, a mount target that is not a plain path under the home of the house or that is or holds its repository, or a mounted directory that overlaps another, an engine socket, the state directory or the token file. The line ends with the configuration key at fault in brackets, for example `(container.mounts.art[1].source)`: a key, never a path (see "Mounted directories" under "Container bodies") |
| 53 | the configuration has a key that a worker with container bodies no longer takes: it builds each house itself from the agent's repository, mounts are listed by agent, and where a sign-in appears in a house is the same in every house. The line ends with the key in brackets: `(build)`, `(runners)`, `(accountRunners)`, `(container.mounts)` or the `target` of a sign-in directory, as in `(accountLogins.subscription-a.claude.target)` (see "Container bodies") |
| 54 | git 2.32.0 or later, which fetches each house's repository, could not be run on this machine |
| 55 | the directory the worker is installed in cannot give containers the body program: dist/body.js or a package it depends on is not inside it (its packages must be in its own node_modules, as a global npm install puts them) |
| 56 | the directory the worker is installed in has no definition of the core house (house/core/Housefile), which every house is built on |
| 57 | another worker on this machine already uses the engine or a sign-in directory this configuration names: one worker runs a machine's houses. The line ends with the key of the one that is in use, in brackets: `(container.socket)` or `(accountLogins.subscription-a.claude.source)` (see "One worker for an engine") |

A worker that stops cannot report its own end, so loom records the job it held
only as lost ("its worker stopped reporting"). Which stage stopped the worker
is in that machine's log, by this line and code.

Mail that cannot become a job at all (the agent was removed, or has no run
settings or no model) leaves no job row. loom tells the agent's owners why in a
notice, once, and closes the notice when the mail is admitted.

## Several jobs at once

```json
{"slots": 4, "accountSlots": {"claude": 4, "codex": 1}}
```

`slots` is how many jobs a worker runs side by side: an integer from 1 to 16.
Left out, a worker with container bodies runs 4 and a worker whose bodies are
processes runs 1. The difference is on purpose. A container worker fetches,
builds and starts bodies itself, and was built to do several at once. A process
worker's build command and runners are the operator's own programs, written for
one job at a time; set `slots` for one when its programs can run beside
themselves. Memory, disk and GPU are not counted: `slots` is the only limit.

What two jobs on one worker never have at the same time:

- **An account's sign-in for one harness, beyond `accountSlots` bodies.**
  `accountSlots` is how many bodies of one harness may run on one account at
  once. It is one number for every harness (`"accountSlots": 2`), or a number
  for each harness named (`{"codex": 2}`); never more than `slots`. A harness
  it does not name has its default: **1 for `codex`, 4 for every other**, or
  `slots` when that is fewer. Bodies on one account share its sign-in for their
  harness, as several sessions of one person do; bodies of two harnesses on one
  account share nothing and do not wait for each other. A job placed on an
  account that is full is claimed, fetched and built, and then waits for one
  of its bodies to end. Two programs renewing one sign-in at the same moment
  can leave one of them refused. What each harness's program does about that,
  and why Codex's bodies run one at a time until a machine says otherwise, is in
  "Worker-local account sign-in directories" and in "Two bodies on one account
  share one sign-in directory" in
  [`../accepted-tradeoffs.md`](../accepted-tradeoffs.md).
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
for each new claim or heartbeat. Other report receipts are
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
with no `git`, or one older than 2.32, stops it with 54 (the worker runs no
older git at all: see "The worker builds a house itself").

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

### One worker for an engine

One worker runs a machine's houses, and the worker holds that itself. Before it
takes any work, a worker with container bodies holds to itself its engine (by
the real path of `container.socket`) and every sign-in directory under
`accountLogins` (by its real path). A second worker that names the same engine
or one of the same directories stops at start with exit code 57 and the key of
the one in use, whatever its own state directory, configuration file or user.
What is held is released when the worker ends, however it ends: one that was
killed blocks nobody.

Two things rest on it. The core house is built once for an engine and removed
only when no house there is built on it, which one worker can know and two
cannot. And the number of bodies that share one account's sign-in
(`accountSlots`) is counted by the one worker that mounts it.

On Linux what is held is a name in the system's table of listening sockets (an
abstract socket named for the path's digest): no file is made anywhere, and
nothing is put in a sign-in directory. Elsewhere it is a socket file in the
temporary directory. So "a machine" here is what shares that table: two engines
on one computer, each with its own socket and its own sign-in directories, are
two machines and may each have a worker; so are two users with an engine each.
A worker run inside a container with a network of its own does not see the
host's table, and is not held apart from a worker on the host by this: do not
give two such workers one engine socket or one sign-in directory.

### The worker builds a house itself

A job's house is what its agent's run settings say: a repository, the path of a
Housefile in it, and a branch ("Agent house settings"). An empty Housefile path
is a house with no Housefile of its own: the core house with the repository
copied in ("The core house").

1. **Fetch.** The worker keeps one bare mirror for each repository under its
   state directory (`houses/`), fetches the job's branch into it with the
   machine's `git`, and reads which commit that is. A mirror holds git's objects
   and nothing that says where they came from: no remote, and no `FETCH_HEAD`.
   It keeps the eight mirrors used most recently; older ones are removed beside
   the work, never one being fetched or read. A job whose repository's mirror is
   being removed waits for the removal and fetches the repository afresh.
2. **Find or build.** The image of that repository, Housefile and commit, built
   on this week's core house, is named
   `localhost/loom-house-<16 hex>:<commit>-<the core's tag>`. If the engine has
   it, it is used. If not, the worker first builds the core house unless the
   engine has that ("The core house"), then streams the commit's files, as a
   tar it writes itself, to the engine's `/build` as the build context, with the
   Housefile's path and one build argument, `LOOM_CORE`, which is the core
   house's image. One build runs at a time for one image; a second job that
   wants it waits for the same build.
3. **Start.** The worker checks that the image is a house of this layout that
   serves the job's harness, and creates the container. How a body starts in
   it is the layout's, the same for every house ("The layout of every house").

The worker never checks a repository out, never reads the Housefile and never
runs anything from a repository, and neither does git on its behalf. The Housefile is the whole definition of a
house: it must build from what the repository holds and what the engine can pull.
The worker passes one build argument to a build, `LOOM_CORE`, and no secret,
host path or socket.

The build context is written by the worker itself, from the commit's tree. git
is used as a store of objects and nothing else: the worker asks it for the list
of the commit's files and for each file's bytes, and writes the tar stream that
goes to the engine. Every regular file is in it byte for byte, executable or
not as the commit says; every symbolic link is in it as a link, with the target
the commit gives it. Nothing else is: a submodule's entry is skipped (another
repository's commit, which is not fetched), Git LFS files are the small pointer
files the commit holds, and no owner or time is the repository's (every entry
is root's, at time 0).

No file of a repository is interpreted on the host, by the worker or by git: not
`.gitattributes` (nothing is left out, substituted or converted, whatever it
says), not `.gitmodules`, no filter, and no signature is checked. git reads the
repository's commit and tree objects to find the files, and hands over file
contents unread.

A context has limits, and a house past one fails as a failed build (exit code
22) before anything is sent to the engine: 100 MiB for one file, 1 GiB for the
bytes of all the files together (the headers written around them are not
counted), 50,000 files and links, and 4,096 bytes for a file's name or a link's
target. The same goes for a tree the worker will not write:

- a name that is not UTF-8, is absolute, or has an empty, `.` or `..` part;
- one name twice, or a name that passes through another entry (`a` and `a/x`
  where `a` is a file or a link), which only a hand-made tree can hold;
- a link whose target is empty or holds a NUL byte; or whose target is not
  UTF-8 and is longer than 100 bytes. A shorter target is written as its bytes,
  UTF-8 or not.

Names and targets longer than 100 bytes are written in a pax extended header.

**git 2.32 is the oldest the worker runs.** That is what the fetch needs: no
`FETCH_HEAD` (2.29), settings given in the environment (2.31), and no per-user
configuration file (2.32). An older git would fetch without the worker's
settings, so it is not run at all.

**Only `https://` repositories are fetched.** A job whose house is anything else
(an `ssh` address, a path) fails as a failed build (exit code 22). So does one
whose address holds a `@` or a backslash, whose branch is not a plain name (at
most 200 of letters, digits, `.`, `_`, `/`, `-`, beginning with a letter or a
digit; no `..`, no `//`, not ending in `/`, `.` or `.lock`) or whose Housefile
path is not a plain relative one. `git` is run with none of the
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

**What is kept on the disk.** A house image holds no copy of loom. Its name
depends on its own commit and on the core house, and on nothing else of the
worker: deploying a new loom rebuilds a house only when it changes the core
house's definition. After a build, once the job has its image, the worker looks after the
disk beside whatever it does next: it lists loom's own house images, keeps the
two newest of each house and the ten newest in all, and removes the rest.
Newest means used most recently by this worker: an image is used when a job is
given it, built or found. (The engine's own time for an image is when its last
layer was made, which for one built again from the engine's cache is long ago;
that time ranks only the images this worker has not used since it started.) So
the image a build has just made is the newest of its house.

House images a worker built before houses were built on a core are named
`localhost/loom-house-<16 hex>:<commit>`, with no core's tag. No job can be
given one again, so every one of them is removed in the same upkeep, whichever
house it was of; one a container still runs in is refused by the engine and
removed in a later upkeep.

Beyond those counts one kind of image is kept: one a job holds, or whose build
is still being finished. A job holds its image from the moment it knows which
one it wants until its body has ended or the job has ended without one, and
that is asked again at the moment of each removal. Once nobody holds an image it
counts like any other. An image a container uses is never removed either: the
engine refuses. A job that wants an image whose removal is under way waits for
the removal and builds the image again. The worker then asks the
engine to remove images that have no name and are older than a day, and build
cache unused for a week. That last request reaches every unnamed image on the
engine, not only loom's (see "A worker treats its engine's unnamed leftovers as
its own to remove" in [`../accepted-tradeoffs.md`](../accepted-tradeoffs.md)).

Core house images are not counted among the ten. One is kept for as long as a
house image that is kept was built on it, or a job is building it or building
on it; every other is removed in the same upkeep. So there are never more core
images than house images kept, and in practice two: this week's, and last
week's while a house built on it is still among the newest two of its house. A
core image shares its layers with the houses built on it, so removing one frees
only what no house still uses.

This upkeep is no job's: it is outside every build's limit, has five minutes of
its own, and runs one at a time. When the images cannot be listed (the engine
does not answer, or its answer is longer than 4 MiB) nothing is removed and the
worker prints `Worker could not look at its house images: old ones stay until it
can`; it looks again after the next build.

### The core house

loom provides the house every house starts from: a current Debian with its
updates applied, basic tools (git, curl, jq, ripgrep, python3, an ssh client),
Node at `/usr/local/bin/node`, Claude Code and Codex at pinned versions, the
layout below, a body file for each of those two harnesses, and both labels of
the image contract. It is a house by itself.

**loom ships its definition and no image.** The definition is the directory
`house/core` of the worker's own install: a Housefile and the two body files it
copies. A worker reads it once when it starts; an install without it stops the
worker with exit code 56. The first time a house needs the core, the worker has
its engine build it, from those files and from public addresses, with no build
argument. A machine that has just had its worker installed needs nothing else.

**Its name is its definition and the week.** The image is
`localhost/loom-core:<16 hex of the definition's digest>-<year>w<week>`, the
ISO week in UTC (`2026w47`). So the core is built again when a new loom changes
the definition, and once in every new week, which is what keeps the system in
it current without anyone doing anything.

**A house says which core it was built on**, in its own image's name. A new core
therefore means each house is built again, once, on its next job: the engine
reuses every step of the house's own Housefile that it can, but a step after
`FROM` runs again when the core's layers changed. A job that already has its
image is never disturbed: it holds that image, and the core it was built on
stays until no kept house image names it ("What is kept on the disk").

**The core's build is a build like a house's.** It counts toward the same
`buildTimeoutMs` as the house that waits for it, the job is reported as starting
all the while, two houses that need it wait on one build, and a core that
cannot be built fails each waiting job as a failed build (exit code 22) or as
out of time (32). What the engine built is checked against the image contract
before any house is built on it; an image that fails it is removed again.

**An agent's Housefile starts from it:**

```dockerfile
ARG LOOM_CORE
FROM ${LOOM_CORE}

# Furniture: this agent's extra tools, its links, its git identity.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

COPY . /home/agent/repo
```

Everything of the layout and the contract comes with the core. A Housefile
changes what it wants to: a body file of its own over the core's, another
harness and the label that lists it.

**An agent with no Housefile** (an empty Housefile path in its run settings) gets
the core with its repository copied in. The worker writes that build itself, in
two parts: the commit's files in a directory `repository/`, and beside it a
Housefile of three lines (`ARG LOOM_CORE`, `FROM ${LOOM_CORE}`,
`COPY repository/ /home/agent/repo/`). The Housefile is not in what is copied,
so nothing has to be removed from the image and no step runs in it. Nothing of
the repository is at the top of the build's files: a file of its own named
`Housefile` or `repository` meets nothing, and its own `.dockerignore` is an
ordinary file one directory down that leaves nothing out. Every file of the
commit is in the house.

**A Housefile that does not start from the core still works**, when the image
it makes meets the contract and the layout by itself. Its build is given
`LOOM_CORE` like every build and leaves it unused. The core is built first all
the same, and the house's image is still named for it, so such a house too is
built again each week, from the engine's cache.

**The core is built for Linux on x86-64.** Its Housefile fetches the `linux-x64`
builds of Node and Claude Code. On another architecture the core does not build
and every job fails as a failed build (exit code 22).

**Not in the core: `agy`.** Neither of the household's houses installed it, and
there is no pinned install to copy. Adding it needs a download of one stated
version with a published checksum, a way to point it at a mounted sign-in
directory, a body file, and its name in the label.

### The layout of every house

Where things are inside a house is loom's to say, and it is the same in every
house on every machine. No machine's configuration and no label of an image
says any of it. Nothing in it is named for an agent: who lives in a house is
the repository it was built from.

| What | Where, in every container | Who puts it there |
| --- | --- | --- |
| The home | `/home/agent` | the image; the worker sets `HOME` to it |
| The agent's repository | `/home/agent/repo` | the image (`COPY . /home/agent/repo`); a body starts there |
| Node | `/usr/local/bin/node` | the image (the core house) |
| A harness's body file | `/etc/loom/body/<harness>.json` | the image (the core house, for `claude` and `codex`) |
| The job's account's sign-in, for its harness | `/run/loom/login/<harness>` | the worker mounts it |
| loom's own program | `/opt/loom` | the worker mounts it, read-only |
| An agent's mounted directories | under `/home/agent`, at the path the configuration gives | the worker mounts them |
| Where a harness keeps its sessions | `/home/agent/.claude` for Claude Code; no place for another harness yet | the image makes it (the core house); the container's own, gone with the body |

The home is fixed and the user is not: a body runs as the image's `USER`. **The
core house has no `USER` line, so a body in it runs as the container's root.**
With a rootless engine the container's root is the worker's own user outside
the container: it is the one user that can write a mounted sign-in directory,
and it can reach nothing on the machine but what the worker mounted. Inside the
container it can change any file of its house, which lasts as long as that
container. With an engine that runs as root, a house that keeps the core's
root runs as the machine's root inside its container; a house for such a
machine sets a `USER` that can write the sign-in directory.

**Sessions.** A body of a Discord or Slack conversation whose job works on its
owners' word, or is the agent's own work, continues the session
the last such body of that conversation left: loom hands it the session, it puts the
files back in the harness's own directory, and hands them back to loom when it
has answered ([accepted-tradeoffs.md](../accepted-tradeoffs.md), "A harness
session is kept between bodies"). It does so only where that directory is the
body's alone. In a house it is: the directory is in the container's own home,
and the account's sign-in is mounted somewhere else (`/run/loom/login/<harness>`).
The worker always tells the body, `LOOM_BODY_OWN_HARNESS=1` or `=0`, so a value
set in the image never stands: 1 unless one of the agent's mounted directories
is, holds, or is inside that place. The body also refuses when the place, or any
step from the home down to it, is a link and not a real directory. **An agent
mount at `.claude`, or anywhere under it, turns this off for that agent's
bodies:** each then starts fresh with what was said before. A house that sets
`CLAUDE_CONFIG_DIR` to anywhere but `/home/agent/.claude` turns it off too, and
so does a house whose image has no such directory: a body never makes it. A
body run as a plain process (no `container` in the configuration) is never told
its harness's directory is its own and keeps no session. A body whose job works
on anybody else's word keeps and continues none anywhere ("What a body may use").

A repository must not assume its own name in a path, a home other than `$HOME`,
that its checkout is anywhere but `$HOME/repo` (the directory a body starts in),
that a sign-in is anywhere but `/run/loom/login/<harness>`, or that it runs as a
user of some name. A house that wants an older path makes a link to the fixed
one in its Housefile.

### What a house image must say

A house image says two things with labels. A house that starts from the core
house has both from it; this is what the core's own Housefile says:

```dockerfile
LABEL loom.house="2" \
      loom.house.harnesses="claude codex"
```

- `loom.house` is the version of this contract and of the layout above: `2`.
  An image that says `1` was built for the layout before it, where labels named
  the node program and the body files, and is refused.
- `loom.house.harnesses` names the harnesses the house serves, with a space
  between. It is what houses differ in that the worker must know before it
  starts a body.
- The image declares no `VOLUME` and keeps nothing at `/opt/loom`.
- The image has node at `/usr/local/bin/node`, and for each harness it lists a
  body file at `/etc/loom/body/<harness>.json` (see "Private body bootstrap").

The body's command is
`/usr/local/bin/node /opt/loom/dist/body.js /etc/loom/body/<harness>.json`, started
in `/home/agent/repo` with the image's `ENV` and as the image's `USER`. The
worker sets these variables whatever the image says (an image's `ENV` of the
same name does not hold): `HOME=/home/agent`, `LOOM_BODY_SCRATCH=/tmp`, and what
the house was built from: `LOOM_HOUSE_REPOSITORY` (the `https` address as it
was fetched, which never holds a credential), `LOOM_HOUSE_BRANCH` (the branch
in the job's settings) and `LOOM_HOUSE_COMMIT` (the full id of the commit the
image was built from, taken from the image's own name: for an image found
already built, that is the commit it was built at, not where the branch is
now). A house with no Housefile is told the same three. With them a repository
can make the copy of itself at `/home/agent/repo` a checkout of exactly that
commit. The image's `WORKDIR` is not read. `/opt/loom` is
the directory the worker itself is installed in, mounted read-only: every body
runs the body program of the loom that is running the worker, and no image
carries one. The body program is JavaScript only, so any node that loom supports
runs it.

Everything of this that an image's own description shows is checked before a
container is made of it: the two labels, and that the image and its base
declare no `VOLUME`. An image that fails one fails that job with exit code 30,
and the job's line names the label or rule, as in `the house image does not meet
the image contract (loom.house.harnesses)`. The worker goes on with its next job.

What the description does not show is checked by nothing: whether node, the
body file and the repository are really in the image at their places. An image
without node there fails when the body is started (exit code 23), and so does
one with no `/home/agent/repo`; one whose body file is not there fails in the
body program (exit code 16).

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
        {"source": "/var/lib/houses/art/stamps", "target": ".local/state/stamps", "readOnly": false},
        {"source": "/var/lib/houses/art/mirror", "target": "mirror"}
      ],
      "mark": [
        {"source": "/var/lib/houses/mark/stamps", "target": ".local/state/stamps", "readOnly": false}
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
- `target` is where the directory lands under the house's home: a relative
  path, written as plainly, so `.local/state/stamps` is
  `/home/agent/.local/state/stamps` in the container. It does not start with
  `/` and does not climb. It is not `repo` (the agent's repository) and does not
  hold it; it may be inside it.
- No target is, holds or is inside the target of another directory that can be
  in the same container: another mount of the same agent. (A sign-in directory
  and `/opt/loom` are outside the home, where no mount's target can be.) Two agents' mounts are never in one container and may use the
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
to a few requests) and prints what the engine took and what it refused. It builds a
stand-in core house and a house on it and starts bodies in the fixed layout.
With `--core` it also builds the real core house from `house/core` (which
downloads the harnesses and takes some minutes) and runs two bodies on it, one
in a house with no Housefile whose repository has an ignore file that lets
through one name only, one in a house whose own `ENV` names the three
`LOOM_HOUSE_` variables. It prints what each body found: node's version and
Claude Code's checksum against the pins, what `claude --version` and
`codex --version` print, where each harness looks for its sign-in (the
variable, the link and whether the mounted directory can be written; no sign-in
is read), every file of the repository, and the three `LOOM_HOUSE_` values.

**One run, with `--core`, on 2026-11-17**, against rootless podman 5.4.2 with
crun and git 2.47.3, on x86-64; it ended with exit code 0. What it showed:

- The real core house built through the engine, 1.29 GB, with the labels
  `loom.house="2"` and `loom.house.harnesses="claude codex"`, no volume and no
  user.
- podman took the core's local name from the `LOOM_CORE` build argument: houses
  were built `FROM` it with nothing pulled.
- A house with no Housefile built on it, and its body found every file of the
  commit, the one its `.dockerignore` would have left out among them.
- In a body: node v24.18.1 at `/usr/local/bin/node`; Claude Code 2.1.326, whose
  installed file has the pinned checksum; Codex 0.164.0; each answered
  `--version`. `HOME` was `/home/agent`, the working directory
  `/home/agent/repo`, the user id 0.
- Claude Code's sign-in place was `/run/loom/login/claude` (the variable),
  Codex's `auth.json` a link into `/run/loom/login/codex`, and the mounted
  sign-in directory could be written.
- A house whose image sets `HOME` and the three `LOOM_HOUSE_` names itself still
  gave its body the worker's values.
- The upkeep after a build removed a house image of the earlier naming that the
  previous worker had left.

What that run did not show: a harness signing in or renewing from the mounted
directory, a model being called, or two bodies renewing at once.

An earlier form of the script, which started bodies in an image already there,
was run against the same podman on the same day and showed: podman takes these requests, reports a
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
worker with container bodies has neither (exit code 53): every body starts the
same way ("The layout of every house"), and an account reaches a body only as its sign-in directory (next
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
      "claude": {"source": "/home/worker/logins/subscription-a/claude"}
    },
    "subscription-b": {
      "claude": {"source": "/home/worker/logins/subscription-b/claude"}
    }
  }
}
```

A job placed on an account, for a harness, gets exactly that one directory in
its container, at `/run/loom/login/<harness>` ("The layout of every house"),
mounted read-write so the program can renew. An entry gives only the machine's
directory. Where it appears is the same in every house, and the house points
its harness there (a variable for Claude Code, a link for Codex). An entry
that still has a `target` stops the worker with exit code 53, naming the key. No other account's
directory, and no other harness's, is ever mounted into that container. A job
with `run.nestedContainers` is the exception to what that is worth: it holds the
engine, and can have the engine mount any of these directories into a container
it starts itself (see "Container bodies").

When this map is present, every job needs an exact account/harness entry. A job
without one fails before the builder or the body starts (exit code 27). It never
runs without a sign-in directory and never with another account's.

`source` follows the rules of "Mounted directories", is checked when the
worker starts (exit code 52) and is fixed from then on. A harness's name is
part of the place its directory is mounted at, so it is lower-case letters,
digits, `-` and `_`. The mount is
one of those the worker expects when it reads the created container's mounts
back. `accountLogins` needs `container`: a body run as a process is not given
anything by a mount, so a configuration with `accountLogins` and no `container`
is not valid (exit code 41).

**One directory, renewed in place.** A provider's renewal token changes at every
renewal, so two copies of one sign-in cancel each other. There is therefore one
directory for an account and a harness on a machine, every body on that account
is given that same directory, and nothing makes a copy:

- The worker mounts the directory whole and read-write. It never reads, lists,
  cleans, writes or removes anything inside it, at start or between bodies: it
  asks the system what the directory is, and that is all. A harness's program
  keeps more there than the sign-in (Claude Code keeps the lock it renews
  under), and those files are the program's.
- The core house points each harness at its place, in place: Claude Code by
  `CLAUDE_SECURESTORAGE_CONFIG_DIR=/run/loom/login/claude`, Codex by a link
  from `/home/agent/.codex/auth.json` to `/run/loom/login/codex/auth.json`. A
  house that copies a sign-in file into its image or its home brings the old
  fault back.
- Whichever body's program needs to renews, when it needs to. loom has no
  renewer, no broker that hands out tokens and no lock of its own, and the
  mount is not read-only (a program that cannot write cannot renew).
- How many bodies share a directory at once is `accountSlots` ("Several jobs at
  once"): 4 for Claude Code, 1 for Codex unless the configuration says more.

What keeps two renewals apart is each harness's own program, and what is known
of that is stated in "Two bodies on one account share one sign-in directory" in
[`../accepted-tradeoffs.md`](../accepted-tradeoffs.md): what was read, in which
version, and what is not established.

**When a sign-in dies** (the provider ended it, or it was never made), the
account is signed in again on the machine, into that same directory. Every body
on the account has it from its next start; nothing is restarted or rebuilt.
The directory is not where a harness's program keeps its sign-in on the machine
by default, so the program has to be pointed at it, in the same way the core
house points it:

- **From loom** (`runtime.accountSignIn`, in
  [`accounts.md`](accounts.md), "Signing in from anywhere"): the worker runs the
  program configured for the provider under `accountSignIn.programs`, with the
  environment that entry gives it. For Claude Code that entry's `env` carries
  `CLAUDE_SECURESTORAGE_CONFIG_DIR` set to the account's `source` directory, so
  what the program writes lands there. There is one program for a provider, so
  this reaches one account's directory for each provider on a machine.
- **By hand, at the machine, as the worker's user, with no body of that account
  and harness running.** Claude Code: run it with
  `CLAUDE_SECURESTORAGE_CONFIG_DIR=<source>` in its environment and sign in with
  its own `/login`. Codex: sign in with `codex login`, which writes
  `~/.codex/auth.json`, then put that file in place as the household's earlier
  loom did, by a copy inside the directory and a rename:
  `cp ~/.codex/auth.json <source>/auth.json.new && mv <source>/auth.json.new <source>/auth.json`.
  Then record it: `runtime.accountSignedIn {account, box}`.

What this rests on: the household's earlier houses ran Claude Code 2.1.309 with
that variable and Codex 0.162.1 through that link, and their sign-ins were
renewed in those directories. In the core house, with the versions it pins,
one run on 2026-11-17 showed the variable set, the link in place and the mounted
directory writable (see "Container bodies", the engine check); no harness has
yet signed in or renewed from there.

With a rootless engine the worker's user is the container's root, so the
image's `USER` must be one that can write the directory; the core house's is.

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
acknowledgement never releases private input after cancellation. Enrollment can retry a refused TCP connection before delivery. An ambiguous
enrollment is not replayed.

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
Always-denied tool patterns, and the guests-only patterns when the job works on
anybody else's word, go into native --disallowedTools. Held to loom's tools the
CLI is given no built-in tool at all (`--tools ""`), every built-in tool is
also denied by name, and it uses dontAsk permission mode with loom's tools as
its allow list; with full reach it uses bypassPermissions and none of those. Either way it has an empty settings-source
list and no unrelated MCP servers. Calls needing interactive native approval are refused.

### What a body may use

Two things decide it, and the lesser wins.

- The machine's body file: `"reach":"loom"` (the default) gives a body loom's
  tools and nothing else; `"reach":"all"` gives it the harness's own as well.
- The job's word. loom reads on whose word a job works when it is claimed
  (`jobWord`, `src/shared-place-mail.ts`) and hands it to the worker as
  `run.policy.word`: `own`, `owners` or `others`. A job holds one asker's mail,
  so the word is that asker's: reach follows who asked, not who else is in the
  room ([bridges.md](../specs/bridges.md), "Who asked"). On `others`, anybody else's
  word, the body runs with loom's tools only, whatever the body file says
  (`loomToolsOnly` in `src/policy.ts`, `bodyReach` in
  `src/runtime/harness-traits.ts`). A room with no `word` comes from an older
  loom and is read as `others`. So is an assignment with no room at all.

For a job on anybody else's word:

| Harness | Can it run loom-only? | What happens |
|---|---|---|
| claude | yes | `--tools "" --permission-mode dontAsk --allowedTools <loom's tools> --disallowedTools <every built-in tool>`: no shell, no files, no web, no subagents. |
| codex | no, it always has a shell | Refused. Placement passes it over; a body handed one anyway leaves before taking mail. |
| agy | no, it always has a shell | The same. |

When every model the agent has runs on a harness that cannot, the job is ended
as soon as a machine asks for work: failed by loom (exit 31), with the note
"Never started: this job is not working for the agent's owners, so it runs with
loom's tools only, and every model the agent has runs on a harness that always
has a shell. Give the agent a model that runs on Claude Code." The mail that
made the job anybody else's is closed with the same note, so it is carried into
no later job. An owner's message in that conversation, waiting behind it or
written later, gets a job on owners' word, which runs: the end of the guest's
job is reported like any job's end, and that offers the waiting mail to
admission again. Nothing tells the guest; the owners see the note on the job.

#### What `loom` reach is on Claude Code, and how it was checked

This holds wherever a body's reach is `loom`: by the machine's body file, for
any job, and for a job on anybody else's word on any machine.

`--permission-mode dontAsk` with an allow list does not hold a body to that
list. Run on Claude Code 2.1.326 with only those two, the model ran read-only
shell commands (`echo`, `cat`: the program allows them without asking), read a
file with Read, and started a subagent that ran a shell command; only Write and
WebFetch were denied. That is enough to read the environment and a token file.

So the adapter passes three things (`src/runtime/claude-body.ts`):

- `--tools ""`: no built-in tool is made available. This is what holds.
- `--disallowedTools` with every built-in tool by name (`claudeBuiltInTools`,
  read from what 2.1.326 lists at start plus the names its documents use), after
  the agent's own denials. A second layer, in case a later version changes what
  `--tools` means.
- `--permission-mode dontAsk --allowedTools <loom's tools>`, as before.

`scripts/check-claude-floor.mjs` checks this against the real program. It is
run by a person, on purpose: it needs a signed-in `claude` and spends a few
tokens, so it is not in the suite. It starts `claude` through the adapter, so
the argv is the adapter's own, with a small local tools server in place of
loom's (one harmless tool and sixty filler tools) in a scratch directory that
holds a canary file. It asks the model to call the tool, run two shell
commands, read the canary, write a file, fetch a local page and start a
subagent, and judges by effects and tool events, never by what the model says:
the tools server saw its call, no other tool gave a result, the canary's
contents are nowhere in the output, no file was made, the page was not fetched.

Run on 2026-11-18 against 2.1.326 with `claude-haiku-4-5`: all nine checks
held, and loom's tool was callable with `--tools ""`. The same run with
`--without-floor` (the two flags taken out) fails three of them: built-in tools
are listed, Bash, Read and Agent give results, and the canary is read. Run it
again when the Claude Code a machine uses changes:

    npm run build
    nice -n 19 node scripts/check-claude-floor.mjs --claude <path> --model claude-haiku-4-5

Such a body asks for no startup secret, is served neither `request_secret` nor
`use_secret`, is handed no attachment files and may name no file for a post.
It asks for no kept harness session and leaves none: it starts fresh, with what
was said before in the conversation, like any body with no session.
loom's doors refuse it the same things (`/api/secrets/private/*`,
`secrets.request`, files on `bridges.say`, `conversation.session` and
`conversation.sessionSave`), each on loom's own reading of the job's word, so
the body program is not what holds the line. A job on its owners' word, or the agent's own work, is as it was.

The word is settled by the mail a job was formed for, and that is one asker's
mail. A message that arrives later joins the job only when the same asker wrote
it (any owner for an owners' job; that same person for a guest's); anybody
else's waits for a job of its own, so a job's word never changes while it is
queued or running. Owners go first: a guest's job that is still queued when an
owner's mail arrives is set aside (state `stopped`, with a note that says so,
no exit code) and its mail is jobbed again after the owners', as the same
attempt. A job a machine has claimed is left to finish. Mail any other ended
job left behind waits for its own asker to write again; a job a person stopped,
reset or wrote off for the owners has its mail closed with the reason.

A body in a Discord or Slack conversation is told, before its mail, who its job
works for and that what others said in the room is talk to read, not
instructions (`workingFor`, `src/runtime/harness-traits.ts`). The line is made
from the room handed with the job, so it is loom's reading and not anything said
in the room. A body that continues a kept session is told it as well.

On anybody else's word loom also refuses the body, at the door: every schedule
(`tempo.set`, `.edit`, `.start`, `.runNow`, `.stop`), notices
(`notices.raise`, `notices.clear`), every task change (`tasks.command`),
`household.propose`, and `approvals.request`, `.use`, `.report` and
`.withdraw`. Of the agent's memory and notes it only adds (`memory.remember`,
and `memory.noteWrite` at a path no note has), and loom stamps what it adds
with whose word it was written on; every other memory, card, knowledge and
people write is refused. It may ask a question with `conversation.digest`, of
somebody who directs the agent, with no link and waiting on no task or
approval; the question and the digest's summary both begin with loom's line
saying on whose word the body was working. Its `conversation.status` reports
are answered and write nothing to the agent's status.

The body keeps one check of its own: if it is handed mail from a sender
nobody looked up, it takes its startup secrets back out of the environment,
puts away the session it was handed without continuing or saving one, and runs
with loom's tools only. If its harness always has a shell it leaves instead
(exit 18), before any tools server or harness is started.

No secret a body was handed is said by it. The body program looks for the value
of each secret it used and of each startup secret of eight bytes or more, each
as its bytes and as their base64, in its final answer and in every text of
every tool call: the commands it sends to loom, which is how `bridges.say`,
`bridges.post` and `bridges.reply` leave, and the reason it gives
`request_secret`. A call or an answer that holds one is not sent. A shorter
startup value is not looked for: it could not be told from ordinary words. Only
texts are looked at, and only these two forms: a value split up, or encoded
another way, is not found.

A job has one body. `runtime.enrollBody` binds a body token to a starting job
only while the job has no live one; the same fingerprint again is a repeat.

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
line breaks, and can apply to all work or only guests. A stored pattern is read
as a list: its entries are parted by commas and white space outside brackets, so
`Bash, Read` is two entries and `Bash(git commit:*)` is one. `denialEntries` in
`src/runtime/harness-traits.ts` is the one place that reads it; loom's own rules
ask it, and a harness is handed one entry to an argument, so the two cannot read
a line differently. That is Claude Code's documented reading of
`--disallowedTools`. What was checked against a running Claude Code is the floor
under it, not this parting of a stored line: see "What a body may use" for what
was run, on which version, and what it showed. The store
also accepts lines no harness is known to honour (an unclosed bracket, which is
read as one entry to the end of the line; a tab between entries, read as white
space). An entry that would begin with an option dash once the line is parted
(`Read,--flag`) fails the job before a harness is started.

One of loom's own tools is written `mcp__loom__<tool>`. An entry written under
the server's former name (`mcp__loom_secrets`, `mcp__loom_secrets__<tool>`, or a
`*` form that reached it) still takes away what it took away: each tool it covers
is also denied by its present name. An entry that takes away `loom_command` or
`loom_query` takes away every named tool too (`remember`, `task_close` and the
rest), since each is one of those two under another name. The same pattern may have
both rules. The native receiving adapter applies the current denial rules; a
claimed assignment keeps its snapshot across later settings edits. Failed writes
preserve both lists, and replay never reinstates an earlier configuration.
Configuration neither runs a model/provider nor changes the household policy.

Outside workspace and user identifiers are preserved exactly, without trimming.
Workspace/user identifiers must be nonblank and control-free. Tool patterns are stored
as written; leading/trailing control characters and whitespace padding do not
bypass their raw character or length checks. Option dashes after leading whitespace
are rejected too.

## Agent house settings

`POST /api/runtime/agentRunSettingsSet` uses the ordinary `{id,input}` envelope:

```json
{"agent":"art","houseRepository":"https://example.com/house.git","houseFile":"Housefile","houseBranch":"next","nestedContainers":false,"gpu":false,"boxes":["workshop","attic"],"ports":[{"address":"127.0.0.1","port":9000}]}
```

`houseFile` may be empty: the agent then has no Housefile of its own and runs in
the core house with its repository copied in ("The core house"). A change an
agent asks for through `household.propose` says so on its card in words ("how
art runs, in the core house with no Housefile of its own").

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
operation ID. Safe commands resend the same payload and id after a connection
failure, per-attempt timeout or temporary server outage. Mail confirmation and
reports use that same receipt mechanism. Mail pickup returns the items still held
by the same job. GraphQL reads can be repeated. Memory recall warms its results
without a receipt, so an ambiguous recall is reported to the caller. Private secret
value reads and confirmations likewise have no replay guarantee.

Body calls back off from one second to at most ten seconds between attempts,
with a total budget of 120 seconds. An exhausted tool call returns an error to
the model naming the interval. Lost contact during required body reporting ends
the body with exit 20. Best-effort final usage keeps its shorter delivery budget. Current Root policy,
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

The same listener also serves the named tools a terminal session has
(`remember`, `task_claim` and the rest), built by `bodyNamedTools` from the one
definition in `src/shared-mcp-named.ts`. Each sends its command through this
`loom_command` and its read through this `loom_query`, so it has their
credential, their checks and their refusals, and nothing of its own. The
listener is named `loom` for every harness (`docs/runtime/terminal.md`, "The
same tools in a body").

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

### Job usage

The body sends usage on its own job credential as soon as its harness returns. On success the request runs alongside settlement and the reply proceeds immediately. Before closing its credential, the body gives a locally validated report with measured counters up to one second from submission to reach the receiver. A missing, malformed, or oversized measurement adds no wait. The harness failure keeps its original exit code. A killed, interrupted, or unsuccessful harness may leave no readable usage report. A complete, bounded end report from a failed process still counts. The body ignores any individual end-usage object over 64 KiB. Without a readable report or transcript the attempt ends with source `none` and unknown counters.

Claude Code 2.1.327 prints uncached input, cache reads, and cache writes separately. Loom adds the three for inclusive input tokens. The result supplies aggregate counters. Usage iterations and distinct assistant message IDs supply model-call counts and the largest input sent to one call. Repeated assistant events for a message or tool use count once.

Codex CLI 0.162.1 reports inclusive input, cached input, cache writes, and output on `turn.completed`. Its ephemeral JSON stream identifies completed tool items but does not give per-call context or the number of model calls. A Codex turn can contain several calls. These two values stay unknown. agy 1.5.11 reports input, output, and cache read tokens on its result. Its completed tool steps supply the tool names and counts. Its turn count does not establish a model-call count. A prompt run with an isolated, unsigned-in home returned an authentication error with explicit zero token counts.

For the GraphQL queries, count definitions and observations, see [Reading job usage](job-usage.md).
