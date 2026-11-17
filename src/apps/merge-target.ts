/** What a merge approval is about: one change at one exact commit, written
 * `github:<owner>/<repo>#<number>@<40 hex>`. The card that asks, the standing rules that answer, the
 * commands that act on an answer and the sweep that expires one all make and read it here. */

/** A whole commit id, as GitHub gives it. */
export const COMMIT = /^[0-9a-f]{40}$/;
const TARGET = /^(github:([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)#[1-9][0-9]*)@([0-9a-f]{40})$/;

/** The target for a change (its id is `github:<owner>/<repo>#<number>`) at a head commit. */
export const mergeTargetFor = (change: string, head: string): string => `${change}@${head}`;

/** The change's id, its repository (`<owner>/<repo>`) and the commit, or undefined when this is not a merge target. */
export function parseMergeTarget(target: string): { change: string; repository: string; head: string } | undefined {
  const match = TARGET.exec(target);
  return match ? { change: match[1], repository: match[2], head: match[3] } : undefined;
}
