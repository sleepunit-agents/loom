/** How the worker program says why it stopped: one exit code and one fixed line for each stage it can
 * fail in, so that whoever runs the machine can tell an invalid configuration from a held state directory
 * from a process that would not die. The line is the worker's own words and never the error's: what a
 * command, a configuration file or loom said may hold a credential or a conversation's words.
 *
 * These are the worker process's own exit codes. A job's exit code (job-exit.ts) is a different thing,
 * recorded on the job's row; the numbers are kept apart all the same. 0 is a worker that was asked to stop. */
export const WORKER_STOP = {
  /** A failure in none of the stages below: a defect in the worker. */
  unexpected: [1, 'an unexpected failure'],
  /** Not started as `loom-worker <configuration-file>` or as `loom-worker --account-usage <file>`. */
  usage: [40, 'expected the path of one configuration file'],
  config: [41, 'the configuration file could not be read or is not valid'],
  token: [42, 'the token file could not be read'],
  /** What works for loom or runs the bodies could not be made from the configuration (a deadline out of
   * range, an unsupported platform). */
  setup: [43, 'the worker could not be set up from its configuration'],
  state: [44, 'the state directory is not a private directory of this user'],
  held: [45, 'another worker is running on the state directory'],
  left: [46, 'a process a previous worker left running could not be ended'],
  health: [47, 'the first health report to loom failed'],
  refresh: [48, 'the account usage refresh stopped'],
  /** Thrown out of the job slot. A report loom did not answer never does that; a body that could not be
   * ended does, and the worker must not take work beside it. */
  slot: [49, 'a body it started could not be ended, so it takes no more work'],
  /** `--account-usage`: the command failed, was interrupted, or loom did not take its report. */
  account: [50, 'the account command did not complete'],
  /** `--account-signin`, which this program no longer has. The one way to sign an account in on a machine
   * is the relay (account-signin-relay.ts). */
  signin: [51, '--account-signin was removed; sign the account in from loom (runtime.accountSignIn), which runs the provider\'s program listed under accountSignIn.programs in this worker\'s configuration'],
  /** A path under `accountLogins` or `container.mounts`, or `container.socket` or `container.nestedSocket`
   * (worker-mounts.ts has the rules). The line is followed by the configuration key at fault, never by a path. */
  mounts: [52, 'a path the configuration gives to containers, or an engine socket, cannot be used: a mounted directory that is not an existing directory of this user written as its real path, an engine socket that is not an existing socket, a path not written as a plain absolute path, or a mounted directory that overlaps another, an engine socket, the state directory or the token file'],
  /** A worker with container bodies builds each house itself and reads from the image how a body starts.
   * The line is followed by the key that must go: `build`, `runners`, `accountRunners`, or `container.mounts`
   * when it is one list and not a list for each agent. */
  retired: [53, 'the configuration has a key that a worker with container bodies no longer takes: it builds each house itself from the agent\'s repository, the image says how a body starts, and mounts are listed by agent'],
  /** A worker with container bodies fetches house repositories with the machine's git. */
  git: [54, 'git 2.29 or later, which fetches each house\'s repository, could not be run on this machine'],
  /** The directory the worker is installed in is mounted into every container for the body program. */
  program: [55, 'the directory the worker is installed in cannot give containers the body program: dist/body.js or a package it depends on is not inside it (its packages must be in its own node_modules, as a global npm install puts them)'],
} as const satisfies Record<string, readonly [code: number, line: string]>;
export type WorkerStopStage = keyof typeof WORKER_STOP;
/** A failure that names its own stage, for the ones the worker program cannot tell apart by where it was. */
export class WorkerStop extends Error {
  /** @param key For a stage that can be reached from many entries of the configuration: the configuration
   * key at fault (`container.mounts[1].source`). A key, with an account's id or a harness's name in it at
   * most; never the value written under it, so never a path. */
  constructor(readonly stage: WorkerStopStage, readonly key?: string) { super(WORKER_STOP[stage][1]); }
}
/** The line the worker program prints when it stops at this stage. */
export const workerStopLine = (stage: WorkerStopStage, key?: string): string => `Worker stopped: ${WORKER_STOP[stage][1]}${key ? ` (${key})` : ''}\n`;
