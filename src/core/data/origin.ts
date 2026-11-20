/** The one rule for which browser origins a door takes. Every door that a cookie can reach asks it: the
 * data door, the operation and body doors, the MCP door, the sign-in routes and the live socket.
 *
 * A request passes when the browser does not call it cross-site and it either names no Origin (not a
 * browser's cross-origin request) or names the origin this program is served at. That origin is the
 * configured public one when the request came to its host, which is how a TLS-terminating proxy in front
 * is supported without trusting forwarded headers; otherwise it is the address the request itself came to.
 */
import type { IncomingMessage } from 'node:http';

function originAllowed(seen: { fetchSite: string | null | undefined; origin: string | null | undefined; own: string; host: string | undefined }, publicOrigin?: string): boolean {
  if (seen.fetchSite === 'cross-site') return false;
  if (!seen.origin) return true;
  return seen.origin === (publicOrigin !== undefined && new URL(publicOrigin).host === seen.host ? publicOrigin : seen.own);
}
/** For a door that is handed a Fetch request. */
export function sameRequestOrigin(request: Request, publicOrigin?: string): boolean {
  const url = new URL(request.url);
  return originAllowed({ fetchSite: request.headers.get('sec-fetch-site'), origin: request.headers.get('origin'), own: url.origin, host: url.host }, publicOrigin);
}
/** For the socket upgrade, which is handed Node's own request. */
export function sameIncomingOrigin(request: IncomingMessage, publicOrigin?: string): boolean {
  const host = request.headers.host, fetchSite = request.headers['sec-fetch-site'];
  return originAllowed({ fetchSite: Array.isArray(fetchSite) ? fetchSite[0] : fetchSite, origin: request.headers.origin,
    own: `${'encrypted' in request.socket && request.socket.encrypted ? 'https' : 'http'}://${host}`, host }, publicOrigin);
}
