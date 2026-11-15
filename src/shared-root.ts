import { registerTempoSettingsAnswer } from './shared-tempo-settings-answer.js';
import { settledNotices } from './core/tempo/notices.js';
import { sql } from 'drizzle-orm';
import { secretChanges } from './core/data/schema.js';
import { SharedBridges, type SharedBridgeOptions } from './pieces/bridges/shared-daemon.js';
import { registerSharedBridgeReply } from './shared-bridge-reply.js';
import { SecretDelivery, type SecretDeliveryHolder } from './pieces/secrets/delivery.js';
import { SecretStartup } from './pieces/secrets/shared-startup.js';
import { registerSharedSecretAgentCommands } from './shared-secret-agent-commands.js';
import { BridgeSettings } from './pieces/bridges/settings.js';
import { registerSharedBridgeCommands } from './shared-bridge-commands.js';
import { SecretRequests } from './pieces/secrets/requests.js';
import { SecretValues, type RecoverableSecretMutations } from './pieces/secrets/shared-values.js';
import { registerSharedSecretCommands } from './shared-secret-commands.js';

/** Fresh shared composition. The caller initializes the approved schema and owns
 * the connection; this never bootstraps legacy tables or opens another store. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { tempoSettingsProposals } from './core/tempo/proposal.js';
import { sharedTempoSettings, type TempoChatAuthentication } from './shared-tempo-settings.js';
import type { IncomingMessage } from 'node:http';
import { Hono } from 'hono';
import { z } from 'zod';
import type { DataDatabase } from './core/data/database.js';
import { sharedCredentials } from './shared-credentials.js';
import { OperationResults } from './core/data/operation-results.js';
import type { Clock } from './core/clock.js';
import { Operations, failure, type Change } from './core/operations/index.js';
import { householdService } from './apps/household.js';
import { registerSharedHouseholdMembers } from './shared-household-members.js';
import { taskService } from './apps/tasks.js';
import { approvalService, type ApprovedOperations } from './apps/approvals.js';
import { sharedConversations } from './shared-conversations.js';
import { conversationLifetime } from './core/conversations/lifetime.js';
import type { WordsKey } from './core/conversations/words.js';
import { Conversations } from './core/conversations/index.js';
import { registerSharedPreferences } from './shared-preferences.js';
import { registerSharedTaskCommands } from './shared-task-commands.js';
import { installSharedTempo, type SharedTempoOptions } from './shared-tempo.js';
import { nextData } from './next-data.js';
import { sharedSigninLinkRoutes } from './core/signin/shared-links.js';
import { createRuntime } from './runtime/runtime.js';
import type { ModelRole } from './runtime/placement.js';
import { registerSharedRuntime } from './shared-runtime.js';
import { installMeasuring } from './core/measuring/install.js';
import { measuringSettingsProposals } from './core/measuring/proposal.js';
import { registerSharedAccountReports } from './shared-account-reports.js';

class BodyTooLarge extends Error {}
const envelope = z.object({ input: z.unknown(), id: z.string().min(1).max(200).optional() }).strict();
export function sharedRoot(options: {
  db: DataDatabase;
  clock: Clock;
  originAllowed(request: IncomingMessage): boolean;
  publicOrigin?: string;
  fields?: Parameters<typeof nextData>[4];
  approvedOperations?: ApprovedOperations;
  tempo?: SharedTempoOptions;
  /** Explicit authenticated private holder and stable private retry key. */
  secretWrites?: {holder:RecoverableSecretMutations;fingerprintKey:Uint8Array};
/** Trusted startup loads the household key, never an outside request. */
  commsKey?: WordsKey;
