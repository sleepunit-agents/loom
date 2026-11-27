import {contextTicketFields} from './core/data/context-tickets.js';
import { boardQueryFields } from './core/boards/query.js';
import {workspaceDirectoryFields} from './core/data/workspace-directory.js';
import {epicWorkFields} from './core/data/epic-work.js';
import { workJobFields } from './core/data/work-jobs.js';
import { assertReadSchema } from './core/data/read-schema.js';
import { conversationTables, conversationVisibility, talkVisibility } from './core/data/conversation-visibility.js';
/** Shared-data transport composition. No schema creation or legacy credentials. */
import { getTableColumns } from 'drizzle-orm';
import { bridgeConnections, bridgeIncoming } from './core/data/schema.js';
import { bridgeSecretsTables, bridgeSecretsVisibility } from './core/data/bridge-secrets-visibility.js';
import { changeReviewFields } from './pieces/changes/review-query.js';
import { backlogWindowFields } from './core/data/backlog-window.js';
import { workBoardFields } from './core/data/work-board.js';
import { BridgeQueries, bridgeQueryFields } from './pieces/bridges/queries.js';
import { bridgeSecretsReaderFields } from './pieces/bridges/readers.js';
import {GraphQLSchema,GraphQLObjectType,GraphQLBoolean} from 'graphql/index.js';
import type { IncomingMessage } from 'node:http';
import type { Viewer } from './policy.js';
import type { Clock } from './core/clock.js';
import type { DataDatabase } from './core/data/database.js';
import { dataAuthentication } from './core/data/authentication.js';
import { dataHttp } from './core/data/http.js';
import type { memoryQueryFields } from './transport/memory-queries.js';
import { DataLive, type MeasureRead } from './core/data/live.js';
import { LIVE_RELAXED_MS } from './core/data/live-pace.js';
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
import { machineJobSummaryField } from './runtime/machine-job-summaries.js';
import { JobSummaries, jobSummaryFields, nextTerminalDeadline } from './runtime/job-summary.js';

// One explicit public read projection, shared by the outside doors and programme catalogue.
export const sharedQueryTables = ['boxes', 'boxAgents', 'boxFacts', 'boxReadings', 'boxAlertSettings', 'agentRunSettings', 'agentBoxes', 'agentHousePorts', 'agentHouseSecrets', 'agentPeople', 'agentDeniedTools', 'tasks', 'taskComments', 'taskLinks', 'projects', 'projectMembers', 'agents', 'agentStatus', 'agentModels',
      'approvals', 'approvalRecord', 'approvalNotices', 'approvalRules',
      'changes', 'changeChecks', 'changePeople', 'changeTasks', 'changeSync', 'memberPreferences', 'members', 'memberAgents', ...bridgeSecretsTables, ...conversationTables,
      'timingDays', 'measuringSettings', 'triggers', 'triggerLog', 'triggerEdits', 'agentPauses'] as const;
/** The longest a last-seen style time waits before open selections are read again for it:
 * docs/accepted-tradeoffs.md, "A last-seen time reaches an open window up to a minute late". */
export const STAMP_WAKE_MS = 60_000;
/** How soon after one reading of an open selection began the next may begin (core/data/live.ts, `settleMs`). A
 * commit that comes alone is read at once. Commits that come faster than this, as when a session reports its steps
 * or several agents write at once, are read together, so what an open window shows can be this much behind the
 * last of them and no more: docs/specs/boards.md, "Live reads and their cost". A selection its client opened
 * `relaxed` waits `LIVE_RELAXED_MS` instead (core/data/live-pace.ts), and this time when the client asks for it now. */
