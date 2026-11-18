/** How loom tells silence from absence: the one interval, and what has to fit inside it.
 *
 * A worker reports on its machine and on each job it holds every REPORT_MS, and a body reports its status
 * as often. Whatever has said nothing for SILENCE_MS is taken to be gone: a job is ended as lost and its
 * work tried again (Jobs.sweep), a machine is passed over by placement (selectPlacement) and its owner is
 * told (Machines.sweep). Everything that must arrive in time is derived from these two numbers here, so
 * that changing one cannot leave another behind. No I/O: the server, the worker and the body all read it.
 * The interval is read from the server's wall clock: docs/accepted-tradeoffs.md, "Silence is measured
 * on the server's wall clock". */
export const SILENCE_MS = 120_000;
/** How often the worker and the body report. Several reports fit in the silence interval, so one that is
 * dropped does not end anything. */
export const REPORT_MS = 15_000;

/** Worker requests bound both delivery of the last good reply and observation of the first missing one. */
export const WORKER_REQUEST_MAX_MS = 60_000;
export const WORKER_FAILURE_OBSERVATION_MS = 2 * WORKER_REQUEST_MAX_MS + REPORT_MS;

/** Maximum time for one last request when a contact window ends. */
export const CONTACT_PROBE_MS = 1_000;
