/** How much of each thing a thread's boards may hold (docs/specs/boards.md, "Limits"). Each number is written here
 * and nowhere else; a call that would pass one is refused with a message that says what to do instead. Nothing is
 * ever deleted to make room. */

/** Boards on a thread's trail (open) at once. */
export const BOARDS_OPEN_MAX = 20;
/** Boards a thread has had, open and closed. */
export const BOARDS_MAX = 200;
/** Live placements on one board, and placements a blueprint keeps. */
export const PLACEMENTS_MAX = 40;
/** Changes in one `boards.change` call. */
export const CHANGES_PER_CALL_MAX = 40;
/** Blueprints of one agent for one member. */
export const BLUEPRINTS_MAX = 100;
/** A brick's `params`, an action's `detail` and a blueprint's `arguments`, before the brick's own schema reads
 * them: how many keys, how long a key, and how long the whole as JSON. */
export const PARAMS_KEYS_MAX = 40;
export const PARAMS_KEY_MAX = 80;
export const PARAMS_JSON_MAX = 8_000;
/** `board_changes` rows one `boards.read` returns: what it takes when not told, and the most and fewest it may be
 * asked for. The fewest is more than one revision can hold, so a page always holds whole revisions. */
export const READ_CHANGES_DEFAULT = 100;
export const READ_CHANGES_MAX = 500;
export const READ_CHANGES_MIN = 50;
/** Sentences about the member's changes handed to a job at once: the latest, and a line counting the rest. */
export const TOLD_CHANGES_MAX = 50;
