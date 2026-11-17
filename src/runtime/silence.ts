/** How loom tells silence from absence: the one interval, and what has to fit inside it.
 *
 * A worker reports on its machine and on each job it holds every REPORT_MS, and a body reports its status
 * as often. Whatever has said nothing for SILENCE_MS is taken to be gone: a job is ended as lost and its
 * work tried again (Jobs.sweep), a machine is passed over by placement (selectPlacement) and its owner is
 * told (Machines.sweep). Everything that must arrive in time is derived from these two numbers here, so
 * that changing one cannot leave another behind. No I/O: the server, the worker and the body all read it. */
export const SILENCE_MS = 120_000;
/** How often the worker and the body report. Several reports fit in the silence interval, so one that is
 * dropped does not end anything. */
export const REPORT_MS = 15_000;
/** How long a worker may keep trying to deliver a job's finish report, tries and waits together. The last
 * report before it can be a whole REPORT_MS old, and loom must still hear the finish inside SILENCE_MS:
 * a finish that arrives after the sweep is refused, and work that had finished would be run again. */
export const FINISH_BUDGET_MS = SILENCE_MS / 2;
