/** What the boards page remembers of its bricks' answers (docs/specs/boards.md, "The page": "Off screen"): one
 * store for the signed-in member, in this page's memory and nowhere else (../data/graphql/remembered.ts). A board
 * that comes back on screen draws its bricks from it at once while the fresh answers arrive. It is emptied when
 * another member is signed in and when the session ends, and it ends with the page. */
import { rememberedAnswers, type RememberedAnswers } from '../data/graphql/remembered';

let held: { member: string; answers: RememberedAnswers } | undefined;
/** The store of this member's answers: a new, empty one when the member is not the one it was made for. */
export function rememberedFor(member: string): RememberedAnswers {
  if (held?.member !== member) { held?.answers.clear(); held = { member, answers: rememberedAnswers() }; }
  return held.answers;
}
/** Nobody is signed in: nothing is remembered. */
export function forgetAnswers() { held?.answers.clear(); held = undefined; }
