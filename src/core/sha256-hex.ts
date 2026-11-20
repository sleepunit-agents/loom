/** A SHA-256 digest written as lower-case hex: the shape of a credential's fingerprint, of a sign-in link's
 * one-time code, and of the references the door hands out for a browser session or a device. Stated here
 * and nowhere else. It has a file of its own so the command line can read it without loading anything. */
export const SHA256_HEX = /^[a-f0-9]{64}$/;
/** The same for use inside a longer pattern: no anchors. */
export const SHA256_HEX_WITHIN = '[a-f0-9]{64}';
/** The path of a sign-in link: `/login/` and its code. */
export const LOGIN_PATH = new RegExp(`^/login/${SHA256_HEX_WITHIN}$`);
