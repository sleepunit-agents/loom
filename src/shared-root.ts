import { recentReviewEnds, reportReviewEnd } from './core/conversations/review-result.js';
import { kitCatalogQueries } from './shared-kit-catalog.js';
import type {EmbeddingProvider} from './backends/types.js';
import {sharedMcpRequest} from './shared-mcp.js';
import {programGrantStore} from './core/data/program-grants.js';
import {sharedProgramSetup,programIssueInput} from './shared-program-setup.js';
import {programSetupQueries,registerProgramSetup} from './shared-program-queries.js';
import type {ProgramGrantStore,ProgramGrantReader} from './shared-program-access.js';
import { sharedProjects, sharedProjectQueries } from './shared-projects.js';
import { sharedHouseholdAccess, householdAccessQueries, registerSharedHouseholdAccess } from './shared-household-access.js';
import { sharedNotifications, type SharedNotificationOptions } from './core/signin/shared-notifications.js';
import { sharedAccount, sharedAccountFields, registerSharedAccount } from './core/signin/shared-account.js';
import { sharedTokens, registerSharedTokenAdmin } from './core/signin/shared-tokens.js';
import { registerSharedCommandCatalog } from './shared-command-catalog.js';
import { saveAgentBodyPolicy } from './shared-agent-body-policy.js';

import { applyAgentRunSettings } from './shared-agent-run-settings.js';

import { applyBoxSettings } from './shared-box-settings.js';
import {registerMachineRegistry} from './shared-machine-registry.js';
import { applyAgentModels } from './shared-agent-models.js';

import { registerModelAccountAdmin, subscriptionSetupField } from './shared-model-account-admin.js';
import { registerMachineReads } from './shared-machine-reads.js';
import { registerSharedAccountSignIn } from './shared-account-signin.js';
import { modelCatalog } from './runtime/model-catalog.js';
import {registerSharedBodyEnrollment} from './shared-body-enrollment.js';
import { SecretPrivateInputs } from './pieces/secrets/private-inputs.js';
import type { SecretValueSource } from './pieces/secrets/role.js';
import { sharedSecretInputRoutes } from './shared-secret-inputs.js';
import { recordActionResult } from './shared-action-results.js';
import {conversationQuestionPolicy} from './shared-conversation-questions.js';
import { settledNotices } from './core/tempo/notices.js';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { boxes, jobs as jobRows, secretChanges } from './core/data/schema.js';
import { setHouseSecrets } from './shared-secret-commands.js';
import { SharedBridges, type SharedBridgeOptions } from './pieces/bridges/shared-daemon.js';
import { registerSharedBridgeReply } from './shared-bridge-reply.js';
import { kitBroker } from './shared-kit-broker.js';
import { registerKitReads } from './shared-kit-reads.js';
import { registerSharedSecretAgentCommands } from './shared-secret-agent-commands.js';
import { BridgeSettings } from './pieces/bridges/settings.js';
import { registerSharedBridgeCommands } from './shared-bridge-commands.js';
import { SecretRequests } from './pieces/secrets/requests.js';
import { SecretValues, type RecoverableSecretMutations } from './pieces/secrets/shared-values.js';
import { registerSharedSecretCommands } from './shared-secret-commands.js';

/** Fresh shared composition. The caller initializes the approved schema and owns
 * the connection; this never bootstraps legacy tables or opens another store. */
