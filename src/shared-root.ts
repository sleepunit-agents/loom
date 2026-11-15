import type {ProgramGrantReader} from './shared-program-access.js';
import { sharedProjects, sharedProjectQueries, registerSharedProjects } from './shared-projects.js';
import { sharedHouseholdAccess, householdAccessQueries, registerSharedHouseholdAccess } from './shared-household-access.js';
import { sharedNotifications, type SharedNotificationOptions } from './core/signin/shared-notifications.js';
import { sharedAccount, sharedAccountFields, registerSharedAccount } from './core/signin/shared-account.js';
import { sharedTokens, registerSharedTokenAdmin } from './core/signin/shared-tokens.js';
import { registerSharedCommandCatalog } from './shared-command-catalog.js';
import { registerAgentBodyPolicy } from './shared-agent-body-policy.js';

import { registerAgentRunSettings } from './shared-agent-run-settings.js';

import { registerBoxSettings } from './shared-box-settings.js';
import {registerMachineRegistry} from './shared-machine-registry.js';
import { registerAgentModels } from './shared-agent-models.js';

import { registerModelAccountAdmin } from './shared-model-account-admin.js';
import { modelCatalog } from './runtime/model-catalog.js';
import {registerSharedBodyEnrollment} from './shared-body-enrollment.js';
import { SecretPrivateInputs } from './pieces/secrets/private-inputs.js';
import type { SecretValueSource } from './pieces/secrets/role.js';
import { sharedSecretInputRoutes } from './shared-secret-inputs.js';
import { recordActionResult } from './shared-action-results.js';
import {conversationQuestionPolicy} from './shared-conversation-questions.js';
import { settledNotices } from './core/tempo/notices.js';
import { sql } from 'drizzle-orm';
import { secretChanges } from './core/data/schema.js';
import { SharedBridges, type SharedBridgeOptions } from './pieces/bridges/shared-daemon.js';
import { registerSharedBridgeReply } from './shared-bridge-reply.js';
import { registerSharedSecretAgentCommands } from './shared-secret-agent-commands.js';
import { BridgeSettings } from './pieces/bridges/settings.js';
import { registerSharedBridgeCommands } from './shared-bridge-commands.js';
import { SecretRequests } from './pieces/secrets/requests.js';
import { SecretValues, type RecoverableSecretMutations } from './pieces/secrets/shared-values.js';
import { registerSharedSecretCommands } from './shared-secret-commands.js';

/** Fresh shared composition. The caller initializes the approved schema and owns
 * the connection; this never bootstraps legacy tables or opens another store. */
