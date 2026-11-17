# Accepted trade-offs

Things in loom that are real, known, and left as they are on purpose. Each entry says what it is, where it
lives, why it was accepted, and what would change the answer. If you find one of these in the code and it
looks like an oversight, it is not; if you find something like it that is not listed here, it probably is.

Each stream of the code has its own heading.

## Running work

### The placed account is taken on trust when a machine has one command per harness

- **What.** loom places a job on an account it checked for room. A worker configured with `runners` (one
  command per harness) runs the job with that command, and the command is signed in to an account by its
  own environment. Nothing can check that it is the placed account.
- **Where.** `workerRunner` in `src/runtime/worker-process.ts`; `Dispatcher.accountChoices` in
  `src/runtime/dispatcher.ts`.
- **What is enforced.** loom tells the worker how many accounts of the job's provider are signed in on its
  machine. With more than one, a worker with one command for the harness refuses the job (exit code 27)
  unless the command declares `selectsAccount`. With `accountRunners`, a job runs only on the command
  bound to its account.
- **Why the rest is accepted.** With one account of the provider on the machine, the command can only be
  on that account unless someone signed its program in to another account outside loom. loom has no way
  to ask a third-party program which account it is signed in to.
- **What would change the answer.** A harness that reports the account it ran on. The worker could then
  compare it with the placed one and fail the job.

### Bodies a killed worker left that cannot be told from a stranger

- **What.** A worker that starts ends what a killed worker left (`src/runtime/worker-left.ts`). Three
  things are outside what it can do:
  1. A process group whose leader has gone, whose surviving members do not carry the body's scratch
     directory in their environment (a child that cleared its environment, or any system without
     `/proc`). The group's number may have been reused, so it is left running, counted, and reported on
     the worker's error stream.
  2. A killed worker that is never started again. Its body runs on until then. A body started by loom's
     own body program stops by itself at its next report after loom has ended the job (its credential
     dies with the job). A plain `{job,build}` runner has no such report and runs to its end, beside the
     retry if the retry was placed on another machine.
  3. Containers started by a worker from before the `loom.box` label existed. They are not removed.
- **Why accepted.** Killing a process group that cannot be shown to be loom's own is worse than leaving
  one running. Case 2 needs something on the machine that outlives the worker, which is a supervisor
  loom does not ship. Case 3 is one upgrade.
- **What would change the answer.** Running bodies under a supervisor that ends them when the worker
  dies (a systemd scope or a container for every body), or a harness-independent way to mark a process
  as a body's.

### Silence is measured on the server's wall clock

- **What.** A job or a machine is silent when its last report is more than two minutes old by the
  server's clock (`src/runtime/silence.ts`, `Jobs.sweep`, `Machines.sweep`, `selectPlacement`).
- **What is enforced.** After a jump of that clock, or a stall of the program, the sweep waits one whole
  interval before it calls anything silent (`createRuntime`), and a stamp left later than now is counted
  from now. A forward step no longer loses live jobs; a backward step no longer hides dead ones for its
  length.
- **Why the rest is accepted.** A jump therefore delays noticing a job that really died by up to one
  interval. Placement still passes over a machine whose stamp looks old or is in the future until its
  next report, at most fifteen seconds later.
- **What would change the answer.** Stamping reports with a count that only moves forward instead of a
  time, which is a schema change.

### A queued job has one deadline, whatever keeps it queued

- **What.** A job no machine has taken 24 hours after it could first be claimed is ended as failed
  (exit code 31) and not tried again (`QUEUE_DEADLINE_MS` in `src/runtime/jobs.ts`).
- **Why accepted.** Placement leaves a job queued for several reasons (no machine reporting, no account
  with room, no harness that can run it). Most pass by themselves, and loom does not record which one
  applied, so there is one rule and one number rather than a rule per reason. Work that waited a day
  for a usage window is ended although it could still have run.
- **What would change the answer.** Recording why placement passed a job over. A job no harness can ever
  run could then fail at once, and one waiting for room could wait as long as the window.

### The `waiting` job state has no writer

- **What.** `jobs.state` allows `waiting`, every reader treats it like `running`, and nothing in the
  program sets it. A body that is waiting for a person says so in the agent's status
  (`conversation.status`), not on its job.
- **Where.** `Jobs.heartbeat` in `src/runtime/jobs.ts` accepts it; `Dispatcher.heartbeat` keeps it.
- **Why accepted for now.** Removing the state is a schema change, and whether a job should show
  `waiting` is a product decision that has not been made.
- **What would change the answer.** Deciding it. Either the body's status report sets the job to
  `waiting` and back, or the state is dropped from the column.

### A body's credential and its tools bearer cannot be erased from memory

- **What.** The body's loom credential is erased as bytes, but the same value exists as JavaScript
  strings in the worker (when it writes the body's input) and in the body (in request headers). Strings
  cannot be erased; they last until the process ends or the garbage collector takes them.
- **Where.** `src/runtime/body-bootstrap.ts`, `src/runtime/worker-process.ts` (`release`),
  `src/runtime/body-program.ts`.
- **Why accepted.** The credential is good only while its job is unended and is useless after. Reading
  another process's memory needs the same user or root, who can already read everything the body can.
- **What would change the answer.** A runtime that sends bytes over HTTP and to a child's stdin without
  making a string of them.

### The body-tools bearer is readable by the body's own user

- **What.** Each body serves its tools on loopback behind a bearer made for that body. Claude Code gets
  it on a file descriptor. Codex takes a bearer only from an environment variable, and agy only from a
  file in its workspace. While the body lives, a process of the same user can read the variable from
  the Codex process, or the file (mode 0600, in the body's 0700 scratch directory).
- **Where.** `src/runtime/codex-body.ts`, `src/runtime/agy-body.ts`.
- **What is enforced.** The bearer is in no argument. Codex is told to leave the variable out of the
  commands its shell runs. The agy file is written only inside the scratch directory the worker named,
  which is removed after the body, and by the next worker if this one is killed.
- **Why the rest is accepted.** The bearer opens only that body's tools, which the model can already
  call, and it dies with the body. Another user cannot read either. Neither program offers another
  way in.
- **What would change the answer.** Codex or agy accepting a bearer on a pipe or file descriptor.

### A timezone change while loom is down is seen one firing late

- **What.** When the household's timezone changes while loom runs, standing wall-time triggers move to
  their next time in the new zone at once. The engine notices by comparing with the zone it last saw,
  which it keeps in memory. A change made while loom is down is not noticed: each trigger's stored next
  time is still the old zone's until it has fired or been skipped once.
- **Where.** `TriggerEngine.scan` and `rezone` in `src/core/tempo/triggers.ts`.
- **Why accepted.** The timezone is changed through loom, which is running when that happens.
- **What would change the answer.** Storing the zone each next time was worked out in, which is a schema
  change.
