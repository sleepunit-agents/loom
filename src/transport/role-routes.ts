/**
 * What the runtime and review roles may reach (docs/specs/conversations.md, "Who writes
 * what" and "Review tokens"). An allowlist: a route not named here refuses them, so a
 * route added anywhere else in the daemon can't widen them by accident. The tasks that
 * add their routes (conversations/turn, audit, audit/take, scores, …) extend this table
 * and dispatch the path in http-server.ts's loomApi.
 *
 * Paths are core's own API, POST /api/loom/<path> (GET for GET_ROUTES). Neither role reaches MCP, /cli, the
 * page, a piece's API or a piece's store.
 */
export type NarrowRole = 'runtime' | 'review';

/**
 * POST /api/loom/deliver (docs/specs/agent-runtime.md, "Delivery"): the runtime's, and also
 * the one core route every piece credential reaches (as its own piece), dispatched before
 * this table is consulted (http-server.ts, handlePieceApi). Owner, agent, peer and review
 * tokens never reach it.
 */
export const DELIVER_ROUTE = 'deliver';

/**
 * POST /api/loom/people/ensure (docs/specs/person-cards.md, "Ensure"): make sure a person has a
 * card. The runtime's (its gates name a card), and also a household owner's and a piece's
 * credential carrying an owner's grant (X-Loom-Store-Grant), dispatched before this table is
 * consulted (http-server.ts, ensureApi). Agent, peer and review tokens never reach it: an
 * agent writes cards with person_write.
 */
export const ENSURE_ROUTE = 'people/ensure';

/**
 * POST /api/loom/people/merge (docs/specs/person-cards.md, "Merge"): make two person cards one.
 * The runtime's (its gates may find two cards are one person), and a household owner's,
 * dispatched before this table is consulted (http-server.ts, mergeApi). Agent, piece, peer and
 * review tokens never reach it: an agent merges with person_merge.
 */
export const MERGE_ROUTE = 'people/merge';

export const ROLE_ROUTES: Readonly<Record<NarrowRole, readonly string[]>> = {
  // comms/adapter and comms/activity: venue loom's adapter calls and tool cards (docs/specs/comms.md).
  // pieces/changed: its manifest moved (a body at work, or done), so open apps ask again now (docs/extensions.md, t-1945).
  // conversations/house: which one conversation a body's house holds, said before it's handed a body (t-2061).
  runtime: ['review/token', 'conversations/turn', 'conversations/house', DELIVER_ROUTE, 'audit', 'scorecards', 'review/config', ENSURE_ROUTE, MERGE_ROUTE, 'comms/adapter', 'comms/activity', 'pieces/changed'],
  review: ['audit/take', 'audit/done', 'scores', 'findings'],
};

/**
 * Of ROLE_ROUTES, the ones that are GET (the rest are POST): the scorecards and the review's
 * settings. (GET /api/loom/venues is RUNTIME_GET_ROUTES, answered before this table.)
 */
export const GET_ROUTES: readonly string[] = ['scorecards', 'review/config'];

/**
 * Of those routes, the ones an agent token reaches too: a harness writes its own session's
 * turns, and their audit entries, as the agent (docs/specs/conversations.md, "Who writes what"). Owner, peer and piece
 * tokens reach none of them.
 */
export const AGENT_ROUTES: readonly string[] = ['conversations/turn', 'audit'];

/**
 * GET /api/loom/<path>, answered before ROLE_ROUTES is read: what core tells the runtime. `venues`: every
 * venue with its kind, piece and `send` argv (household-store.ts, venueDirectory).
 */
export const RUNTIME_GET_ROUTES: readonly string[] = ['venues'];

/** Whether `role` may call /api/loom/<path> (POST, or GET for GET_ROUTES). */
export function roleReaches(role: NarrowRole, path: string): boolean {
  return ROLE_ROUTES[role].includes(path);
}
