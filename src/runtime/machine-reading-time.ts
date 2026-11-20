/** How often a worker reads its machine, unless its configuration says. */
export const MACHINE_CHECK_MS = 5 * 60_000;

/** Three default intervals. The web app marks older readings and loom publishes their return immediately. */
export const READING_OLD_MS = 3 * MACHINE_CHECK_MS;
