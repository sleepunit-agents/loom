/** Who a caller is, for as long as their credential stays good. The door makes one per request or socket
 * (src/core/data/authentication.ts). */
import type { Viewer } from '../../policy.js';
/** activity records incoming authenticated use; valid stays a side-effect-free authority check. */
export interface Authentication { activity?(): void; window?: boolean; viewer: Viewer; valid(): boolean; expiresAt?: number }
