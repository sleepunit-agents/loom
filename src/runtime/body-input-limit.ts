/** One ceiling for the receiving envelope and the native input it contains.
 * Native output keeps its separate, narrower bound. */
export const BODY_INPUT_BYTES=16_777_216;
/** The most a body reads from its standard input at start: the job, the build and its own token. */
export const BODY_START_BYTES=1_048_576;
