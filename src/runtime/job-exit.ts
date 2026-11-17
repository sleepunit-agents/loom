/** How a failed job says where it failed, with no private words: the exit code on its row.
 *
 * A job's log tail is dropped for a private conversation, and what a harness prints may hold the
 * conversation's words, so neither can carry the stage. The number can. The body's own program uses
 * BODY_EXIT; the worker uses WORKER_EXIT for a job whose body it could not get running. Any other code is
 * the runner's own (a builder, a custom runner), and 0 is success. */
export const BODY_EXIT = {
  /** Unexpected failure before the body knew what it was asked to do. */
  input: 1,
  /** Not a failure: the body saw a Comms Stop, dropped its work and left. loom records the job as stopped
   * when a Stop really is waiting for it (Jobs.finish); the body does not take the Stop itself. */
  stopped: 10,
  startup: 11, mail: 12, identity: 13, harness: 14, record: 15,
  /** The machine's body file could not be read or is not valid. */
  config: 16,
  /** What the worker handed over on stdin is not a body's input. */
  envelope: 17,
  /** The assignment names a harness or a venue this body cannot serve. */
  assignment: 18,
  /** The first report to loom failed: loom unreachable, or the job no longer this body's. */
  report: 19,
} as const;
export const WORKER_EXIT = {
  /** Fetching the private repository input. */
  input: 21,
  build: 22,
  /** Starting the body's process. */
  launch: 23,
  /** Registering the body's credential with loom. */
  enroll: 24,
  /** Handing the started body its input. */
  release: 25,
  /** The body's process could not be watched or reaped to its end. */
  reap: 26,
} as const;

const stages = new Map<number, string>([
  ...Object.entries(BODY_EXIT).map(([stage, code]): [number, string] => [code, `body ${stage}`]),
  ...Object.entries(WORKER_EXIT).map(([stage, code]): [number, string] => [code, `worker ${stage}`]),
]);
/** The stage a job's exit code names, for showing beside the number; undefined for 0 and for a runner's own code. */
export function exitStage(code: number | null | undefined): string | undefined {
  return code == null ? undefined : stages.get(code);
}
