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
/** How many bodies a worker runs on one account at once when the configuration does not say
 * (`accountSlots`); never more than its slots. */
export const ACCOUNT_SLOTS_DEFAULT = 4;
/** The oldest git a worker with container bodies fetches houses with: the newest of the first releases
 * of what the fetch uses. `--no-write-fetch-head` came in 2.29, settings given in the environment
 * (`GIT_CONFIG_COUNT`) in 2.31, and running with no per-user configuration file (`GIT_CONFIG_GLOBAL`) in
 * 2.32. Reading a commit's tree and files (`ls-tree`, `cat-file`) is far older. */
export const GIT_MINIMUM = [2, 32, 0] as const;
/** The most one file of a house's build context may hold, and the most the whole context may: past either
 * the job fails as a failed build, before anything is sent to the engine. */
export const CONTEXT_FILE_MAX = 104_857_600, CONTEXT_MAX = 1_073_741_824;
/** The most files and links a context may have, and the longest name or link target, in bytes. */
export const CONTEXT_ENTRIES_MAX = 50_000, CONTEXT_NAME_MAX = 4_096;
