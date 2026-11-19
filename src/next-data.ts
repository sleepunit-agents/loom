import { assertReadSchema } from './core/data/read-schema.js';
import { conversationTables, conversationVisibility, talkVisibility } from './core/data/conversation-visibility.js';
/** Shared-data transport composition. No schema creation or legacy credentials. */
import { getTableColumns } from 'drizzle-orm';
import { bridgeConnections, bridgeIncoming } from './core/data/schema.js';
import { bridgeSecretsTables, bridgeSecretsVisibility } from './core/data/bridge-secrets-visibility.js';
import { BridgeQueries, bridgeQueryFields } from './pieces/bridges/queries.js';
import { bridgeSecretsReaderFields } from './pieces/bridges/readers.js';
import {GraphQLSchema,GraphQLObjectType,GraphQLBoolean} from 'graphql/index.js';
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
import { tempoVisibility } from './core/tempo/visibility.js';
import { tempoQueryFields } from './core/tempo/queries.js';
import { taskVisibility } from './core/data/visibility.js';
import { boxVisibility } from './core/data/box-visibility.js';
import { workVisibility } from './core/data/work-visibility.js';
import { DataWrites } from './core/data/writes.js';
import { modelAccountQueries } from './runtime/account-query.js';
import { measuringVisibility } from './core/measuring/visibility.js';
import { sqlVisibility } from './policy-sql.js';
import { JobSummaries, jobSummaryFields, nextTerminalDeadline } from './runtime/job-summary.js';

// One explicit public read projection, shared by the outside doors and programme catalogue.
export const sharedQueryTables = ['boxes', 'boxAgents', 'boxFacts', 'agentRunSettings', 'agentBoxes', 'agentHousePorts', 'agentHouseSecrets', 'agentPeople', 'agentDeniedTools', 'tasks', 'taskComments', 'taskLinks', 'projects', 'projectMembers', 'agents', 'agentStatus', 'agentModels',
      'approvals', 'approvalRecord', 'approvalNotices', 'approvalRules',
      'changes', 'changeChecks', 'changePeople', 'changeTasks', 'changeSync', 'memberPreferences', 'members', 'memberAgents', ...bridgeSecretsTables, ...conversationTables,
      'timingDays', 'measuringSettings', 'triggers', 'triggerLog', 'triggerEdits', 'agentPauses'] as const;
/** The longest a last-seen style time waits before open selections are read again for it:
 * docs/accepted-tradeoffs.md, "A last-seen time reaches an open window up to a minute late". */