export const LIVE_SETTLE_MS = 100;
export function nextData(db: DataDatabase, clock: Clock, originAllowed: (request: IncomingMessage) => boolean, publicOrigin?: string, fields: ReturnType<typeof memoryQueryFields>['fields'] = {}, admitted: () => boolean = () => true, authentication?: NonNullable<Parameters<typeof dataHttp>[1]>, measure?: MeasureRead, programRecords?: (viewer:Viewer)=>readonly string[]|undefined, canReadUsage: (viewer:Viewer)=>boolean = () => true, canReadProgram: (viewer:Viewer)=>boolean = canReadUsage) {
  const summaries = (viewer:Viewer) => new JobSummaries(db, () => ({ ...talkVisibility(viewer), ...conversationVisibility(viewer), ...boxVisibility(viewer), ...taskVisibility(viewer), ...tempoVisibility(viewer) }), () => clock.now(), () => { if (!currentJobsRead) { currentJobsRead = true; schedule(); } });
  let cancelLoginWake:(()=>void)|undefined, loginWakeAt = Infinity;
  const accounts = modelAccountQueries(db, () => new Date(clock.now()).toISOString(),viewer=>canReadUsage(viewer) ? summaries(viewer) : undefined, summaries, at=>{
    if (stopped || at >= loginWakeAt) return;
    cancelLoginWake?.();
    loginWakeAt = at;
    cancelLoginWake = clock.at(at,()=>{
      loginWakeAt = Infinity;
      cancelLoginWake = undefined;
      live.changed();
    });
  });
  const resolve = authentication ?? dataAuthentication(db, () => clock.now());
  const authenticate = (request: Request) => {
    if (!admitted()) return;
    const auth = resolve(request);
    return auth && { ...auth, valid: () => admitted() && auth.valid() && accounts.valid(auth.viewer) };
  };
  const live = new DataLive(measure, LIVE_SETTLE_MS, LIVE_RELAXED_MS);
  const bridges = new BridgeQueries(db, () => clock.now());
  let activityRead = false, currentJobsRead = false;
  const ownFields = { ...boardQueryFields(db), ...contextTicketFields(db), ...epicWorkFields(db), ...workspaceDirectoryFields(db), ...workJobFields(db, () => clock.now(), () => { if (!currentJobsRead) { currentJobsRead = true; schedule(); } }), ...backlogWindowFields(db), ...workBoardFields(db), ...changeReviewFields(db), ...bridgeSecretsReaderFields(db), ...bridgeQueryFields(bridges, viewer => {
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
  // A socket reuses its authenticated viewer object. Share only the schema shape;
  // row visibility and capability checks still execute on every read.
  const memberSchemas = new WeakMap<Viewer, GraphQLSchema>();
  const schema = (viewer: Viewer, full = false) => {
    const records=full?undefined:programRecords?.(viewer),selected=records===undefined?sharedQueryTables:sharedQueryTables.filter(name=>records.includes(name));
    const reusable = viewer.kind === 'member' && records === undefined && !full;
    const previous = reusable && memberSchemas.get(viewer);
    if (previous) return previous;
    const result = selected.length ? dataQueries(db.$client, {
      tables:selected,readyForAgent:viewer.kind==='agent' ? viewer.id : undefined,
      // Every rule is stated in policy.ts.
      visibility: { ...boxVisibility(viewer), ...taskVisibility(viewer), ...workVisibility(viewer), ...bridgeSecretsVisibility(viewer), ...conversationVisibility(viewer),
        ...measuringVisibility(viewer), ...tempoVisibility(viewer),
        ...sqlVisibility(viewer, ['agentStatus', 'agentModels', 'agentRunSettings', 'agentBoxes', 'agentHousePorts', 'agentHouseSecrets', 'agentPeople', 'agentDeniedTools', 'members', 'memberAgents', 'memberPreferences']),
      },
      fields: records !== undefined ? undefined : {
        ...fields, ...ownFields, ...tempoQueryFields(db, viewer, () => canReadProgram(viewer), () => canReadUsage(viewer)), ...accounts.fields,
        // A job's title, brief and log tail are words of its conversation.
        ...jobSummaryFields(summaries(viewer), () => canReadUsage(viewer)),
        privateMachineJobs: machineJobSummaryField(db, viewer),
      },
    }) : emptyProgram;
    if (reusable) memberSchemas.set(viewer, result);
    return result;
  };
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
  let cancelStamps: (() => void) | undefined, stampsDue = 0;
  const stamped = () => {
    if (stopped) return;
    // A wake waits for the wall clock to reach its time. After the clock is set back, the one already waiting
    // is further off than any wake should be: the next stamp sets it again, a whole interval from now.
    if (cancelStamps && stampsDue - clock.now() <= STAMP_WAKE_MS) return;
    cancelStamps?.(); stampsDue = clock.now() + STAMP_WAKE_MS;
    cancelStamps = clock.at(stampsDue, () => { cancelStamps = undefined; if (!stopped) live.metadataChanged(); });
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
      stopped = true; cancelDeadline?.(); cancelStamps?.(); cancelLoginWake?.();
      http.stop();
      const socketClosing = socket.close();
      live.close();
      return closing;
    },
  };
}
