/** Why a relayed account sign-in did not finish: the words a worker may say, and loom's sentence for each.
 *
 * The worker sends a word and loom stores and shows its own sentence, so nothing a provider's program
 * printed, which could repeat a code or a token, reaches a database row or the owner's inbox. Loom keeps
 * this rule itself (runtime.signInDone): whatever else a worker sends becomes SIGNIN_UNSAID.
 */
/** What the machine's sign-in program may write, alone on the first line of its `why` file. */
export const SIGNIN_PROGRAM_REASONS = Object.freeze({
  refused: 'The provider refused the sign-in',
  'wrong-code': 'The provider did not accept the code',
  expired: 'The page or the code ran out before the sign-in finished',
  unreachable: 'The provider could not be reached from this machine',
  'not-installed': 'The provider\'s program is not installed on this machine',
});
/** Every word a worker may send: the program's, and the worker's own about how the relay went. */
export const SIGNIN_REASONS = Object.freeze({
  ...SIGNIN_PROGRAM_REASONS,
  unsaid: 'The provider\'s program says the account is not signed in',
  'no-page': 'The sign-in program gave no usable page',
  'no-program': 'This machine has no sign-in program for this provider',
  'cannot-run': 'The sign-in could not be run on this machine',
  ended: 'The sign-in was ended before it finished',
  'timed-out': 'Nobody finished the sign-in in time',
  stopped: 'The worker stopped',
});
export type SignInReason = keyof typeof SIGNIN_REASONS;
/** What loom says when a worker gives no reason, or one that is not in the list. */
export const SIGNIN_UNSAID = 'The sign-in did not finish';
export const signInReason = (word: string | undefined): string =>
  word !== undefined && Object.hasOwn(SIGNIN_REASONS, word) ? SIGNIN_REASONS[word as SignInReason] : SIGNIN_UNSAID;
