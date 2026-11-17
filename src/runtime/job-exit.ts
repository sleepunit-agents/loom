import type { jobs } from '../core/data/schema.js';

/** How a failed job says where it failed, with no private words: the exit code on its row.
 *
 * A job's log tail is dropped for a private conversation, and what a harness prints may hold the
 * conversation's words, so neither can carry the stage. The number can. The body's own program uses
 * BODY_EXIT; the worker uses WORKER_EXIT for a job whose body it could not get running; loom itself uses
 * LOOM_EXIT for a job it ended without any worker having run it. Any other code is the runner's own (a
 * builder, a custom runner), and 0 is success.
 *
 * The same number can be a machine's own runner's, meaning something of its own. So the row also keeps who
 * chose it (`jobs.exit_by`, ExitBy), and a stage is named only for a code one of loom's programs chose. */
/** Who chose a job's exit code. `body`: loom's body program, which the worker knows by having given it a
 * body's credential. `worker`: the worker, for a body it could not get running or that a signal ended.
 * `loom`: loom itself, for a job no worker ran. `runner`: a machine's own runner, given no credential. */
export type ExitBy = NonNullable<(typeof jobs.$inferSelect)['exitBy']>;
/** What a worker may report: `loom` is not a worker's to say. */
export const WORKER_EXIT_BY = ['body', 'worker', 'runner'] as const satisfies readonly ExitBy[];
export type WorkerExitBy = typeof WORKER_EXIT_BY[number];
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
  /** A later report failed while the body was at work: it lost loom, or loom had ended the job. The body
   * dropped what it was doing, whatever stage that was; the harness is not to blame. */
  contact: 20,
  /** The body's own tools server, which the harness is given, could not be started. (The next free number:
   * 21 to 27 are the worker's.) */
  tools: 28,
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
  /** This worker is not configured to serve the job: it has no command for the job's harness, or none it
   * can hold to the account loom placed it on, or (container bodies with `accountLogins`) no sign-in
   * directory for that account and harness. */
  runner: 27,
  /** The house's image does not say how a body of the job's harness starts in it (house-image.ts): the
   * house, not this machine, has to change. (28 is the body's, 29 is below, 31 is loom's.) */
  house: 30,
  /** The house's fetch and build did not finish within the build limit (`buildTimeoutMs`). The worker
   * reported on the job all the while; nothing was lost. (31 is loom's.) */
  buildTime: 32,
  /** The body did not end by itself: a signal ended its process (the system's memory killer, an operator's
   * kill). The body reported nothing, so this is the worker's word for it. (28 is the body's.) */
  killed: 29,
} as const;
/** What a container engine reports for a process a signal ended: 128 plus the signal's number. */
export const containerExit = (status: number): number => status > 128 && status <= 128 + 64 ? WORKER_EXIT.killed : status;

export const LOOM_EXIT = {
  /** No machine took the job within the queue deadline (Jobs.sweep): nothing ran. */
  unplaced: 31,
} as const;

const named = (who: string, codes: Record<string, number>) => new Map(Object.entries(codes).map(([stage, code]): [number, string] => [code, `${who} ${stage}`]));
const stages: Record<Exclude<ExitBy, 'runner'>, Map<number, string>> = {
  body: named('body', BODY_EXIT),
  // The worker says `killed`, about the body.
  worker: named('worker', WORKER_EXIT).set(WORKER_EXIT.killed, 'body killed').set(WORKER_EXIT.buildTime, 'worker build time'),
  loom: named('loom', LOOM_EXIT),
};
/** The stage a job's exit code names, for showing beside the number. Undefined for 0, for a runner's own
 * code, and for a code nobody said whose it is (a job ended before `exit_by` was kept): the same number
 * from a machine's own runner means something else, and a guessed stage would mislead. */
export function exitStage(code: number | null | undefined, by: ExitBy | null | undefined): string | undefined {
  return code == null || by == null || by === 'runner' ? undefined : stages[by].get(code);
}
