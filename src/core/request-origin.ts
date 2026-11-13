import type { IncomingMessage } from 'node:http';

/** Explicit deployment origin; proxy-supplied headers never select authority. */
export function trustedRequestOrigin(req: IncomingMessage, origin?: string): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site === 'same-site' || site === 'cross-site') return false;
  const expected = origin ?? `${'encrypted' in req.socket && req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
  return !req.headers.origin || req.headers.origin === expected;
}
