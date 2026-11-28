/** What a frozen review's body (conversation.review) may call with its body token: its own reply, and the bookkeeping
 * of its own one job that the body program does for every job, none of which reaches anyone or anything else. This is
 * the whole list, and the one rule that applies it is where the token is authenticated (shared-credentials.ts,
 * `allows`, and `reads` for GraphQL and the live socket): every other operation a body token could reach is refused,
 * whatever its own `may` would say. So a reviewer talked round by the code it reads can hand nothing off (to a role,
 * to Codex, to its own body in another conversation, to a peer agent), message no other conversation, write no memory,
 * note or ticket, ask no question, read nothing of loom's, and ask for no secret or kit.
 *
 * - `conversation.message`: the reply (once, and only the body program's final answer: body-output.ts) and the
 *   session's own steps, both kept beside its own handoff conversation and nowhere else.
 * - `conversation.take`, `conversation.accept`, `conversation.confirm`: taking and settling its own mail, the brief.
 * - `conversation.status`: its own working state, which is how a body hears of a Stop.
 * - `conversation.turn`, `conversation.usage`: what its run cost, for its own job's record. */
export const FROZEN_REVIEW_CALLS: ReadonlySet<string> = new Set([
  'conversation.message', 'conversation.take', 'conversation.accept', 'conversation.confirm',
  'conversation.status', 'conversation.turn', 'conversation.usage',
]);
/** The one clientId a frozen review's reply is accepted under: the body program's final answer (runtime/body-program.ts). */
export const FROZEN_REVIEW_REPLY = 'review-result';