import { sharedTempoSettings } from './shared-tempo-settings.js';
import type { IncomingMessage } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { DataDatabase } from './core/data/database.js';
import { sharedCredentials } from './shared-credentials.js';
import { OperationResults } from './core/data/operation-results.js';
import type { Clock } from './core/clock.js';
import {sharedMemory,type SharedMemoryOptions} from './shared-memory.js';
import {installMemoryTempo} from './transport/memory-tempo.js';
import {installMemorySignals} from './transport/memory-signals.js';
import { OperationError, Operations, failure, type Change } from './core/operations/index.js';
import { householdService } from './apps/household.js';
import { sharedHouseholdProposals } from './shared-household-proposals.js';
import { outsideNames } from './shared-outside-names.js';
import { registerSharedJobControl } from './shared-job-control.js';
import { Jobs } from './runtime/jobs.js';
import { ConversationSessions } from './core/conversations/sessions.js';
import { expireTerminalSessions } from './core/conversations/terminal-sessions.js';
import { registerTerminalSession } from './shared-terminal-session.js';
import { registerJobUsage } from './shared-job-usage.js';
import { registerConversationSessions } from './shared-conversation-sessions.js';
import { changeService, type PullRequestReader, type MergeRuleReader } from './apps/changes.js';
import { sharedChangesReader } from './shared-changes-reader.js';
import { pollChanges } from './apps/changes-polling.js';
import { registerWorkRefresh } from './shared-work-refresh.js';
import { workQueryFields } from './shared-work-queries.js';
import { workLifetime } from './shared-work-lifetime.js';
import { registerSharedWorkBody } from './shared-work-body.js';
import { registerSharedNotices } from './shared-notices.js';
import { registerSharedWorkAlways } from './shared-work-always.js';
import { registerSharedWorkCommands } from './shared-work-commands.js';
import { taskService } from './apps/tasks.js';
import { approvalRulesService } from './apps/approval-rules.js';
import { approvalService, type ApprovedOperations } from './apps/approvals.js';
import { sharedConversations } from './shared-conversations.js';
import { sameRequestOrigin } from './core/data/origin.js';
import { DOOR_REQUEST_BYTES } from './core/data/http.js';
import { takeBodyInput } from './core/conversations/body-input.js';
import { conversationBodyScope } from './core/conversations/body-scope.js';
import { addressee, holds, mayRunPrivateWork, rules as policyRules, type Viewer } from './policy.js';
import { canReadSharedConversation, currentMember, sharedSharing } from './shared-sharing.js';
import { registerConversationBodyOperations } from './core/conversations/body-operations.js';
import { HELD_REFUSALS, askedOnWord, heldRefusal, jobHeld, jobWord, outsideAccount, kitRoom, selfHandoff, writtenOnWord } from './shared-place-mail.js';
import { conversationLifetime } from './core/conversations/lifetime.js';
import type { WordsKey } from './core/conversations/words.js';
import { Conversations, lateMailWaits } from './core/conversations/index.js';
import { registerSharedPreferences } from './shared-preferences.js';
import { registerSharedTaskCommands } from './shared-task-commands.js';
import { installSharedTempo, mayReadProgramWork, type SharedTempoOptions } from './shared-tempo.js';
import { nextData,sharedQueryTables } from './next-data.js';
import { deskTimeFields, startDeskTime } from './desk-time.js';
import { deskSpriteFields } from './desk-sprites.js';
import { sharedSigninLinkRoutes } from './core/signin/shared-links.js';
import { createRuntime } from './runtime/runtime.js';
import type { ModelRole } from './runtime/placement.js';
import { applyProgramResult } from './shared-program-result.js';
import { registerSharedRuntime } from './shared-runtime.js';
import { installMeasuring } from './core/measuring/install.js';
import { measuringSettingsService } from './core/measuring/settings.js';
import { registerSharedAccountReports } from './shared-account-reports.js';
import { registerSharedMachineReadings } from './shared-machine-readings.js';

