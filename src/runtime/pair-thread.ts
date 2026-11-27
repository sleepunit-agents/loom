import { SHA256_HEX_WITHIN } from '../core/sha256-hex.js';
/** The thread of the owner's dedicated pairing room: the one place whose jobs publish native work cards.
 * It has a file of its own so the dispatcher can read it without loading what reads a harness's output. */
export const PAIR_THREAD = new RegExp(`^th:pair-${SHA256_HEX_WITHIN}$`);
