/** How long a sign-in link is good for, at most. Stated here and nowhere else: the service that makes links
 * clamps to it, and the operator's request refuses to ask for more. It has a file of its own so the
 * command line can read it without loading the database. */
export const LINK_MS = 5 * 60_000;
