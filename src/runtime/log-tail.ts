/** How much of a job's output is kept as its log: the last LOG_TAIL_MAX characters.
 *
 * The worker cuts what a body or a build wrote to this before it reports the job's end, the door refuses
 * a finish report that carries more, and the store cuts again before it writes. A worker that cut later
 * than the door allows would have every finish report refused, and its jobs would never be recorded as
 * ended; so all three read the number here. A file of its own with no imports: the worker and the server
 * both read it and neither loads the other. */
export const LOG_TAIL_MAX = 16_384;
export const logTail = (text: string): string => text.slice(-LOG_TAIL_MAX);
