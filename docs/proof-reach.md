# Where a job's proof lives, and who can reach it

Written for t-2307 on 2026-11-18, against `art/mcp-first` at 0edb8d5f. The question is whether one body
on a machine can use another job's proof to read that job's mail, session or files, or to post as it.
Each claim below is either cited to a source line or marked as measured. Measurements were taken on
loom's machine (Linux, `kernel.yama.ptrace_scope` = 1).

## What a job's proof is

A job has two secrets.

- **The body credential.** The worker makes it and binds its fingerprint to the job with
  `runtime.enrollBody` (`src/shared-body-enrollment.ts`). It reaches the body on stdin, inside the
  words. It is what the body uses to speak to loom as that job.
- **The tools bearer.** Each body serves loom's tools on loopback behind a bearer made for that body.
  Claude Code gets it in an MCP config read from `/dev/fd/3` (`src/runtime/claude-body.ts:79`,
  `src/runtime/body-harness.ts:107-156`). Codex gets it from an environment variable, and agy from a
  file in its scratch directory (`docs/accepted-tradeoffs.md`, "The body-tools bearer is readable by
  the body's own user").

A proof stops working when the job ends, when the machine's worker token is revoked, or after two
minutes with no word from the body.

## Process mode: every body is the same user

### What holds

- **Memory.** Reading another process's memory needs ptrace attach. Yama scope 1 allows that only on a
  descendant, and bodies are siblings, so one body cannot read another's memory.
- **Arguments and environment.** Neither secret is in argv. The Claude Code bearer is not in the
  environment.
- **Stdin.** Node's stdio pipes are Unix sockets, and a socket cannot be opened by its `/proc` path
  (`ENXIO`). A body beside the job cannot read the credential off another body's stdin. Pinned by
  `src/runtime/body-harness-proof.test.ts`, "the words on stdin are a socket…".
- **A second enrolment.** `runtime.enrollBody` refuses to bind a new fingerprint to a job that already
  has a live body token. Tested in `src/shared-body-enrollment.test.ts`, "refuses a second body for a
  job that has a live one…". (The 06:02 trace on t-2307 named this gap; it has since been fixed.)

### What does not hold

1. **The Claude Code tools file can be read, and put back, until the harness has read it.** To let
   Claude Code open `/dev/fd/3` by path, `runHarnessChild` turns Node's socket into an anonymous pipe
   (`exec 3< <(/bin/cat <&3)`). Opening `/proc/<pid>/fd/<n>` needs only PTRACE_MODE_READ, which Yama does
   not narrow, so any process of the same user can do it. A pipe opened that way can be read from and
   written to. Another body can read the MCP config with its bearer and write the same bytes back, and
   the harness then starts as though nothing happened. The window runs from the spawn until Claude Code
   reads its config.
   - *Measured, 2026-11-18.* A holder started with `systemd-run --user`, so not a descendant, held
     `SECRET-BEARER-XYZ` on fd 3. From another shell, `cat /proc/<pid>/fd/3` printed it. A Python reader
     took the bytes and wrote them back, and the holder's own later read got the same bytes.
   - *Pinned* by `src/runtime/body-harness-proof.test.ts`, the "KNOWN HOLE…" test, through
     `runHarnessChild` itself. In that test the reader is the harness's parent; the non-descendant case
     is the measurement above. The test is written to fail on the day this is closed.
   - *What it opens.* That body's tools: its mail and what it posts, as that job, until the job ends.
2. **A body's files are readable by every other body.** That covers the 0700 scratch directory of each
   body (`src/runtime/worker-left.ts:127-146`) and the harness's own session files: for Claude Code,
   `$CLAUDE_CONFIG_DIR/projects/<cwd>/<session>.jsonl`, which holds the mail as the model saw it
   (`src/runtime/claude-body.ts:118-123`). It also covers the agy bearer file. The Codex bearer is
   readable from that process's `/proc/<pid>/environ`, which is the same PTRACE_MODE_READ check.
3. **The worker's own token file is readable by every body.** The path is in the worker configuration,
   which is named on the worker's command line (`src/runtime/worker-program.ts:157`). Whoever holds that
   token is the worker: it can take queued jobs with `next`, along with their mail. The enrolment fix
   above stops a holder from adding a second body to a job that is already `starting`. It does not stop
   it from claiming a job before the real worker does.
4. **A body's descendants outlive it.** Process mode ends a body by killing its process group
   (`src/runtime/worker-process.ts:44-48`). A `setsid` child escapes the group. (Observed today in
   another form: an orphaned `find /` kept running under `systemd --user` after its session ended.) So
   holes 1 to 3 do not need two bodies at once. One body can leave a watcher behind that reads the next
   job's files and tools file, even with `slots` at 1.

All four need a body that can run commands. Guest-woken bodies get no shell (`bodyReach` in
`src/runtime/harness-traits.ts:33`). Every other body does, including household members' bodies, not
just the owner's.

## A house

A house is a container per agent, and the worker token cannot be mounted into it. Nothing of another
container is reachable from inside one. What a house shares is the account sign-in directory and the
agent's own mounts. Holes 1 to 4 then only reach bodies of the same agent in the same house. (This is
from the 06:02 trace; this pass added no new measurement inside a house.)

## What closing it needs

Holes 2 to 4 are what it means for bodies to be one user, and no change inside the body program closes
them. What would:

- **Only the owner's jobs get a shell in process mode.** Every other job, a member's or a guest's, either
  runs at reach `loom` or is placed in a house. The owner can already read everything in the loom, so
  the owner's own bodies reading each other is no new reach. This is one rule in `bodyReach` plus
  placement, and it closes the path from one principal's body to another principal's job.
- **A user per body** (the worker runs each body as a distinct system user). This closes all four but
  needs root at setup.
- **Bodies in their own cgroup** (a transient systemd scope), so the whole tree dies with the body. This
  closes hole 4 only.

Hole 1 can be narrowed on its own. One way is for the tools server to accept its bearer only once and
bind the session to the connection that used it, which turns a silent theft into a visible failure. That
depends on Claude Code never reconnecting with a fresh session, which has not been checked.

The decision is on t-2307.