/** Authenticated private holder-to-worker sink; values never enter this root. */
  secretDelivery?: SecretDeliveryHolder;
  changed?(changes: Change[]): void;
  reportError(error: unknown): void;
  bridges?: Omit<SharedBridgeOptions,'db'|'clock'|'writes'|'changed'|'reportError'>;
  modelRoles?(): readonly ModelRole[];
  runtimeJobEnded?(id: string): void;
}) {
  if(options.secretWrites && (!(options.secretWrites.fingerprintKey instanceof Uint8Array) || options.secretWrites.fingerprintKey.byteLength!==32))throw Error('Invalid secret retry key');
  const { db, clock } = options;
  const now = () => new Date(clock.now()).toISOString();
  const chat = new AsyncLocalStorage<TempoChatAuthentication>();
  const settings = tempoSettingsProposals(db, clock);
  let closing: Promise<void> | undefined;
  const notices = settledNotices(db, () => data.changed());
  let meter: Awaited<ReturnType<typeof installMeasuring>> | undefined;
  let measuringReady: ReturnType<typeof installMeasuring>;
  const stops: (() => void)[] = [];
  const report = (error: unknown) => { try { options.reportError(error); } catch { /* committed settings stay committed */ } };
  const measuringProposal = measuringSettingsProposals(db);
  const approvedOperations = new Map([...(options.approvedOperations ?? []), settings.operation]);
  approvedOperations.set(measuringProposal.operation[0], card => {
    measuringProposal.operation[1](card);
    // Synchronous outer writes have committed or rolled back before this runs.
    queueMicrotask(() => { void (meter ? meter.refresh() : measuringReady.then(value => value.refresh())).catch(report); });
  });
  const credentials = sharedCredentials(db, clock, () => !closing);
  const comms = options.commsKey ? sharedConversations(db, clock, options.commsKey) : undefined;
  const data = nextData(db, clock, request => !closing && options.originAllowed(request), options.publicOrigin, { ...comms?.fields, ...notices.fields, ...options.fields }, () => !closing, credentials.authenticate, work => meter?.enabled()
    ? meter.runAsync('request', 'graphql.socket', async () => await work()) : work());
  const operations = new Operations(db.$client, clock, changes => options.changed?.(changes), {
    receipts: new OperationResults(db), writes: data.writes,
    reportError: () => options.reportError(new Error('Shared operation notification failed')),
  });
  registerSharedPreferences(operations, db);
  const accountReports = registerSharedAccountReports(operations, db, now, credentials.runner);
  const roles = () => options.modelRoles?.() ?? [];
  let tempo!: ReturnType<typeof installSharedTempo>;
  const jobEnded = (id: string) => {
    try {
      tempo?.sources.job(id);
      tempo?.capacityChanged();
      options.runtimeJobEnded?.(id);
    } catch (error) { options.reportError(error); }
  };
  const jobClock = (name: 'runtime.tick' | 'tempo.tick' | 'conversations.expire'): Clock => ({
    now: () => clock.now(), at: (time, work) => clock.at(time, () => {
      if (meter?.enabled()) meter.run('job', name, work); else work();
    }),
  });
  const runtime = createRuntime(db, jobClock('runtime.tick'), { roles, changed: () => { tempo?.capacityChanged(); data.changed(); }, jobEnded, error: options.reportError });
  registerSharedRuntime(operations, db, { now, roles, jobEnded, runner: credentials.runner });

  const requests = new SecretRequests(db, now);
  const secretCommit = <T>(write: () => T): T => {
    const result = data.writes.run(write);
    for (const _error of result.notificationErrors) { try { options.reportError(new Error('Secret write notification failed')); } catch { /* reporting cannot undo a commit */ } }
    return result.value;
  };
  const values = options.secretWrites && new SecretValues(db, now, options.secretWrites.holder,
    options.secretWrites.fingerprintKey, secretCommit);
  const delivery = options.secretDelivery && new SecretDelivery(db, now, options.secretDelivery, secretCommit);
  const startup = delivery && new SecretStartup(db, requests, delivery, secretCommit);
  registerSharedSecretAgentCommands(operations, db, requests, delivery, viewer => credentials.body(viewer));
  registerSharedSecretCommands(operations, db, requests, values && {
    values, fingerprintKey:options.secretWrites!.fingerprintKey,
  });
  let secretRecovery:Promise<void>|undefined, cancelSecretRecovery:(()=>void)|undefined;
  const recoverSecrets=()=>{
    if(closing || !values)return Promise.resolve();
    if(secretRecovery)return secretRecovery;
    cancelSecretRecovery?.();
    secretRecovery=(meter?.enabled() ? meter.runAsync('job','secrets.reconcile',()=>values.reconcilePending()) : values.reconcilePending()).catch(()=>{}).finally(()=>{
      secretRecovery=undefined;
      if(!closing)cancelSecretRecovery=clock.at(clock.now()+60_000,recoverSecrets);
    });
    return secretRecovery;
  };
  if(values)cancelSecretRecovery=clock.at(clock.now(),recoverSecrets);
  const bridgeDaemon=options.bridges&&new SharedBridges({...options.bridges,db,clock,writes:data.writes,changed:data.changed,
    inboxCommitted:ids=>{tempo?.capacityChanged();options.bridges?.inboxCommitted?.(ids);},
    reportError:()=>{try{options.reportError(new Error('Bridge processing unavailable'));}catch{}}});
  const lastSecretChange=()=>db.select({id:sql<number>`coalesce(max(rowid),0)`}).from(secretChanges).get()!.id;
  let secretChange=bridgeDaemon?lastSecretChange():0;
  const unobserveBridges=bridgeDaemon&&data.writes.observe(()=>{
    const latest=lastSecretChange(),credentialsChanged=latest!==secretChange;secretChange=latest;
    bridgeDaemon.changed(credentialsChanged);
  });
  if(bridgeDaemon)registerSharedBridgeReply(operations,db,bridgeDaemon.sends,viewer=>credentials.body(viewer),options.bridges!.effectsAllowed);
  comms?.install(operations);
  const services = {
    bridges: {daemon:bridgeDaemon,settings:new BridgeSettings(db,now,write=>{const result=data.writes.run(write);for(const _error of result.notificationErrors){try{options.reportError(new Error('Bridge write notification failed'));}catch{}}return result.value;})},
    tasks: taskService(db, now),
    household: householdService(db, now),
    approvals: approvalService(db, approvedOperations, now),
    conversations: comms?.service.threads.conversations ?? new Conversations(db, now),
    comms: comms?.service,
    runtime,
    secrets: {requests,values,delivery,startup,reconcile:recoverSecrets},
  };
  registerSharedHouseholdMembers(operations, db, services.household);
  registerSharedTaskCommands(operations, db, services.tasks);
  registerSharedBridgeCommands(operations,db,services.bridges.settings);
  const commsLifetime = comms ? conversationLifetime(db, jobClock('conversations.expire'), comms.service, data.writes, options.reportError) : undefined;

  registerTempoSettingsAnswer(operations, db, services.approvals);
  const settingsBinding = sharedTempoSettings(db, clock, () => chat.getStore(), services.approvals);
  try { tempo = installSharedTempo(db, jobClock('tempo.tick'), data.writes, operations, services.conversations, data.changed, {
    ...options.tempo, notify: options.tempo?.notify ?? notices.publish, chatMember: options.tempo?.chatMember ?? settingsBinding.chatMember, settings: options.tempo?.settings ?? settingsBinding.request,
    settingsAuthorized: options.tempo?.settings ? options.tempo.settingsAuthorized : settingsBinding.allowed,
  }); }
  catch (error) { unobserveBridges?.(); void bridgeDaemon?.close(); cancelSecretRecovery?.(); values?.close(); operations.close(); void data.close(); throw error; }
  measuringReady = installMeasuring({ operations, live: { changed: () => data.timingsChanged() },
    onClose(stop) { if (closing) stop(); else stops.push(stop); },
  }, db).then(value => { meter = value; return value; });
  const authenticate = credentials.authenticate;

  const active = new Set<{ abort: AbortController; done: Promise<void> }>();
  const http = new Hono<{ Variables: { shutdown: AbortController } }>();
  const bodyRequest = (request: Request, abort: AbortController, limited = false) => {
    let size = 0;
    return request.body ? new Request(request, {
      body: request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, stream) {
          size += chunk.byteLength;
          if (limited && size > 1024 * 1024) throw new BodyTooLarge();
          stream.enqueue(chunk);
        },
      }), { signal: abort.signal }), signal: abort.signal, duplex: 'half',
    } as RequestInit) : request;
  };
  http.use('*', async (c, next) => {
    c.header('cache-control', 'no-store');
    if (closing) return c.json(failure('unavailable', 'Loom is closing'), 503);
    const abort = new AbortController();
    let finished!: () => void;
    const entry = { abort, done: new Promise<void>(resolve => { finished = resolve; }) };
    active.add(entry); c.set('shutdown', abort);
    try {
      if (!meter) await measuringReady;
      if (closing) return c.json(failure('unavailable', 'Loom is closing'), 503);
      await next();
    } finally { active.delete(entry); finished(); }
  });
  http.route('/', sharedSigninLinkRoutes({ db, clock, writes: data.writes, publicOrigin: options.publicOrigin, admitted: () => !closing, reportError: options.reportError }));
  http.all('/graphql', c => data.http.fetch(bodyRequest(c.req.raw, c.get('shutdown'))));
  http.onError(() => Response.json(failure('unavailable', 'Request could not complete'), { status: 503, headers: { 'cache-control': 'no-store' } }));
  http.post('/api/:piece/:operation', async c => {
    const request = c.req.raw, origin = request.headers.get('origin'), url = new URL(request.url);
    if (request.headers.get('sec-fetch-site') === 'cross-site' || (origin && origin !== url.origin && !(origin === options.publicOrigin && new URL(origin).host === url.host)))
      return c.json(failure('denied', 'Cross-origin request refused'), 403);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) return c.json(failure('invalid', 'Use application/json'), 415);
    const auth = authenticate(request);
    if (!auth?.valid()) return c.json(failure('denied', 'Authentication required'), 401);
    let body: unknown;
    try { body = await bodyRequest(request, c.get('shutdown'), true).json(); } catch (error) { return error instanceof BodyTooLarge ? c.json(failure('invalid', 'Request body too large'), 413) : c.json(failure('invalid', 'Invalid JSON'), 400); }
    const parsed = envelope.safeParse(body);
    if (!parsed.success) return c.json(failure('invalid', 'Expected {input, id?}'), 400);
    if (closing || !auth.valid()) return c.json(failure('denied', 'Authentication ended'), 403);
    const answer = await chat.run(auth, () => operations.callAsync('http', auth.viewer, `${c.req.param('piece')}.${c.req.param('operation')}`,
      parsed.data.input, parsed.data.id, auth.window === true, () => !closing && auth.valid()));

    // Execution and its final await can yield. A committed receipt remains
    // durable, but its response must not outlive the admitted credential.
    if (closing || !auth.valid()) return c.json(failure('denied', 'Authentication ended'), 403);
    return c.json(answer, answer.ok ? 200 : ({ denied: 403, 'not-found': 404, invalid: 400, conflict: 409, unavailable: 503 } as const)[answer.code]);
  });
  runtime.start();
  if(bridgeDaemon)void bridgeDaemon.ready().catch(()=>{try{options.reportError(new Error('Bridge processing unavailable'));}catch{}});
  return {
    measuring: measuringReady,
    ready: measuringReady.then(() => undefined),
    http, operations, services: { ...services, tempo }, credentials, writes: data.writes, changed: data.changed,
    attach(server: Parameters<typeof data.attach>[0]) {
      if (closing) throw new Error('Loom is closing');
      return data.attach(server);
    },
    /** Stop admission synchronously; the caller closes SQLite only after this. */
    close() {
      if (closing) return closing;
      let resolve!: () => void, reject!: (error: unknown) => void;
      closing = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
      accountReports.close();
      commsLifetime?.close();
      runtime.close();
      unobserveBridges?.();const bridgesStopped=bridgeDaemon?.close();
      // Install shared completion before synchronous detach/abort callbacks.
      tempo.close();
      notices.close();
      cancelSecretRecovery?.(); values?.close(); startup?.close();
      const deliveryStopped = delivery?.close();
      const stopped = data.close();
      for (const stop of stops.splice(0).reverse()) stop();
      const measured = measuringReady.then(value => value.close());
      const pending = [...active];
      for (const entry of pending) entry.abort.abort();
      void Promise.allSettled([stopped, bridgesStopped, deliveryStopped, measured, secretRecovery, ...pending.map(entry => entry.done)]).then(results => {
        try { operations.close(); } catch (error) { reject(error); return; }
        const failed = results.find(result => result.status === 'rejected');
        if (failed) reject(failed.reason); else resolve();
      });
      return closing;
    },
  };
}
