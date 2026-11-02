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

export const ROLE_ROUTES: Readonly<Record<NarrowRole, readonly string[]>> = {
  runtime: ['review/token'],
  review: [],
};

/** Whether `role` may call POST /api/loom/<path>. */
export function roleReaches(role: NarrowRole, path: string): boolean {
  return ROLE_ROUTES[role].includes(path);
}
