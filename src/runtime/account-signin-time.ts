/** How long a relayed account sign-in may take, for the two programs that time it: loom, which keeps the
 * request, and the worker, which runs the provider's own program. A file of its own with no imports, so
 * each reads it without loading the other. */

/** Loom: a request nobody finished is over after this long. The provider's own page and code have lapsed by then. */
export const SIGNIN_MS = 20 * 60_000;
/** The worker: how long it lets the provider's program run when its configuration does not say, and the
 * longest its configuration may ask for. Longer than the provider's page and code last, and shorter than
 * loom keeps the request open by five minutes, so the worker's own word on how the sign-in ended arrives
 * while there is still a request to record it on. */
export const RELAY_MS = SIGNIN_MS - 5 * 60_000;
