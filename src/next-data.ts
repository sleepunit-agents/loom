/** Shared-data transport composition. No schema creation or legacy credentials. */
import type { IncomingMessage } from 'node:http';
import type { Clock } from './core/clock.js';
import type { DataDatabase } from './core/data/database.js';
import { dataAuthentication } from './core/data/authentication.js';
import { dataHttp } from './core/data/http.js';
import { DataLive } from './core/data/live.js';
import { dataQueries } from './core/data/queries.js';
import { dataSocket } from './core/data/socket.js';
import { taskVisibility } from './core/data/visibility.js';
import { DataWrites } from './core/data/writes.js';

export function nextData(db: DataDatabase, clock: Clock, originAllowed: (request: IncomingMessage) => boolean, publicOrigin?: string) {
  const authenticate = dataAuthentication(db, () => clock.now());
  const live = new DataLive();
  const socket = dataSocket({ live, clock, originAllowed,
    authenticate(request) {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value)) for (const part of value) headers.append(name, part);
        else if (value !== undefined) headers.set(name, value);
      }
      // Only headers carry credentials; Host and forwarded headers cannot pick
      // the authentication authority or provide an alternate credential store.
      return authenticate(new Request('http://localhost/graphql', { headers }));
    },
    schema: viewer => dataQueries(db.$client, {
      tables: ['tasks', 'taskComments', 'taskLinks', 'projects', 'agents'],
      visibility: taskVisibility(viewer),
    }),
  });
  const writes = new DataWrites(db, { refreshAccess: () => socket.refreshAccess(), changed: () => live.changed() });
  let closing: Promise<void> | undefined;
  return {
    http: dataHttp(db, authenticate, publicOrigin),
    attach: socket.attach,
    writes,
    close() { return closing ??= (async () => { await socket.close(); live.close(); })(); },
  };
}
