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
  /** Not started as `loom-worker <configuration-file>` or as one of the two account commands. */
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
  /** `--account-signin` or `--account-usage`: the command failed, was interrupted, or loom did not take its report. */
  account: [50, 'the account command did not complete'],
} as const satisfies Record<string, readonly [code: number, line: string]>;
export type WorkerStopStage = keyof typeof WORKER_STOP;
/** A failure that names its own stage, for the ones the worker program cannot tell apart by where it was. */
export class WorkerStop extends Error {
  constructor(readonly stage: WorkerStopStage) { super(WORKER_STOP[stage][1]); }
}
/** The line the worker program prints when it stops at this stage. */
export const workerStopLine = (stage: WorkerStopStage): string => `Worker stopped: ${WORKER_STOP[stage][1]}\n`;
