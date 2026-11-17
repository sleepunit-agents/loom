/** The limits a worker's configuration is held to. The file is checked against them when it is read
 * (worker-program.ts) and each part checks again where it is used, because the parts are also built
 * directly by tests and the example household; both checks read the numbers here. */

/** The longest one step may take: reading an account's usage, a sign-in, setting up or cleaning up a container. */
export const STEP_DEADLINE_MAX_MS = 300_000;
/** How long a build is given when the configuration does not say. */
export const BUILD_DEADLINE_DEFAULT_MS = 300_000;
/** The longest a build may take. */
export const BUILD_DEADLINE_MAX_MS = 3_600_000;
/** A whole number of milliseconds from 1 to `max`. */
export const validDeadline = (ms: number, max: number): boolean => Number.isSafeInteger(ms) && ms >= 1 && ms <= max;
/** A name an environment variable can have. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** How long building a house's image is given when the configuration does not say: a first build on a
 * machine pulls a base image and installs a house's tools. `buildTimeoutMs` overrides it, up to BUILD_DEADLINE_MAX_MS. */
export const HOUSE_BUILD_DEFAULT_MS = 1_800_000;
/** How many jobs a worker with container bodies runs side by side when the configuration does not say
 * (`slots`), so that one house being built does not hold another agent's job. A worker whose bodies are
 * processes runs one unless it is told: its build command and runners are the operator's own. */
export const HOUSE_SLOTS_DEFAULT = 4;
/** The most jobs any worker may be told to run side by side. */
export const SLOTS_MAX = 16;
