/** What a frozen review's body (conversation.review) may reach with its body token: its own reply, and the bookkeeping
 * of its own one job that the body program does for every job. This is the whole list, and ONE rule applies it,
 * `frozenReviewReaches`, asked of every request at loom's outside door before any route runs (shared-root.ts, the
 * first middleware) and of the live socket (shared-root.ts, nextData's authentication): every other operation, route
 * or read a body token could reach is refused, whatever its own `may` would say. So a reviewer talked round by the
 * code it reads can hand nothing off (to a role, to Codex, to its own body in another conversation, to a peer agent),
 * message no other conversation, write no memory, note or ticket, ask no question, read nothing of loom's (no GraphQL,
 * no MCP door, no live socket), and ask for no secret or kit.
 *
 * Each one, and why it is its own job's bookkeeping and can reach nobody:
 * - `conversation.message`: for a frozen review, only two kinds pass its own checks (body-output.ts). `reply` under
 *   FROZEN_REVIEW_REPLY, once: the body program's final answer, which loom holds unfiled until the job has ended
 *   (review-result.ts) and only then files and relays to the asking thread. And `card`: one of the session's own
 *   steps, sealed in job_trace beside its own handoff conversation, which wakes nobody and is read only by those who
 *   may read that conversation. `progress` is refused for a handoff, as it is for every one.
 * - `conversation.take`: takes its own conversation's mail, the brief (body-input.ts).
 * - `conversation.accept`, `conversation.confirm`: settles that same mail; any other item is refused (heldMail).
 * - `conversation.status`: its own working state, which is how a body hears of a Stop. It writes the agent's status
 *   row in loom's fixed private words ("Working privately"), never the body's.
 * - `conversation.turn`: a turn row in its own conversation, with no words.
 * - `conversation.usage`: what its run cost, on its own job's usage row. */
export const FROZEN_REVIEW_CALLS: ReadonlySet<string> = new Set([
  'conversation.message', 'conversation.take', 'conversation.accept', 'conversation.confirm',
  'conversation.status', 'conversation.turn', 'conversation.usage',
]);
/** The one clientId a frozen review's reply is accepted under: the body program's final answer (runtime/body-program.ts). */
export const FROZEN_REVIEW_REPLY = 'review-result';
/** The one rule: a path of loom's outside door a frozen review's body token may reach. Only `/api/<piece>/<operation>`
 * for an operation in FROZEN_REVIEW_CALLS (conversation.take is served at its own route of that same shape). */
export function frozenReviewReaches(path: string): boolean {
  const found = /^\/api\/([^/]+)\/([^/]+)$/.exec(path);
  return !!found && FROZEN_REVIEW_CALLS.has(found[1] + '.' + found[2]);
}
/** The refusal the door gives a frozen review's body for anything else. */
export const FROZEN_REVIEW_REFUSAL = 'A frozen review may call only its own reply and its job\'s bookkeeping';
