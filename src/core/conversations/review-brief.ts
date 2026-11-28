/** The brief a frozen review's body is given (conversation.review, handoff.ts). Loom writes it, from fixed parts: the
 * work role's own description, what is reviewed and where its copy is, the rule for the answer, and the contract the
 * requester names (a ticket, a spec section, acceptance criteria) in the requester's words. Nothing else goes in: no
 * line of the author's conversation, no session transcript or report, and no pull request description unless the
 * requester asked for it (`description`). The words are the requester's, so loom cannot stop a requester pasting its
 * own reasoning into them; it can and does see that nothing else of the author's is added. */
import type { ReviewTarget } from './review-place.js';

/** Where the worker puts the frozen copy in the body's container (runtime/review-snapshot.ts). */
export const REVIEW_MOUNT = '/review';
export const REVIEW_TREE = `${REVIEW_MOUNT}/tree`, REVIEW_DIFF = `${REVIEW_MOUNT}/change.diff`, REVIEW_FACTS = `${REVIEW_MOUNT}/review.json`;

export interface ReviewBriefInput {
  role: { id: string; description: string };
  target: ReviewTarget;
  /** The pull request, when it is one: its number and the branch it merges into. */
  pull?: { number: number; baseBranch: string };
  contract: string;
  /** The pull request's description, only when the requester asked for it to be included. */
  description?: string;
}

export function reviewBrief(input: ReviewBriefInput): string {
  const { target, pull } = input;
  const against = pull ? `${target.base}, the merge base of the pull request with ${pull.baseBranch}` : `${target.base}, the commit's parent`;
  return [
    `Assigned work role: ${input.role.id}`,
    input.role.description,
    '',
    'You are reviewing one exact commit, frozen for this review. You are given what to review and the contract to review it against, and nothing of the author\'s reasoning.',
    `- Repository: ${target.repository}`,
    ...(pull ? [`- Pull request: ${target.repository}#${pull.number}`] : []),
    `- Commit under review: ${target.head}`,
    `- Diff taken against: ${against}`,
    `The commit's files are in ${REVIEW_TREE}, its diff is ${REVIEW_DIFF}, and ${REVIEW_FACTS} names the same commits. The copy is read-only and this job holds no credential that can push: review the change, do not try to change it.`,
    'List each finding with its severity (CRITICAL, MAJOR, MINOR or NIT), the file and line, and why it matters.',
    'End your answer with one final line, exactly `VERDICT: CLEAR` or `VERDICT: BLOCKING`. An answer without that line is recorded as a failed review.',
    '',
    'Contract to review against (the requester\'s words):',
    input.contract,
    ...(input.description !== undefined ? ['', 'Pull request description, included at the requester\'s request:', input.description] : []),
  ].join('\n');
}
