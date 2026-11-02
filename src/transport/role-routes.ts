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

export const ROLE_ROUTES: Readonly<Record<NarrowRole, readonly string[]>> = {
  runtime: ['review/token', 'conversations/turn', 'audit', 'scorecards', 'review/config'],
  review: ['audit/take', 'audit/done', 'scores', 'findings'],
};

/** Of those, the ones that are GET (everything else is POST): the scorecards and the review's settings. */
export const GET_ROUTES: readonly string[] = ['scorecards', 'review/config'];

/**
 * Of those routes, the ones an agent token reaches too: a harness writes its own session's
 * turns, and their audit entries, as the agent (docs/specs/conversations.md, "Who writes what"). Owner, peer and piece
 * tokens reach none of them.
 */
export const AGENT_ROUTES: readonly string[] = ['conversations/turn', 'audit'];

/** Whether `role` may call /api/loom/<path>. */
export function roleReaches(role: NarrowRole, path: string): boolean {
  return ROLE_ROUTES[role].includes(path);
}
