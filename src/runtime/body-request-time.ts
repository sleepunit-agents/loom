/** How long a body waits for one answer from the door when nobody says, and the longest it may be told to
 * wait. Both of the body's clients (commands, and its conversation) read these. */
export const BODY_REQUEST_MS = 15_000, BODY_REQUEST_MAX_MS = 30_000;
export const validBodyRequestMs = (ms: number) => Number.isSafeInteger(ms) && ms >= 1 && ms <= BODY_REQUEST_MAX_MS;
