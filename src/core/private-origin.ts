/** The one rule for an address that a credential is sent to by a worker, a body or `loom mcp`:
 * an origin and nothing else, over https, or over plain http to this machine only. */
export function privateOrigin(value: string): URL {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#\\\s@]+\/?$/.test(value)) throw new Error('Invalid private origin');
  const origin = new URL(value);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/'
    || origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new Error('Invalid private origin');
  return origin;
}

/** A failed connect cannot have delivered the request. For multi-address connects,
 * every attempted address must have refused it. */
export function connectionRefused(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every(connectionRefused);
  if ('code' in error) return error.code === 'ECONNREFUSED';
  return error instanceof Error && connectionRefused(error.cause);
}
