/** A body's own token: what it looks like, stated once. The worker makes it (and sends loom only its
 * fingerprint), hands it to the body in the starting envelope, and both ends of that hand-over check the
 * shape they were given against this one. No imports beyond Node's, so a body can load it. */
import { randomBytes } from 'node:crypto';

const PREFIX = 'body_', RANDOM_BYTES = 32;
/** The token as text: the prefix and 64 hex digits. */
export const BODY_TOKEN = new RegExp(`^${PREFIX}[a-f0-9]{${RANDOM_BYTES * 2}}$`);
/** The token's length in bytes; it is ASCII, so in characters too. */
export const BODY_TOKEN_BYTES = PREFIX.length + RANDOM_BYTES * 2;
/** A new token, as bytes the caller can erase. */
export const mintBodyToken = (): Buffer => Buffer.from(PREFIX + randomBytes(RANDOM_BYTES).toString('hex'), 'ascii');
