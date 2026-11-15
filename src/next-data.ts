/** Shared-data transport composition. No schema creation or legacy credentials. */
import { sql } from 'drizzle-orm';
import { members } from './core/data/schema.js';
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

export function nextData(db: DataDatabase, clock: Clock, originAllowed: (request: IncomingMessage) => boolean, publicOrigin?: string, fields: ReturnType<typeof memoryQueryFields>['fields'] = {}, admitted: () => boolean = () => true, authentication?: NonNullable<Parameters<typeof dataHttp>[1]>) {
  const resolve = authentication ?? dataAuthentication(db, () => clock.now());
  const authenticate = (request: Request) => {
    if (!admitted()) return;
    const auth = resolve(request);
    return auth && { ...auth, valid: () => admitted() && auth.valid() };
  };
  const live = new DataLive();
  // One explicit read projection for both outside doors. Credentials, receipt
  // plumbing and unrelated domains stay outside the generated schema.
  const schema = (viewer: Viewer) => withQueryFields(dataQueries(db.$client, {
    tables: ['tasks', 'taskComments', 'taskLinks', 'projects', 'agents', 'agentStatus',
      'approvals', 'approvalRecord', 'approvalNotices', 'approvalRules',
      'changes', 'changeChecks', 'changePeople', 'changeTasks', 'changeSync', 'memberPreferences'],
    visibility: { ...taskVisibility(viewer), ...workVisibility(viewer),
      // Status has the same scope as its agent; keep the existing current SQL policy.
      agentStatus: fields => taskVisibility(viewer).agents!({ id: fields.agent }),
      memberPreferences: fields => viewer.kind === 'member' ? sql`(${fields.member} = ${viewer.id} and exists (select 1 from ${members} where ${members.id} = ${viewer.id}))` : sql`false`,
    },
  }), fields);
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
  const writes = new DataWrites(db, { refreshAccess: () => socket.refreshAccess(), changed: () => live.changed() });
  const http = dataHttp(db, authenticate, publicOrigin, schema);
  let closing: Promise<void> | undefined;
  return {
    http,
    attach: socket.attach,
    changed() { socket.refreshAccess(); live.changed(); },
    writes,
    close() {
      if (closing) return closing;
      // Publish before stopping admission; callbacks cannot create a second close.
      closing = Promise.resolve().then(async () => {
        try { await socketClosing; } finally { await http.drain(); }
      });
      http.stop();
      const socketClosing = socket.close();
      live.close();
      return closing;
    },
  };
}