export const STAMP_WAKE_MS = 60_000;
export function nextData(db: DataDatabase, clock: Clock, originAllowed: (request: IncomingMessage) => boolean, publicOrigin?: string, fields: ReturnType<typeof memoryQueryFields>['fields'] = {}, admitted: () => boolean = () => true, authentication?: NonNullable<Parameters<typeof dataHttp>[1]>, measure?: MeasureRead, programRecords?: (viewer:Viewer)=>readonly string[]|undefined, canReadUsage: (viewer:Viewer)=>boolean = () => true, canReadProgram: (viewer:Viewer)=>boolean = canReadUsage) {
  const accounts = modelAccountQueries(db, () => new Date(clock.now()).toISOString());
  const resolve = authentication ?? dataAuthentication(db, () => clock.now());
  const authenticate = (request: Request) => {
    if (!admitted()) return;
    const auth = resolve(request);
    return auth && { ...auth, valid: () => admitted() && auth.valid() && accounts.valid(auth.viewer) };
  };
  const live = new DataLive(measure);
  const bridges = new BridgeQueries(db, () => clock.now());
  let activityRead = false, currentJobsRead = false;
  const ownFields = { ...bridgeSecretsReaderFields(db), ...bridgeQueryFields(bridges, viewer => {
    const visibility = bridgeSecretsVisibility(viewer);
    return { connections: visibility.bridgeConnections!(getTableColumns(bridgeConnections)), incoming: visibility.bridgeIncoming!(getTableColumns(bridgeIncoming)) };
  }, () => { activityRead = true; schedule(); }) };
  let cancelDeadline: (() => void) | undefined;
  let stopped = false;
  const schedule = () => {
    cancelDeadline?.(); cancelDeadline = undefined;
    if (stopped) return;
    const deadlines = [activityRead ? bridges.nextDeadline() : undefined, currentJobsRead ? nextTerminalDeadline(db, clock.now()) : undefined];
    const at = deadlines.filter((time): time is number => time !== undefined).sort((a,b) => a-b)[0];
    if (at !== undefined) cancelDeadline = clock.at(at, () => { live.changed(); schedule(); });
  };
  // Start deadline scans only after an actual activity selection succeeds.

  const emptyProgram=new GraphQLSchema({query:new GraphQLObjectType({name:'ProgramQuery',fields:{_empty:{type:GraphQLBoolean,resolve:()=>false}}})});
  const schema = (viewer: Viewer, full = false) => {
    const records=full?undefined:programRecords?.(viewer),selected=records===undefined?sharedQueryTables:sharedQueryTables.filter(name=>records.includes(name));
    return withQueryFields(selected.length?dataQueries(db.$client, {tables:selected,
    // Every rule is stated in policy.ts.
    visibility: { ...boxVisibility(viewer), ...taskVisibility(viewer), ...workVisibility(viewer), ...bridgeSecretsVisibility(viewer), ...conversationVisibility(viewer),
      ...measuringVisibility(viewer), ...tempoVisibility(viewer),
      ...sqlVisibility(viewer, ['agentStatus', 'agentModels', 'agentRunSettings', 'agentBoxes', 'agentHousePorts', 'agentHouseSecrets', 'agentPeople', 'agentDeniedTools', 'members', 'memberAgents', 'memberPreferences']),
    },
  }):emptyProgram, records!==undefined?{}:{ ...fields, ...ownFields, ...tempoQueryFields(db, viewer, () => canReadProgram(viewer)), ...accounts.fields,
    // A job's title, brief and log tail are words of its conversation; it is read by the jobs rule in policy.ts.
    ...jobSummaryFields(new JobSummaries(db, () => talkVisibility(viewer), () => clock.now(), () => { if (!currentJobsRead) { currentJobsRead = true; schedule(); } }), () => canReadUsage(viewer)),
  });};
  // Refuse unsupported extensions before admitting any HTTP/socket work.
  assertReadSchema(schema({ kind: 'member', id: '' }, true));
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
  // Times loom stamps as it is used (a machine's last report, a credential's last use, how long a call took)
  // are written many times a second and decide nothing about who reads what. Open selections are read again
  // for them at most once in STAMP_WAKE_MS, and not at all while none is written.
  let cancelStamps: (() => void) | undefined;
  const stamped = () => {
    if (stopped || cancelStamps) return;
    cancelStamps = clock.at(clock.now() + STAMP_WAKE_MS, () => { cancelStamps = undefined; if (!stopped) live.metadataChanged(); });
  };
  const writes = new DataWrites(db, { refreshAccess: () => socket.refreshAccess(), changed: () => { live.changed(); schedule(); }, stamped });
  const http = dataHttp(db, authenticate, publicOrigin, schema, {}, () => live.epoch(), () => clock.now());
  let closing: Promise<void> | undefined;
  return {
    http,
    readVersion: () => live.epoch(),
    attach: socket.attach,
    changed() { socket.refreshAccess(); live.changed(); schedule(); },
    timingsChanged: stamped,
    credentialUsageChanged: stamped,
    writes,
    close() {
      if (closing) return closing;
      // Publish before stopping admission; callbacks cannot create a second close.
      closing = Promise.resolve().then(async () => {
        try { await socketClosing; } finally { await http.drain(); }
      });
      stopped = true; cancelDeadline?.(); cancelStamps?.();
      http.stop();
      const socketClosing = socket.close();
      live.close();
      return closing;
    },
  };
}
