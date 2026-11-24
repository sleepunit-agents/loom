/** The most earlier words handed to a body with its mail, as the bytes of their JSON. loom builds no more
 * than this and a body takes no more. A file of its own with no imports, so a body can load it. */
export const HISTORY_BYTES = 1024 * 1024;
/** The most lines of earlier words handed over, whatever their size: loom builds no more, for a Comms thread
 * (history-context.ts) or a bridge conversation (bridge-history.ts), and a body takes no more. */
export const HISTORY_LINES = 100;

/** Private checkpoint coverage is scoped to one thread. A member's input keeps its inbox ID,
 * and a stored reply keeps the message sequence returned to its producer. */
export const threadInputKey = (item:string) => 'input:'+item;
export const threadReplyKey = (seq:number) => 'reply:'+seq;
