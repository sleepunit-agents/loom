/** Shared-data transport composition. No schema creation or legacy credentials. */
import { getTableColumns } from 'drizzle-orm';
import { bridgeConnections, bridgeIncoming } from './core/data/schema.js';
import { bridgeSecretsTables, bridgeSecretsVisibility } from './core/data/bridge-secrets-visibility.js';
import { BridgeQueries, bridgeQueryFields } from './pieces/bridges/queries.js';
import { bridgeSecretsReaderFields } from './pieces/bridges/readers.js';
import type { IncomingMessage } from 'node:http';
import type { Viewer } from './policy.js';
import type { Clock } from './core/clock.js';
import type { DataDatabase } from './core/data/database.js';
import { dataAuthentication } from './core/data/authentication.js';
import { dataHttp, withQueryFields } from './core/data/http.js';
import type { memoryQueryFields } from './transport/memory-queries.js';
import { DataLive } from './core/data/live.js';
import { dataQueries } from './core/data/queries.js';
import { dataSocket } from './core/data/socket.js';
import { taskVisibility } from './core/data/visibility.js';
import { workVisibility } from './core/data/work-visibility.js';
import { DataWrites } from './core/data/writes.js';

export function nextData(db: DataDatabase, clock: Clock, originAllowed: (request: IncomingMessage) => boolean, publicOrigin?: string, fields: ReturnType<typeof memoryQueryFields>['fields'] = {}) {
  const authenticate = dataAuthentication(db, () => clock.now());
  const live = new DataLive();
  const bridges = new BridgeQueries(db, () => clock.now());
  let activityRead = false;
  const ownFields = { ...bridgeSecretsReaderFields(db), ...bridgeQueryFields(bridges, viewer => {
    const visibility = bridgeSecretsVisibility(viewer);
    return { connections: visibility.bridgeConnections!(getTableColumns(bridgeConnections)), incoming: visibility.bridgeIncoming!(getTableColumns(bridgeIncoming)) };
  }, () => { activityRead = true; schedule(); }) };
  let cancelDeadline: (() => void) | undefined;
  let stopped = false;
  const schedule = () => {
    cancelDeadline?.(); cancelDeadline = undefined;
    if (stopped || !activityRead) return;
    const at = bridges.nextDeadline();
    if (at !== undefined) cancelDeadline = clock.at(at, () => { live.changed(); schedule(); });
  };
  // No query is executed at composition startup. Deadlines belong to actual
  // activity readers; a failed/unavailable selection never starts a scan.
  // One explicit read projection for both outside doors. Credentials, receipt
  // plumbing and unrelated domains stay outside the generated schema.
  const schema = (viewer: Viewer) => withQueryFields(dataQueries(db.$client, {
    tables: ['tasks', 'taskComments', 'taskLinks', 'projects', 'agents',
      'approvals', 'approvalRecord', 'approvalNotices', 'approvalRules',
      'changes', 'changeChecks', 'changePeople', 'changeTasks', 'changeSync', ...bridgeSecretsTables],
    visibility: { ...taskVisibility(viewer), ...workVisibility(viewer), ...bridgeSecretsVisibility(viewer) },
  }), { ...fields, ...ownFields });
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
    schema,
  });
  const writes = new DataWrites(db, { refreshAccess: () => socket.refreshAccess(), changed: () => { live.changed(); schedule(); } });
  let closing: Promise<void> | undefined;
  return {
    http: dataHttp(db, authenticate, publicOrigin, schema),
    attach: socket.attach,
    changed() { socket.refreshAccess(); live.changed(); schedule(); },
    writes,
    close() { return closing ??= (async () => { stopped = true; cancelDeadline?.(); await socket.close(); live.close(); })(); },
  };
}