import { tempoSettingsProposals } from './core/tempo/proposal.js';
import { sharedTempoSettings } from './shared-tempo-settings.js';
import type { IncomingMessage } from 'node:http';
import { Hono } from 'hono';
import { z } from 'zod';
import type { DataDatabase } from './core/data/database.js';
import { sharedCredentials } from './shared-credentials.js';
import { OperationResults } from './core/data/operation-results.js';
import type { Clock } from './core/clock.js';
import {sharedMemory,type SharedMemoryOptions} from './shared-memory.js';
import {installMemoryTempo} from './transport/memory-tempo.js';
import {installMemorySignals} from './transport/memory-signals.js';
import { Operations, failure, type Change } from './core/operations/index.js';
import { householdService } from './apps/household.js';
import { registerSharedHouseholdMembers } from './shared-household-members.js';
import { changeService, type PullRequestReader, type MergeRuleReader } from './apps/changes.js';
import { sharedChangesReader } from './shared-changes-reader.js';
import { pollChanges } from './apps/changes-polling.js';
import { registerWorkRefresh } from './shared-work-refresh.js';
import { workQueryFields } from './shared-work-queries.js';
import { workLifetime } from './shared-work-lifetime.js';
import { registerSharedWorkBody } from './shared-work-body.js';
import { registerSharedWorkAlways } from './shared-work-always.js';
import { registerSharedWorkCommands, type WorkAnswerAuthority } from './shared-work-commands.js';
import { taskService } from './apps/tasks.js';
import { approvalRulesService } from './apps/approval-rules.js';
import { registerSharedApprovalRules } from './shared-approval-rules.js';
import { approvalService, type ApprovedOperations } from './apps/approvals.js';
import { sharedConversations } from './shared-conversations.js';
import { sameRequestOrigin } from './core/data/origin.js';
import { takeBodyInput } from './core/conversations/body-input.js';
import { conversationBodyScope } from './core/conversations/body-scope.js';
import { mayRunPrivateWork } from './policy.js';
import { sharedSharing } from './shared-sharing.js';
import { registerConversationBodyOperations } from './core/conversations/body-operations.js';
import { conversationLifetime } from './core/conversations/lifetime.js';
import type { WordsKey } from './core/conversations/words.js';
import { Conversations } from './core/conversations/index.js';
import { registerSharedPreferences } from './shared-preferences.js';
import { registerSharedTaskCommands } from './shared-task-commands.js';
import { installSharedTempo, type SharedTempoOptions } from './shared-tempo.js';
import { nextData } from './next-data.js';
import { deskTimeFields, startDeskTime } from './desk-time.js';
import { deskSpriteFields } from './desk-sprites.js';
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
  /** Canonical persistent program marker/grants, supplied by the schema owner. */
  programGrants?: ProgramGrantReader;
  memory?: SharedMemoryOptions;
  fields?: Parameters<typeof nextData>[4];
  approvedOperations?: ApprovedOperations;
  changes?: {rule?:MergeRuleReader} & ({read:PullRequestReader} | {github:Parameters<typeof sharedChangesReader>[0]});
  workAnswerAuthority?: WorkAnswerAuthority;
  tempo?: SharedTempoOptions;
  /** Explicit authenticated private holder and stable private retry key. */
  secretWrites?: {holder:RecoverableSecretMutations;fingerprintKey:Uint8Array};
  /** Trusted startup loads the household key, never an outside request. */
  commsKey?: WordsKey;
  /** Explicit authenticated holder source for the private recipient channel. */
  secretInputs?: {source:SecretValueSource};
  notifications?: SharedNotificationOptions;
  changed?(changes: Change[]): void;
  reportError(error: unknown): void;
  bridges?: Omit<SharedBridgeOptions,'db'|'clock'|'writes'|'changed'|'reportError'>;
  modelRoles?(): readonly ModelRole[];
  runtimeJobEnded?(id: string): void;
}) {
  if(options.secretWrites && (!(options.secretWrites.fingerprintKey instanceof Uint8Array) || options.secretWrites.fingerprintKey.byteLength!==32))throw Error('Invalid secret retry key');
  const roles = () => modelCatalog(options.modelRoles?.() ?? []);
  roles(); // Refuse invalid startup configuration before opening services.
  const { db, clock } = options;
  const now = () => new Date(clock.now()).toISOString();
  householdService(db,now).synchronizeFullOwners();
  const settings = tempoSettingsProposals(db, clock);
  let closing: Promise<void> | undefined;
  let meter: Awaited<ReturnType<typeof installMeasuring>> | undefined;
  let measuringReady: ReturnType<typeof installMeasuring> | undefined;
  const stops: (() => void)[] = [];
  const report = (error: unknown) => { try { options.reportError(error); } catch { /* committed settings stay committed */ } };
  const measuringProposal = measuringSettingsProposals(db);
  const approvedOperations = new Map([...(options.approvedOperations ?? []), settings.operation]);
  approvedOperations.set(measuringProposal.operation[0], card => {
    measuringProposal.operation[1](card);
    // Synchronous outer writes have committed or rolled back before this runs.
    queueMicrotask(() => { void (meter ? meter.refresh() : measuringReady!.then(value => value.refresh())).catch(report); });
  });
  let credentialWrite: ((action:()=>boolean)=>void) | undefined;
  const credentials = sharedCredentials(db, clock, () => !closing && !!credentialWrite, action => credentialWrite!(action),options.programGrants);
  const householdAccess=sharedHouseholdAccess(db,now,options.changes?.rule);
  const projectQueries=sharedProjectQueries(db);
  const householdQueries=householdAccessQueries(db,householdAccess);
  const authenticateOutside=(request:Request,options?:Parameters<typeof credentials.authenticate>[1])=>{const auth=credentials.authenticate(request,options);return auth&&{...auth,valid:()=>auth.valid()&&householdQueries.valid(auth.viewer)&&projectQueries.valid(auth.viewer)};};
  const bodyScope=conversationBodyScope(db,credentials.body,scope=>mayRunPrivateWork(scope,sharedSharing(db)));
  const comms = options.commsKey ? sharedConversations(db, clock, options.commsKey) : undefined;
  const tasks=taskService(db,now);
  const memory=sharedMemory(db,clock,options.memory,tasks);
  const startupCleanups:Array<()=>void>=[memory.close];
  try{
  const notices = settledNotices(db, () => data.changed(),conversationQuestionPolicy(db).visibility);
  startupCleanups.push(notices.close);
  let pushes:ReturnType<typeof sharedNotifications>|undefined;
  let memorySignals:ReturnType<typeof installMemorySignals>|undefined;
  const data = nextData(db, clock, request => !closing && options.originAllowed(request), options.publicOrigin, {...memory.fields, ...householdQueries.fields, ...projectQueries.fields, ...sharedAccountFields(db, clock, member=>pushes?.read(member)??{publicKey:null,devices:[]}), ...deskTimeFields(db, clock), ...deskSpriteFields(db), ...comms?.fields, ...notices.fields, ...options.fields, ...workQueryFields(db,!!options.changes)}, () => !closing, authenticateOutside, work => meter?.enabled()
    ? meter.runAsync('request', 'graphql.socket', async () => await work()) : work(),viewer=>credentials.program(viewer)?.records);
  credentialWrite=action=>{if(db.$client.inTransaction)throw Error('Credential usage must own its transaction');if(db.transaction(action))data.credentialUsageChanged();};
  startupCleanups.push(()=>{void data.close().catch(()=>report(new Error('Data startup cleanup failed')));});
  const operations = new Operations(db.$client, clock, changes => {memorySignals?.changed();options.changed?.(changes);}, {
    receipts: new OperationResults(db), writes: data.writes, currentOutside: credentials.allows, receiptScope:credentials.receiptScope,
    reportError: () => options.reportError(new Error('Shared operation notification failed')),
  });
  startupCleanups.push(()=>operations.close());
  pushes=sharedNotifications({db,clock,writes:data.writes,config:options.notifications,browser:credentials.browser,visible:conversationQuestionPolicy(db).visibility,reportError:options.reportError});pushes.install(operations);startupCleanups.push(()=>{void pushes?.close();});
  memory.register(operations);memorySignals=installMemorySignals(clock,memory,()=>data.changed());startupCleanups.push(memorySignals.close);
  const stopMemoryWrites=data.writes.observe(()=>memorySignals!.rearm());startupCleanups.push(stopMemoryWrites);
  registerSharedPreferences(operations, db);
  registerSharedCommandCatalog(operations,viewer=>!!bodyScope(viewer));
  registerAgentBodyPolicy(operations, db);
  const accountReports = registerSharedAccountReports(operations, db, now, credentials.runner);
  startupCleanups.push(()=>accountReports.close());
  registerModelAccountAdmin(operations, db, roles);
  let tempo!: ReturnType<typeof installSharedTempo>;
  registerAgentRunSettings(operations, db, () => tempo?.capacityChanged());

  registerBoxSettings(operations, db, () => tempo?.capacityChanged());
  registerMachineRegistry(operations,db,{now,changed:()=>tempo?.capacityChanged()});
  registerAgentModels(operations, db, roles, () => tempo?.capacityChanged());
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
  startupCleanups.push(()=>runtime.close());
  registerSharedRuntime(operations, db, { now, roles, jobEnded, runner: credentials.runner });
  registerSharedBodyEnrollment(operations, db, {now,runnerEnrollment:credentials.runnerEnrollment});

  const requests = new SecretRequests(db, now);
  const secretCommit = <T>(write: () => T): T => {
    const result = data.writes.run(write);
    for (const _error of result.notificationErrors) { try { options.reportError(new Error('Secret write notification failed')); } catch { /* reporting cannot undo a commit */ } }
    return result.value;
  };
  const values = options.secretWrites && new SecretValues(db, now, options.secretWrites.holder,
    options.secretWrites.fingerprintKey, secretCommit);
  const privateInputs=new SecretPrivateInputs(db,clock,options.secretInputs?.source,secretCommit);
  startupCleanups.push(()=>{void Promise.resolve(privateInputs.close()).catch(report);});
  registerSharedSecretAgentCommands(operations, db, requests, viewer => credentials.body(viewer));
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
  startupCleanups.push(()=>{cancelSecretRecovery?.();values?.close();});
  const bridgeDaemon=options.bridges&&new SharedBridges({...options.bridges,db,clock,writes:data.writes,changed:data.changed,
    inboxCommitted:ids=>{tempo?.capacityChanged();options.bridges?.inboxCommitted?.(ids);},
    reportError:()=>{try{options.reportError(new Error('Bridge processing unavailable'));}catch{}}});
  const lastSecretChange=()=>db.select({id:sql<number>`coalesce(max(rowid),0)`}).from(secretChanges).get()!.id;
  let secretChange=bridgeDaemon?lastSecretChange():0;
  const unobserveBridges=bridgeDaemon&&data.writes.observe(()=>{
    const latest=lastSecretChange(),credentialsChanged=latest!==secretChange;secretChange=latest;
    bridgeDaemon.changed(credentialsChanged);
  });
  startupCleanups.push(()=>{unobserveBridges?.();void bridgeDaemon?.close().catch(()=>report(new Error('Bridge startup cleanup failed')));});
  comms?.install(operations);
  if(comms)registerConversationBodyOperations(operations,comms.service,credentials.body,scope=>mayRunPrivateWork(scope,sharedSharing(db)),comms.authorizeQuestion);
  const services = {
    bridges: {daemon:bridgeDaemon,settings:new BridgeSettings(db,now,write=>{const result=data.writes.run(write);for(const _error of result.notificationErrors){try{options.reportError(new Error('Bridge write notification failed'));}catch{}}return result.value;})},
    tasks,
    changes: changeService(db,options.changes?.rule ?? (()=>undefined),now,run=>{
      const result=data.writes.run(run);
      for(const _error of result.notificationErrors){try{options.reportError(new Error('Changes source notification failed'));}catch{}}
      return result.value;
    }),
    household: householdService(db, now),
    projects: sharedProjects(db),
    signin: sharedTokens(db, clock),
    account: sharedAccount(db, clock),
    householdAccess,
    notifications: pushes,
    approvalRules: approvalRulesService(db,now),
    approvals: approvalService(db, approvedOperations, now),
    conversations: comms?.service.threads.conversations ?? new Conversations(db, now),
    comms: comms?.service,
    runtime,
    secrets: {requests,values,inputs:privateInputs,reconcile:recoverSecrets},
  };
  if(bridgeDaemon)registerSharedBridgeReply(operations,db,bridgeDaemon.sends,services.conversations,bodyScope,options.bridges!.effectsAllowed);
  registerSharedTokenAdmin(operations, db, services.signin);
  registerSharedAccount(operations, db, services.account);
  registerSharedProjects(operations, db, services.projects);
  registerSharedHouseholdAccess(operations, db, services.householdAccess);
  registerSharedHouseholdMembers(operations, db, services.household);
  registerSharedTaskCommands(operations, db, services.tasks);
  registerSharedBridgeCommands(operations,db,services.bridges.settings);
  const commsLifetime = comms ? conversationLifetime(db, jobClock('conversations.expire'), comms.service, data.writes, options.reportError) : undefined;

  startupCleanups.push(()=>commsLifetime?.close());
  const settingsBinding = sharedTempoSettings(db, clock, bodyScope, services.approvals);
  try { tempo = installSharedTempo(db, jobClock('tempo.tick'), data.writes, operations, services.conversations, data.changed, {
    ...options.tempo, notify: (member,ids)=>{const result=options.tempo?.notify?options.tempo.notify(member,ids):notices.publish(member,ids);pushes?.publish(member,ids);return result;}, chatMember: options.tempo?.chatMember ?? settingsBinding.chatMember, settings: options.tempo?.settings ?? settingsBinding.request,
    mailboxReceiptScope: options.tempo?.mailboxReceiptScope ?? settingsBinding.receiptScope,
    settingsAuthorized: options.tempo?.settings ? options.tempo.settingsAuthorized : settingsBinding.allowed,
    beforeStart(tempo){const stopOther=options.tempo?.beforeStart?.(tempo);try{const stopMemory=memory.checkingAgent?installMemoryTempo(db,tempo,memory,memory.checkingAgent):undefined;return()=>{try{stopMemory?.();}finally{stopOther?.();}};}catch(error){stopOther?.();throw error;}},
  }); }
  catch (error) { unobserveBridges?.(); void bridgeDaemon?.close(); cancelSecretRecovery?.(); values?.close(); void privateInputs.close(); operations.close(); void data.close(); throw error; }
  startupCleanups.push(()=>tempo.close());
  const stopDeskTime = startDeskTime(clock, data.changed, options.reportError);
  startupCleanups.push(stopDeskTime);
  measuringReady = installMeasuring({ operations, live: { changed: () => data.timingsChanged() },
    onClose(stop) { if (closing) stop(); else stops.push(stop); },
  }, db).then(value => { meter = value; return value; });
  const changePolling=options.changes ? pollChanges(services.changes,'read' in options.changes ? options.changes.read : sharedChangesReader(options.changes.github),clock) : undefined;
  startupCleanups.push(()=>{void changePolling?.stop();});
  const workLife=workLifetime(db,clock,data.writes,options.reportError);
  startupCleanups.push(()=>workLife.close());
  const authenticate = authenticateOutside;

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
      if(credentials.isProgramRequest(c.req.raw)){
        const auth=authenticate(c.req.raw,{recordUse:false});
        if(!auth||!credentials.program(auth.viewer))return c.json(failure('denied','Permission denied'),403);
        const path=new URL(c.req.url).pathname;
        const command=/^\/api\/([^/]+)\/([^/]+)$/.exec(path);
        // No credential ceremonies, private channels or alternate transport can
        // turn a restricted program into an unrestricted member/browser.
        if(path!=='/graphql'&&(!command||!credentials.allows(auth.viewer,`${command[1]}.${command[2]}`)))return c.json(failure('denied','Permission denied'),403);
      }
      await next();
    } finally { active.delete(entry); finished(); }
  });
  http.route('/', sharedSigninLinkRoutes({ db, clock, writes: data.writes, publicOrigin: options.publicOrigin, admitted: () => !closing, reportError: options.reportError, authenticate:request=>authenticate(request,{programs:'deny'}) }));
  http.all('/graphql', c => data.http.fetch(bodyRequest(c.req.raw, c.get('shutdown'))));
  http.onError(() => Response.json(failure('unavailable', 'Request could not complete'), { status: 503, headers: { 'cache-control': 'no-store' } }));
  http.post('/api/conversation/take', async c => comms ? takeBodyInput({request:bodyRequest(c.req.raw,c.get('shutdown'),true),service:comms.service,scope:bodyScope,authenticate,admitted:()=>!closing,version:data.readVersion,writes:data.writes,now:()=>clock.now(),publicOrigin:options.publicOrigin,reportError:options.reportError}) : c.json(failure('unavailable','Conversation input unavailable'),503));
  http.route('/api/secrets/private',sharedSecretInputRoutes({db,inputs:privateInputs,credentials,available:()=>!closing,readJson:(request,abort)=>bodyRequest(request,abort,true).json()}));
  http.post('/api/:piece/:operation', async c => {
    const request = c.req.raw;
    if (!sameRequestOrigin(request,options.publicOrigin))
      return c.json(failure('denied', 'Cross-origin request refused'), 403);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) return c.json(failure('invalid', 'Use application/json'), 415);
    const auth = authenticate(request);
    if (!auth?.valid()) return c.json(failure('denied', 'Authentication required'), 401);
    let body: unknown;
    try { body = await bodyRequest(request, c.get('shutdown'), true).json(); } catch (error) { return error instanceof BodyTooLarge ? c.json(failure('invalid', 'Request body too large'), 413) : c.json(failure('invalid', 'Invalid JSON'), 400); }
    const parsed = envelope.safeParse(body);
    if (!parsed.success) return c.json(failure('invalid', 'Expected {input, id?}'), 400);
    if (closing || !auth.valid()) return c.json(failure('denied', 'Authentication ended'), 403);
    const answer = await operations.callAsync('http', auth.viewer, `${c.req.param('piece')}.${c.req.param('operation')}`,
      parsed.data.input, parsed.data.id, auth.window === true, () => !closing && auth.valid());

    // Execution and its final await can yield. A committed receipt remains
    // durable, but its response must not outlive the admitted credential.
    // The admitted member receives server-owned outcome metadata even when
    // preparation was refused after credential expiry. Never write after stop.
    if (!closing) recordActionResult({db,writes:data.writes,operations,viewer:auth.viewer,window:auth.window===true,name:`${c.req.param('piece')}.${c.req.param('operation')}`,input:parsed.data.input,id:parsed.data.id,result:answer,now:()=>clock.now(),reportError:options.reportError});
    if (closing || !auth.valid()) return c.json(failure('denied', 'Authentication ended'), 403);
    return c.json(answer, answer.ok ? 200 : ({ denied: 403, 'not-found': 404, invalid: 400, conflict: 409, unavailable: 503 } as const)[answer.code]);
  });
  if(options.commsKey)registerSharedWorkBody(operations,db,services.approvals,services.approvalRules,bodyScope,words=>options.commsKey!.hash(words),options.workAnswerAuthority);
  registerSharedWorkCommands(operations,db,services.approvals,options.workAnswerAuthority);
  registerSharedApprovalRules(operations,db,services.approvalRules);
  registerSharedWorkAlways(operations,db,services.approvals,services.approvalRules,options.workAnswerAuthority);
  if (changePolling) registerWorkRefresh(operations,db,changePolling.refresh);
  runtime.start();
  if(bridgeDaemon)void bridgeDaemon.ready().catch(()=>{try{options.reportError(new Error('Bridge processing unavailable'));}catch{}});
  return {
    measuring: measuringReady,
    ready: measuringReady!.then(() => undefined),
    http, operations, services: { ...services, tempo }, memory, credentials, refreshChanges:changePolling?.refresh, writes: data.writes, changed: ()=>memorySignals!.changed(),
    attach(server: Parameters<typeof data.attach>[0]) {
      if (closing) throw new Error('Loom is closing');
      return data.attach(server);
    },
    /** Stop admission synchronously; the caller closes SQLite only after this. */
    close() {
      if (closing) return closing;
      let resolve!: () => void, reject!: (error: unknown) => void;
      closing = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
      stopMemoryWrites();memorySignals?.close();
      accountReports.close();
      commsLifetime?.close();workLife.close();
      runtime.close();
      unobserveBridges?.();const bridgesStopped=bridgeDaemon?.close();
      // Install shared completion before synchronous detach/abort callbacks.
      stopDeskTime();
      const sourceStopped=changePolling?.stop();
      tempo.close();
      notices.close();
      cancelSecretRecovery?.(); values?.close();
      const inputsStopped = privateInputs.close();
      const stopped = data.close();
      const pushesStopped=pushes?.close();
      for (const stop of stops.splice(0).reverse()) stop();
      const measured = measuringReady!.then(value => value.close());
      const pending = [...active];
      for (const entry of pending) entry.abort.abort();
      void Promise.allSettled([stopped, pushesStopped, sourceStopped, bridgesStopped, inputsStopped, measured, secretRecovery, ...pending.map(entry => entry.done)]).then(results => {
        try { try{operations.close();}finally{memory.close();} } catch (error) { reject(error); return; }
        const failed = results.find(result => result.status === 'rejected');
        if (failed) reject(failed.reason); else resolve();
      });
      return closing;
    },
  };
  }catch(error){closing=Promise.resolve();for(const stop of stops.splice(0).reverse())try{stop();}catch{};void measuringReady?.then(value=>value.close()).catch(report);for(const stop of startupCleanups.reverse())try{stop();}catch{report(new Error('Shared startup cleanup failed'));}throw error;}
}
