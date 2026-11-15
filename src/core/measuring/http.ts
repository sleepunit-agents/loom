import type { IncomingMessage } from 'node:http';
import { httpDoor, type Foundation } from '../app.js';
import { dataAuthentication } from '../data/authentication.js';
import type { DataDatabase } from '../data/database.js';

/** Measuring commands use the same shared credentials as their query/card.
 * No legacy resolver, caller-supplied viewer or fallback identity is accepted.
 * Root selects this adapter only for /api/measuring/* after same-origin checks.
 */
export function measuringHttp(app: Foundation, db: DataDatabase) {
  const authenticate = dataAuthentication(db, () => app.operations.clock.now());
  return httpDoor(app, (request: IncomingMessage) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (Array.isArray(value)) for (const part of value) headers.append(name, part);
      else if (value !== undefined) headers.set(name, value);
    }
    return authenticate(new Request('http://localhost/api/measuring', { headers }));
  });
}
