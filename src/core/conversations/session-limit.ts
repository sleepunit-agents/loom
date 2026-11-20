/** The limits of a kept harness session, said once. A file of its own with no imports, so a body can load
 * it and decline to save what loom would refuse.
 *
 * `SESSION_BYTES` is the most a packed session holds: its files, gzipped. One request through loom's door
 * carries it (core/data/door-limit.ts, base64 in JSON), which is what bounds it. A session past it is not
 * kept, and the next body starts fresh with the conversation's kept history.
 * How long a session is kept is the household's keep time for words (core/data/comms-days.ts), counted
 * from the oldest erasable word it holds and not from when it was last saved (sessions.ts). */
export const SESSION_BYTES = 700 * 1024;
/** The most a packed session may unpack to: a bound on what a pack can make the body that opens it hold. */
export const SESSION_UNPACKED_BYTES = 48 * 1024 * 1024;
/** The most files a packed session lists. */
export const SESSION_FILES = 64;
/** A harness session's id, as it may appear in a file name: never a path. */
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{3,127}$/;
/** Sessions are handed on within one family of models and not across: the first part of the model's name. */
export const modelFamily = (model: string): string => model.toLowerCase().split(/[-.:/]/)[0];

// Up to 100 retained history lines, 100 current messages, and the body's own reply.
export const SESSION_HISTORY_KEYS = 201;
