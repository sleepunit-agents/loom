/** The states of a job, sorted once into the groups the rest of the program asks about.
 *
 * Every state the `jobs.state` column allows is in exactly one of `unendedJobStates` and `endedJobStates`;
 * a test holds that, and holds the schema's one-unended-job-per-conversation index to the same list. Code
 * that asks "has this job ended", "is it some machine's now" or "is it still to be placed" imports the
 * group from here and never writes the names out again. */
import type { jobs } from './schema.js';

type JobState = typeof jobs.$inferSelect.state;
/** Claimed by a machine and not ended: the worker is preparing the job, or its body is running. These are
 * the states a silent job is swept from and the states in which a body's own credential is good. */
export const claimedJobStates = ['starting', 'running', 'waiting'] as const satisfies readonly JobState[];
/** Not ended: waiting for a machine, or claimed by one. A conversation has at most one such job. */
export const unendedJobStates = ['queued', ...claimedJobStates] as const satisfies readonly JobState[];
export const endedJobStates = ['done', 'failed', 'stopped', 'lost'] as const satisfies readonly JobState[];
/** Is this job some machine's now? A body's own credential is good only while its job is. */
export const jobClaimed = (state: JobState): boolean => (claimedJobStates as readonly JobState[]).includes(state);
export const jobUnended = (state: JobState): boolean => (unendedJobStates as readonly JobState[]).includes(state);
