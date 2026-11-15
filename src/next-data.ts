import { conversationTables, conversationVisibility } from './core/data/conversation-visibility.js';
/** Shared-data transport composition. No schema creation or legacy credentials. */
import { getTableColumns, sql } from 'drizzle-orm';
import { bridgeConnections, bridgeIncoming } from './core/data/schema.js';
import { bridgeSecretsTables, bridgeSecretsVisibility } from './core/data/bridge-secrets-visibility.js';
import { BridgeQueries, bridgeQueryFields } from './pieces/bridges/queries.js';
import { bridgeSecretsReaderFields } from './pieces/bridges/readers.js';
import { members } from './core/data/schema.js';
import type { IncomingMessage } from 'node:http';
import type { Viewer } from './policy.js';
import type { Clock } from './core/clock.js';
import type { DataDatabase } from './core/data/database.js';
import { dataAuthentication } from './core/data/authentication.js';
import { dataHttp, withQueryFields } from './core/data/http.js';
import type { memoryQueryFields } from './transport/memory-queries.js';
import { DataLive, type MeasureRead } from './core/data/live.js';
import { dataQueries } from './core/data/queries.js';
import { dataSocket } from './core/data/socket.js';
import { taskVisibility } from './core/data/visibility.js';
import { boxVisibility } from './core/data/box-visibility.js';
import { workVisibility } from './core/data/work-visibility.js';
import { tempoVisibility } from './core/tempo/visibility.js';
import { DataWrites } from './core/data/writes.js';
import { modelAccountQueries } from './runtime/account-query.js';
import { measuringVisibility } from './core/measuring/visibility.js';
import { JobSummaries, jobSummaryFields } from './runtime/job-summary.js';

export function nextData(db: DataDatabase, clock: Clock, originAllowed: (request: IncomingMessage) => boolean, publicOrigin?: string, fields: ReturnType<typeof memoryQueryFields>['fields'] = {}, admitted: () => boolean = () => true, authentication?: NonNullable<Parameters<typeof dataHttp>[1]>, measure?: MeasureRead) {
  const accounts = modelAccountQueries(db, () => new Date(clock.now()).toISOString());
  const resolve = authentication ?? dataAuthentication(db, () => clock.now());
  const authenticate = (request: Request) => {
    if (!admitted()) return;
    const auth = resolve(request);
    return auth && { ...auth, valid: () => admitted() && auth.valid() && accounts.valid(auth.viewer) };
  };
  const live = new DataLive(measure);
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
  // Start deadline scans only after an actual activity selection succeeds.

  // One explicit read projection for both outside doors. Credentials, receipt
  // plumbing and unrelated domains stay outside the generated schema.
  const schema = (viewer: Viewer) => withQueryFields(dataQueries(db.$client, {
    tables: ['boxes', 'tasks', 'taskComments', 'taskLinks', 'projects', 'agents', 'agentStatus', 'triggers', 'triggerLog', 'agentPauses',
      'approvals', 'approvalRecord', 'approvalNotices', 'approvalRules',
      'changes', 'changeChecks', 'changePeople', 'changeTasks', 'changeSync', 'memberPreferences', 'members', 'memberAgents', ...bridgeSecretsTables, ...conversationTables,
      'timingDays', 'measuringSettings'],
    visibility: { ...boxVisibility(viewer), ...taskVisibility(viewer), ...workVisibility(viewer), ...bridgeSecretsVisibility(viewer), ...conversationVisibility(viewer), ...tempoVisibility(viewer),
      ...measuringVisibility(viewer),
      // Status has the same scope as its agent; keep the existing current SQL policy.
      agentStatus: fields => taskVisibility(viewer).agents!({ id: fields.agent }),
      members: fields => viewer.kind === 'member' ? sql`(exists(select 1 from ${members} where ${members.id} = ${viewer.id} and ${members.role} = 'owner') or ${fields.id} = ${viewer.id})` : sql`false`,
      memberAgents: () => viewer.kind === 'member' ? sql`exists(select 1 from ${members} where ${members.id} = ${viewer.id} and ${members.role} = 'owner')` : sql`false`,
      memberPreferences: fields => viewer.kind === 'member' ? sql`(${fields.member} = ${viewer.id} and exists (select 1 from ${members} where ${members.id} = ${viewer.id}))` : sql`false`,
    },
  }), { ...fields, ...ownFields, ...accounts.fields,
    // Jobs carry the same agent/project/private-member labels as Approvals.
    // Reuse its canonical SQL rather than maintain another sharing policy.
    ...jobSummaryFields(new JobSummaries(db, () => ({ jobs: workVisibility(viewer).approvals }))),
  });
  const socket = dataSocket({ live, clock, originAllowed, measure,

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
  const http = dataHttp(db, authenticate, publicOrigin, schema, {}, () => live.epoch(), () => clock.now());
  let closing: Promise<void> | undefined;
  return {
    http,
    readVersion: () => live.epoch(),
    attach: socket.attach,
    changed() { socket.refreshAccess(); live.changed(); schedule(); },
    timingsChanged() { live.timingsChanged(); },
    writes,
    close() {
      if (closing) return closing;
      // Publish before stopping admission; callbacks cannot create a second close.
      closing = Promise.resolve().then(async () => {
        try { await socketClosing; } finally { await http.drain(); }
      });
      stopped = true; cancelDeadline?.();
      http.stop();
      const socketClosing = socket.close();
      live.close();
      return closing;
    },
  };
}