class BodyTooLarge extends Error {}
const envelope = z.object({ input: z.unknown(), id: z.string().min(1).max(200).optional() }).strict();
export function sharedRoot(options: {
  /** Production starts the silence clock when its HTTP listener opens. */
  deferRuntimeStart?: boolean;
  db: DataDatabase;
  clock: Clock;
  originAllowed(request: IncomingMessage): boolean;
  publicOrigin?: string;
  /** Optional read-only enforcement adapter, without writable programme setup.
   * Normal roots use canonical SQLite persistence when no adapter is supplied. */
  programGrants?: ProgramGrantReader;
  /** Writable setup and outside enforcement share this exact reader; it
   * takes precedence over the read-only programGrants adapter. */
  programStore?: ProgramGrantStore;
  memory?: SharedMemoryOptions;
  /** Trusted startup may supply an embedding implementation; never request-selected. */
  memoryEmbedding?:()=>EmbeddingProvider;
  fields?: Parameters<typeof nextData>[4];
  approvedOperations?: ApprovedOperations;
  changes?: {rule?:MergeRuleReader} & ({read:PullRequestReader} | {github:Parameters<typeof sharedChangesReader>[0]});
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
  /** One plain line for whoever runs the program, about stored rows it changed at start outside the
   * upgrade steps. It names what was done and how many rows, never their content. */
  startupNote?(line: string): void;
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
  let closing: Promise<void> | undefined;
  let meter: Awaited<ReturnType<typeof installMeasuring>> | undefined;
  let measuringReady: ReturnType<typeof installMeasuring> | undefined;
  const stops: (() => void)[] = [];
  const report = (error: unknown) => { try { options.reportError(error); } catch { /* committed settings stay committed */ } };
  const householdSettings = householdService(db, now), projectSettings = sharedProjects(db, now), ruleSettings = approvalRulesService(db, now), tokenSettings = sharedTokens(db, clock);
  // Parts built further down, once the program is assembled; a proposal only reaches them when one is filed or allowed.
  const late: { revokeMachine?: (id: string) => void; requests?: SecretRequests; bridges?: () => BridgeSettings; tempo?: () => ReturnType<typeof installSharedTempo>['volume']; schedule?: ReturnType<typeof installSharedTempo>['placeSchedule'] } = {};
  // The household's own key when it has one. Without one (a program run with no Comms) the key lasts as long
  // as the program, so a card left waiting over a restart is refused as changed and has to be asked for again.
  const proposalKey = options.commsKey ? undefined : randomBytes(32);
  const proposalDigest = (words: string) => proposalKey ? createHmac('sha256', proposalKey).update(words).digest('hex') : options.commsKey!.hash('household-proposal\0' + words);
  const householdProposals = sharedHouseholdProposals(db, householdSettings, projectSettings, ruleSettings, fingerprint => tokenSettings.revoke(fingerprint), now,
    { roles, setAccounts: input => householdAccess.setAccounts(input) },
    { secrets: { setRule: input => late.requests!.setRule(input) },
      // Revoking a machine is written once, in setup.revokeMachine below.
      machines: { revoke: id => late.revokeMachine!(id) },
      bridges: { read: value => late.bridges!().read(value), change: value => late.bridges!().change(value) },
      tempo: () => late.tempo!(),
      schedule: ask => late.schedule!(ask),
      measuring: { ...measuringSettingsService(db), changed: () => queueMicrotask(() => { void (meter ? meter.refresh() : measuringReady!.then(value => value.refresh())).catch(report); }) },
      // Proposal names come from owner-readable bridge records.
      names: viewer => outsideNames(db, (platform, workspace, user) => memory.people.outsideName(viewer, platform, workspace, user)),
      digest: proposalDigest, note: line => { try { options.startupNote?.(line); } catch { /* the rows are already changed */ } } });
  const approvedOperations = new Map([...(options.approvedOperations ?? []), householdProposals.operation]);
  const programStore=options.programStore??(options.programGrants?undefined:programGrantStore(db));
  let credentialWrite: ((action:()=>boolean)=>void) | undefined;
  const credentials = sharedCredentials(db, clock, () => !closing && !!credentialWrite, action => credentialWrite!(action),programStore?(id=>programStore.read(id)):options.programGrants);
  let programOperations:()=>readonly string[]=()=>[];
  const programSetup=programStore?sharedProgramSetup(db,clock,programStore,()=>({records:sharedQueryTables,operations:programOperations()})):undefined;
  const programQueries=programSetupQueries(db,programSetup);
  const householdAccess=sharedHouseholdAccess(db,now,options.changes?.rule);
  const bodyJob=(viewer:Viewer)=>{const body=credentials.body(viewer),job=body&&db.select({id:jobRows.id,agent:jobRows.agent,conversation:jobRows.conversation}).from(jobRows).where(eq(jobRows.id,body.job)).get();return job?{job}:undefined;};
  const kitQueries=kitCatalogQueries(db,viewer=>{const work=bodyJob(viewer);return !!work && kitRoom(db,work.job).word.woke==='others';});
  const projectQueries=sharedProjectQueries(db);
  const householdQueries=householdAccessQueries(db,householdAccess);
  // Every outside door authenticates here. A body's viewer already says which member its work is for:
  // currentToken writes it where it reads the job (core/data/authentication.ts).
  const authenticateOutside=(request:Request,options?:Parameters<typeof credentials.authenticate>[1])=>{const auth=credentials.authenticate(request,options);return auth&&{...auth,valid:()=>auth.valid()&&householdQueries.valid(auth.viewer)&&projectQueries.valid(auth.viewer)&&programQueries.valid(auth.viewer)&&kitQueries.valid(auth.viewer)};};
  const bodyScope=conversationBodyScope(db,credentials.body,scope=>mayRunPrivateWork(scope,sharedSharing(db)));
  const comms = options.commsKey ? sharedConversations(db, clock, options.commsKey, (viewer,account)=>{
    let identity:unknown;
    try { identity=JSON.parse(account); } catch { return undefined; }
    const parsed=outsideAccount.safeParse(identity);
    if(!parsed.success)return undefined;
    const name=(...address:typeof parsed.data)=>memory.people.outsideName(viewer,...address);
    if(!holds(policyRules.householdOwner,viewer,{},sharedSharing(db)))return name(...parsed.data);
    return outsideNames(db,name).person(...parsed.data)?.name;
  }) : undefined;
  // Mail about a task goes into its conversation only for a person who reads that conversation (policy.ts, addressee).
  const tasks=taskService(db,now,(person,conversation)=>canReadSharedConversation(db,addressee(person),conversation));
  const memory=sharedMemory(db,clock,options.memory,tasks,options.memoryEmbedding,report);
  const startupCleanups:Array<()=>void>=[memory.close];
  try{
  const notices = settledNotices(db, () => data.changed(),conversationQuestionPolicy(db).visibility);
  startupCleanups.push(notices.close);
  let pushes:ReturnType<typeof sharedNotifications>|undefined;
  let memorySignals:ReturnType<typeof installMemorySignals>|undefined;
  const data = nextData(db, clock, request => !closing && options.originAllowed(request), options.publicOrigin, {subscriptionSetup:subscriptionSetupField(db,roles), ...memory.fields, ...kitQueries.fields, ...programQueries.fields, ...householdQueries.fields, ...projectQueries.fields, ...sharedAccountFields(db, clock, member=>pushes?.read(member)??{publicKey:null,devices:[]}), ...deskTimeFields(db, clock), ...deskSpriteFields(db), ...comms?.fields, ...notices.fields, ...options.fields, ...workQueryFields(db,!!options.changes)}, () => !closing, authenticateOutside, work => meter?.enabled()
    ? meter.runAsync('request', 'graphql.socket', async () => await work()) : work(),viewer=>credentials.program(viewer)?.records,viewer=>{const work=bodyJob(viewer);return !work || !jobHeld(db,work.job);}, viewer => mayReadProgramWork(db, viewer, bodyJob(viewer)?.job));
  credentialWrite=action=>{if(db.$client.inTransaction)throw Error('Credential usage must own its transaction');if(db.transaction(action))data.credentialUsageChanged();};
  startupCleanups.push(()=>{void data.close().catch(()=>report(new Error('Data startup cleanup failed')));});
  const operations = new Operations(db.$client, clock, changes => {memorySignals?.changed();options.changed?.(changes);}, {
    receipts: new OperationResults(db), writes: data.writes, currentOutside: credentials.allows, receiptScope:credentials.receiptScope,
    reportError: () => options.reportError(new Error('Shared operation notification failed')),
  });
  startupCleanups.push(()=>operations.close());
  programOperations=()=>operations.offered('http').map(operation=>operation.name);
  if(programSetup)registerProgramSetup(operations,db,programSetup);
  pushes=sharedNotifications({db,clock,writes:data.writes,config:options.notifications,browser:credentials.browser,visible:conversationQuestionPolicy(db).visibility,reportError:options.reportError});pushes.install(operations);startupCleanups.push(()=>{void pushes?.close();});
  // Whose memory a command works on is the caller's own agent's, on proof of its credential. A body working
  // for a member is that agent only while the member has the agent (rules.agentItself), the same answer
  // the memory reads give it.
  // What the body of a job on anybody else's word is refused, asked of the job its credential is bound to and never of
  // what the body says: on such a word a body changes nothing outside its own conversation, except by asking the owners
  // a question (shared-place-mail.ts, heldRefusal).
  const held=(action:Parameters<typeof heldRefusal>[2])=>(viewer:Viewer)=>heldRefusal(db,bodyJob(viewer),action);
  registerSharedNotices(operations,db,clock,viewer=>credentials.body(viewer)??credentials.agentSession(viewer),()=>pushes,held('notice'));
  const memoryAgent=(viewer:Viewer)=>{const own=credentials.body(viewer)??credentials.agentSession(viewer);return own&&holds(policyRules.agentItself,viewer,{agent:own.agent},sharedSharing(db))?own:undefined;};
  memory.register(operations,options.commsKey?{body:memoryAgent,hash:words=>options.commsKey!.hash(words),committed:()=>{try{if(memorySignals)memorySignals.changed();else data.changed();}catch{report(new Error('Memory source notification failed'));}}}:undefined,
    // Of what the agent and the household keep, such a body only adds: a memory, or a new note, each stamped by loom with
    // whose word it was written on. Everything else in those families is refused it.
    {knowledge:held('knowledge'),
     memory:viewer=>{const on=writtenOnWord(db,bodyJob(viewer));return on&&{refusal:HELD_REFUSALS.memory,stamp:{who:on.who,conversation:on.conversation},line:on.line};},
     note:viewer=>{const on=writtenOnWord(db,bodyJob(viewer));return on&&{overwrite:HELD_REFUSALS.note,by:on.by};}});memorySignals=installMemorySignals(clock,memory,()=>data.changed());startupCleanups.push(memorySignals.close);
  const stopMemoryWrites=data.writes.observe(()=>memorySignals!.rearm());startupCleanups.push(stopMemoryWrites);
  registerSharedPreferences(operations, db);
  // The list of commands is no secret: any current member or agent may read it. Each command still checks its own caller.
  registerSharedCommandCatalog(operations,viewer=>!!bodyScope(viewer)||!!credentials.agentSession(viewer)||currentMember(db,viewer));
  const accountReports = registerSharedAccountReports(operations, db, now, credentials.runner);
  startupCleanups.push(()=>accountReports.close());
  registerSharedMachineReadings(operations, db, now, credentials.runner);
  const stopMachineReads=registerMachineReads(operations,db,now,bodyScope,credentials.runner);
  const accountSignIns = registerSharedAccountSignIn(operations, db, now, credentials.runner, credentials.body);
  registerModelAccountAdmin(operations, db, roles, now, accountSignIns.ask);
  let tempo!: ReturnType<typeof installSharedTempo>;

  registerMachineRegistry(operations,db,{now,changed:()=>tempo?.capacityChanged()});
  const reviewReports = new Set<Promise<void>>();
  const reviewRetries = new Map<string,()=>void>();
  const deliverReview = (id:string) => {
    if(!comms)return;
    const delivery=reportReviewEnd(comms.service,id,
      (member,agent,project)=>mayRunPrivateWork({member,agent,project:project??undefined},sharedSharing(db)),
      write=>data.writes.run(write)).catch(error=>{
        if(!closing && !reviewRetries.has(id)){
          reviewRetries.set(id,clock.at(clock.now()+30_000,()=>{
            reviewRetries.delete(id);
            deliverReview(id);
          }));
        }
        options.reportError(error);
      });
    reviewReports.add(delivery);
    void delivery.finally(()=>reviewReports.delete(delivery));
  };
  const jobEnded = (id: string) => {
    try {
      tempo?.sources.job(id);
      tempo?.capacityChanged();
      deliverReview(id);
      options.runtimeJobEnded?.(id);
    } catch (error) { options.reportError(error); }
  };
  const jobClock = (name: 'runtime.tick' | 'tempo.tick' | 'conversations.expire'): Clock => ({
    now: () => clock.now(), at: (time, work) => clock.at(time, () => {
      if (meter?.enabled()) meter.run('job', name, work); else work();
    }),
  });
  const runtime = createRuntime(db, jobClock('runtime.tick'), { expire: () => { accountSignIns.expire(); expireTerminalSessions(db, now()); }, changed: () => { tempo?.capacityChanged(); data.changed(); }, jobEnded, error: options.reportError });
  startupCleanups.push(()=>runtime.close());
  registerSharedJobControl(operations, db, { now, jobEnded: id => { jobEnded(id); tempo?.capacityChanged(); } });
  registerSharedBodyEnrollment(operations, db, {now,runnerEnrollment:credentials.runnerEnrollment});

  const requests = new SecretRequests(db, now);
  late.requests = requests; late.bridges = () => services.bridges.settings; late.tempo = () => tempo.volume; late.schedule = ask => tempo.placeSchedule(ask);
  const secretCommit = <T>(write: () => T, stampOnly?:()=>boolean): T => {
    const result = data.writes.run(write,stampOnly);
    for (const _error of result.notificationErrors) { try { options.reportError(new Error('Secret write notification failed')); } catch { /* reporting cannot undo a commit */ } }
    return result.value;
  };
  const values = options.secretWrites && new SecretValues(db, now, options.secretWrites.holder,
    options.secretWrites.fingerprintKey, secretCommit);
  const privateInputs=new SecretPrivateInputs(db,clock,options.secretInputs?.source,secretCommit);
  startupCleanups.push(()=>{void Promise.resolve(privateInputs.close()).catch(report);});
  registerKitReads(operations,db,credentials);
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
    // The stop word ends a job through the runtime's own Stop, and is announced as any ended job is.
    stopJob:(job,member)=>{new Jobs(db,now).stop(job,member,'stop');},
    jobsEnded:ids=>{for(const id of ids)jobEnded(id);tempo?.capacityChanged();},
    reportError:()=>{try{options.reportError(new Error('Bridge processing unavailable'));}catch{}}});
  const lastSecretChange=()=>db.select({id:sql<number>`coalesce(max(rowid),0)`}).from(secretChanges).get()!.id;
  let secretChange=bridgeDaemon?lastSecretChange():0;
  const unobserveBridges=bridgeDaemon&&data.writes.observe(()=>{
    const latest=lastSecretChange(),credentialsChanged=latest!==secretChange;secretChange=latest;
    bridgeDaemon.changed(credentialsChanged);
  });
  startupCleanups.push(()=>{unobserveBridges?.();void bridgeDaemon?.close().catch(()=>report(new Error('Bridge startup cleanup failed')));});
  comms?.install(operations);
  // A conversation's harness session, kept sealed between bodies: needs the words key, as Comms does.
  const sessions=options.commsKey?new ConversationSessions(db,now,options.commsKey):undefined;
  if (options.commsKey) registerTerminalSession(operations, db, options.commsKey, credentials.terminalMachine, now);
  registerJobUsage(operations, db, credentials.body, now);
  if(sessions)registerConversationSessions(operations,db,sessions,bodyScope,words=>options.commsKey!.hash(words));
  if(comms)registerConversationBodyOperations(operations,comms.service,credentials.body,scope=>mayRunPrivateWork(scope,sharedSharing(db)),comms.authorizeQuestion,{...selfHandoff(db,comms.service.threads.conversations,()=>new Date(clock.now()).toISOString()),ownerWork:work=>jobWord(db,work.job).woke==='owners',codexAvailable:agent=>dispatcher.canStartReview(agent)},{question:(work,question)=>askedOnWord(db,work,question),summary:work=>writtenOnWord(db,work)?.line,quiet:work=>jobHeld(db,work.job)});
  // How machines and agents are set up. Installed code calls these directly, inside a write;
  // anything outside goes through household.propose and a household owner's Allow.
  const recount = () => queueMicrotask(() => { try { tempo?.capacityChanged(); } catch (error) { report(error); } });
  const setup = {
    machine(input: Parameters<typeof applyBoxSettings>[1]) { applyBoxSettings(db, input); recount(); },
    run(member: string, input: Parameters<typeof applyAgentRunSettings>[2]) { applyAgentRunSettings(db, { kind: 'member', id: member }, input); recount(); },
    models(input: Parameters<typeof applyAgentModels>[1]) { applyAgentModels(db, input, roles()); recount(); },
    bodyPolicy(input: Parameters<typeof saveAgentBodyPolicy>[1]) { saveAgentBodyPolicy(db, input); },
    // People, projects and the household's own settings.
    member(input: Parameters<typeof householdSettings.setMember>[0]) { return householdSettings.setMember(input); },
    agent(input: Parameters<typeof householdSettings.setAgent>[0]) { return householdSettings.setAgent(input); },
    settings(input: Parameters<typeof householdSettings.setSettings>[0]) { return householdSettings.setSettings(input); },
    project(input: Parameters<typeof projectSettings.save>[0]) { return projectSettings.save(input); },
    accounts(input: { agent: string; github: string[] }) { return householdAccess.setAccounts(input); },
    rule(input: Parameters<typeof ruleSettings.set>[0], owner: string) { return ruleSettings.set(input, owner); },
    // Secrets and bridges.
    secretRule(input: Parameters<SecretRequests['setRule']>[0]) { requests.setRule(input); },
    secretDefault(answer: Parameters<typeof householdSettings.setSecretsDefault>[0]) { householdSettings.setSecretsDefault(answer); },
    houseSecrets(input: Parameters<typeof setHouseSecrets>[1]) { setHouseSecrets(db, input); },
    bridge(input: Parameters<BridgeSettings['change']>[0]) { return late.bridges!().change(input); },
    /** File a proposal card on an agent's behalf, as household.propose does for an outside caller. */
    propose(agent: string, change: { change: string; input: unknown; why: string }, where?: { conversation: string; member: string | null; project: string | null }) { return householdProposals.file(services.approvals, agent, change, where); },
    /** The one place a machine is revoked: by installed code directly, and by an allowed household proposal. */
    revokeMachine(id: string) { db.update(boxes).set({ revokedAt: now() }).where(and(eq(boxes.id, id), isNull(boxes.revokedAt))).run(); recount(); },
  };
  late.revokeMachine = id => setup.revokeMachine(id);
  const services = {
    setup,
    bridges: {daemon:bridgeDaemon,settings:new BridgeSettings(db,now,write=>{const result=data.writes.run(write);for(const _error of result.notificationErrors){try{options.reportError(new Error('Bridge write notification failed'));}catch{}}return result.value;})},
    tasks,
    changes: changeService(db,options.changes?.rule ?? (()=>undefined),now,run=>{
      const result=data.writes.run(run);
      for(const _error of result.notificationErrors){try{options.reportError(new Error('Changes source notification failed'));}catch{}}
      return result.value;
    }),
    household: householdSettings,
    projects: projectSettings,
    signin: tokenSettings,
    programSetup,
    account: sharedAccount(db, clock),
    householdAccess,
    notifications: pushes,
    approvalRules: ruleSettings,
    approvals: approvalService(db, approvedOperations, now),
    conversations: comms?.service.threads.conversations ?? new Conversations(db, now, lateMailWaits),
    comms: comms?.service,
    runtime,
    secrets: {requests,values,inputs:privateInputs,reconcile:recoverSecrets},
  };
  // Attachments are read here too (bridges.file). Only a daemon fetches them, so without one there is
  // nothing to read but what an earlier configuration left, and that is erased after fourteen days.
  const dispatcher=registerSharedRuntime(operations, db, { now, roles, jobEnded, runner: credentials.runner,
    applyProgram: (job, result, changed) => applyProgramResult(db, services.conversations, bridgeDaemon, () => options.bridges?.effectsAllowed() ?? false, job, result, changed) });
  if(bridgeDaemon)registerSharedBridgeReply(operations,db,bridgeDaemon,services.conversations,bodyScope,options.bridges!.effectsAllowed);
  registerSharedTokenAdmin(operations, db, services.signin);
  registerSharedAccount(operations, db, services.account);
  registerSharedHouseholdAccess(operations, db, services.householdAccess);
  householdProposals.register(operations, services.approvals, bodyScope, held('propose'));
  const stopHouseholdProposals = data.writes.observe(() => householdProposals.committed(() => { tempo?.capacityChanged(); data.changed(); }));
  startupCleanups.push(stopHouseholdProposals);
  registerSharedTaskCommands(operations, db, services.tasks, held('task'));
  registerSharedBridgeCommands(operations,db,services.bridges.settings);
  const commsLifetime = comms ? conversationLifetime(db, jobClock('conversations.expire'), comms.service, data.writes, options.reportError) : undefined;

  startupCleanups.push(()=>commsLifetime?.close());

  const settingsBinding = sharedTempoSettings(bodyScope);
  try { tempo = installSharedTempo(db, jobClock('tempo.tick'), data.writes, operations, services.conversations, data.changed, {
    ...options.tempo, notify: (member,ids)=>{const result=options.tempo?.notify?options.tempo.notify(member,ids):notices.publish(member,ids);pushes?.publish(member,ids);return result;}, chatMember: options.tempo?.chatMember ?? settingsBinding.chatMember,
    bodyWork: viewer => bodyScope(viewer), bodyJob,
    // A repeating schedule asked for on anybody else's word is an owner's to allow: filed as a household card.
    askOwners: (agent, ask, why, where) => householdProposals.file(services.approvals, agent, { change: 'placeSchedule', input: ask, why }, where).id,
    mailboxReceiptScope: options.tempo?.mailboxReceiptScope ?? settingsBinding.receiptScope,
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

  const executeCommand=async(auth:NonNullable<ReturnType<typeof authenticate>>,name:string,input:unknown,id?:string,signal?:AbortSignal)=>{
    if(closing||!auth.valid())return failure('denied','Authentication ended');
    const answer=await operations.callAsync('http',auth.viewer,name,input,id,auth.window===true,()=>!closing&&auth.valid()&&!signal?.aborted,signal);
    if(!closing)recordActionResult({db,writes:data.writes,operations,viewer:auth.viewer,window:auth.window===true,name,input,id,result:answer,now:()=>clock.now(),reportError:options.reportError});
    return closing||!auth.valid()?failure('denied','Authentication ended'):answer;
  };

  const active = new Set<{ abort: AbortController; done: Promise<void> }>();
  const http = new Hono<{ Variables: { shutdown: AbortController } }>();
  const bodyRequest = (request: Request, abort: AbortController, limited = false) => {
    let size = 0;
    return request.body ? new Request(request, {
      body: request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, stream) {
          size += chunk.byteLength;
          if (limited && size > DOOR_REQUEST_BYTES) throw new BodyTooLarge();
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
        if(path!=='/graphql'&&path!=='/mcp'&&(!command||!credentials.allows(auth.viewer,`${command[1]}.${command[2]}`)))return c.json(failure('denied','Permission denied'),403);
      }
      await next();
    } finally { active.delete(entry); finished(); }
  });
  http.route('/', sharedSigninLinkRoutes({ db, clock, writes: data.writes, issueProgram:programSetup?input=>{const parsed=programIssueInput.safeParse(input);if(!parsed.success)throw new OperationError('invalid','Invalid program token request');return programSetup.issue(parsed.data);}:undefined, publicOrigin: options.publicOrigin, admitted: () => !closing, reportError: options.reportError, authenticate:request=>authenticate(request,{programs:'deny'}) }));
  http.all('/graphql', c => data.http.fetch(bodyRequest(c.req.raw, c.get('shutdown'))));
  // /mcp is not a door of its own. Its tools are a client of the command door below: the same caller, the
  // same `may`, the same receipts, dispatched as 'http'. So an operation's `doors` list cannot keep it off
  // /mcp while it is on /api, and none tries to: what a caller may do is decided by who they are, not by
  // which of the two they came through.
  http.all('/mcp',c=>{const auth=authenticate(c.req.raw),agent=c.req.header('x-loom-agent');return sharedMcpRequest({request:bodyRequest(c.req.raw,c.get('shutdown'),true),clock,publicOrigin:options.publicOrigin,agent:auth?.viewer.kind==='agent'?auth.viewer.id:undefined,command:(name,input,id)=>auth?executeCommand(auth,name,input,id,c.req.raw.signal):Promise.resolve(failure('denied','Authentication required')),valid:()=>!closing&&!!auth?.valid()&&(!agent||auth.viewer.kind==='agent'&&auth.viewer.id===agent),fetch:async(input,init)=>http.fetch(new Request(input,init))});});
  http.onError(() => Response.json(failure('unavailable', 'Request could not complete'), { status: 503, headers: { 'cache-control': 'no-store' } }));
  http.post('/api/conversation/take', async c => comms ? takeBodyInput({request:bodyRequest(c.req.raw,c.get('shutdown'),true),service:comms.service,scope:bodyScope,authenticate,admitted:()=>!closing,version:data.readVersion,writes:data.writes,now:()=>clock.now(),publicOrigin:options.publicOrigin,reportError:options.reportError}) : c.json(failure('unavailable','Conversation input unavailable'),503));
  http.route('/api/kits/private',kitBroker({db,credentials,source:options.secretInputs?.source,now,write:secretCommit,readJson:(request,abort)=>bodyRequest(request,abort,true).json()}));
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
    const answer=await executeCommand(auth,`${c.req.param('piece')}.${c.req.param('operation')}`,parsed.data.input,parsed.data.id,request.signal);

    return c.json(answer, answer.ok ? 200 : ({ denied: 403, 'not-found': 404, invalid: 400, conflict: 409, unavailable: 503 } as const)[answer.code]);
  });
  if(options.commsKey)registerSharedWorkBody(operations,db,services.approvals,services.approvalRules,bodyScope,words=>options.commsKey!.hash(words),credentials.agentSession,held('approval'));
  registerSharedWorkCommands(operations,db,services.approvals, {
    now, bodyJob, isProgram: viewer => !!credentials.program(viewer), words: comms?.service.words.bind(comms.service),
    terminal: viewer => credentials.terminalMachine(viewer),
  });
  registerSharedWorkAlways(operations,db,services.approvals,services.approvalRules);
  if (changePolling) registerWorkRefresh(operations,db,changePolling.refresh);
  if(comms)for(const row of recentReviewEnds(comms.service))deliverReview(row.id);
  if (!options.deferRuntimeStart) runtime.start();
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
      for(const cancel of reviewRetries.values())cancel();
      reviewRetries.clear();
      stopMemoryWrites();stopHouseholdProposals();memorySignals?.close();
      stopMachineReads();
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
      void Promise.allSettled([stopped, pushesStopped, sourceStopped, bridgesStopped, inputsStopped, measured, secretRecovery, ...reviewReports, ...pending.map(entry => entry.done)]).then(results => {
        try { try{operations.close();}finally{memory.close();} } catch (error) { reject(error); return; }
        const failed = results.find(result => result.status === 'rejected');
        if (failed) reject(failed.reason); else resolve();
      });
      return closing;
    },
  };
  }catch(error){closing=Promise.resolve();for(const stop of stops.splice(0).reverse())try{stop();}catch{};void measuringReady?.then(value=>value.close()).catch(report);for(const stop of startupCleanups.reverse())try{stop();}catch{report(new Error('Shared startup cleanup failed'));}throw error;}
}
