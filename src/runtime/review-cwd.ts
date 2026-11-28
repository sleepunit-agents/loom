/** Where a frozen review's harness starts (conversation.review): outside its copy, so no harness can take a file of the
 * reviewed tree for its own instructions by finding it in or above its working directory. The body's scratch directory
 * when it has one, else the house's own; never the copy (review-brief.ts, REVIEW_MOUNT) or anything under it. */
import { posix } from 'node:path';
import { REVIEW_MOUNT } from '../core/conversations/review-brief.js';

const inCopy = (path: string) => { const at = posix.normalize(path); return at === REVIEW_MOUNT || at.startsWith(REVIEW_MOUNT + '/'); };
export function frozenReviewCwd(houseCwd: string, scratch: string | undefined): string {
  const chosen = scratch && scratch.startsWith('/') && !inCopy(scratch) ? scratch : houseCwd;
  if (!chosen.startsWith('/') || inCopy(chosen)) throw new Error('A frozen review\'s harness may not start in its copy');
  return chosen;
}
