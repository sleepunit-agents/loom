/**
 * What the runtime and review roles may reach (docs/specs/conversations.md, "Who writes
 * what" and "Review tokens"). An allowlist: a route not named here refuses them, so a
 * route added anywhere else in the daemon can't widen them by accident. The tasks that
 * add their routes (conversations/turn, audit, audit/take, scores, …) extend this table
 * and dispatch the path in http-server.ts's loomApi.
 *
 * Paths are core's own API, POST /api/loom/<path>. Neither role reaches MCP, /cli, the
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

export const ROLE_ROUTES: Readonly<Record<NarrowRole, readonly string[]>> = {
  runtime: ['review/token', 'conversations/turn', DELIVER_ROUTE],
  review: [],
};

/**
 * Of those routes, the ones an agent token reaches too: a harness writes its own session's
 * turns as the agent (docs/specs/conversations.md, "Who writes what"). Owner, peer and piece
 * tokens reach none of them.
 */
export const AGENT_ROUTES: readonly string[] = ['conversations/turn'];

/**
 * GET /api/loom/<path>: what core tells the runtime (the only GET under /api). `venues`: every
 * venue with its kind, piece and `send` argv (household-store.ts, venueDirectory).
 */
export const RUNTIME_GET_ROUTES: readonly string[] = ['venues'];

/** Whether `role` may call POST /api/loom/<path>. */
export function roleReaches(role: NarrowRole, path: string): boolean {
  return ROLE_ROUTES[role].includes(path);
}
