/** Where a body's proof can be reached from beside it, in process mode (t-2307).
 *
 * Every body in process mode runs as one user. Yama's ptrace_scope 1 stops one process attaching to another
 * that is not its descendant, so neither can read the other's memory. Opening /proc/<pid>/fd/<n> is a weaker
 * check (PTRACE_MODE_READ) that Yama does not narrow: any process of the same user may do it. What it gets
 * depends on what the descriptor is. A Unix socket cannot be opened that way. A pipe can, for reading and
 * for writing.
 *
 * These tests pin both halves. The words (and the job's proof in them) go in on stdin, a socket: nothing
 * beside the body can open it. The tools file on fd 3 is turned into a pipe so a harness can open
 * /dev/fd/3 by path, and until the harness has read it anyone of the same user can read it and put the same
 * bytes back, so the harness sees nothing amiss. The second test describes a hole, not a promise: it is
 * written so it fails the day the hole is closed, and then it should be turned round.
 * (Here the reader is the harness's parent. The same read from a process that is not, started under
 * systemd-run, was measured by hand on 2026-11-18; see docs/proof-reach.md.) */
import { spawn } from 'node:child_process';
import { closeSync, constants, openSync, readlinkSync, readSync, writeSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { runHarnessChild, type HarnessSpawn } from './body-harness.js';

const linux = process.platform === 'linux';
const tools = '{"mcpServers":{"loom":{"type":"http","url":"http://127.0.0.1:1","headers":{"Authorization":"Bearer t2307-not-a-real-bearer"}}}}';

/** Start a harness that waits a second before it reads its tools file, and hand back its pid once fd 3 is the pipe. */
async function waitingHarness() {
  let child: ReturnType<HarnessSpawn> | undefined;
  const recording: HarnessSpawn = (command, args, options) => (child = spawn(command, [...args], options) as ReturnType<HarnessSpawn>);
  const run = runHarnessChild({
    command: '/bin/sh', args: ['-c', 'sleep 1; /bin/cat /dev/fd/3; /bin/cat >/dev/null'], cwd: '/', env: { PATH: '/usr/bin:/bin' },
    words: 'the job\'s words', signal: AbortSignal.timeout(10_000), spawn: recording, control: Buffer.from(tools),
  });
  for (let tries = 0; tries < 400; tries++) {
    const pid = child?.pid;
    if (pid) try { if (readlinkSync(`/proc/${pid}/fd/3`).startsWith('pipe:')) return { pid, run }; } catch { /* not yet */ }
    await delay(5);
  }
  throw new Error('The harness never held its tools file on fd 3');
}

it.skipIf(!linux)('the words on stdin are a socket that nothing beside the body can open', async () => {
  const { pid, run } = await waitingHarness();
  expect(readlinkSync(`/proc/${pid}/fd/0`)).toMatch(/^socket:/);
  let code: string | undefined;
  try { closeSync(openSync(`/proc/${pid}/fd/0`, constants.O_RDONLY | constants.O_NONBLOCK)); } catch (error) { code = (error as NodeJS.ErrnoException).code; }
  expect(code).toBe('ENXIO');
  expect((await run).toString()).toBe(tools);
});

it.skipIf(!linux)('KNOWN HOLE: until the harness reads its tools file, another process of the same user can take the bearer and put it back unseen', async () => {
  const { pid, run } = await waitingHarness();
  const reader = openSync(`/proc/${pid}/fd/3`, constants.O_RDONLY | constants.O_NONBLOCK);
  const taken = Buffer.alloc(4096);
  // The pipe fills when the shell's own copy has run; until then a read finds nothing yet.
  let length = 0;
  for (let tries = 0; tries < 400 && length === 0; tries++) {
    try { length = readSync(reader, taken); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error; await delay(5); }
  }
  const writer = openSync(`/proc/${pid}/fd/3`, constants.O_WRONLY);
  writeSync(writer, taken.subarray(0, length));
  closeSync(writer); closeSync(reader);
  expect(taken.subarray(0, length).toString()).toContain('Bearer t2307-not-a-real-bearer');
  // The harness reads the same bytes it would have, and runs as though nothing happened.
  expect((await run).toString()).toBe(tools);
});
