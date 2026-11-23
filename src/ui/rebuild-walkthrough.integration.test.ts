/** One test per app keeps browser evidence within the normal 20-second budget. */
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {walkthroughSteps} from '../../scripts/rebuild-walkthrough.mjs';
const titles=['Tasks','Approvals','Sharing','Changes','Inbox','Tempo','Home','Projects','Activity','Job usage','Comms','Agents','People','Knowledge','Bridges','Machines and jobs','Subscriptions','Settings','Household setup','Your account','Appearance'];
describe.skipIf(!process.env.LOOM_TEST_CHROME)('built program walkthrough',()=>{
 let steps:ReturnType<typeof walkthroughSteps>,out:string,ready=false,runtimeTitle:string;
 beforeAll(async()=>{
  vi.stubEnv('TZ','America/Chicago');
  out=process.env.LOOM_TEST_SHOTS??mkdtempSync(join(tmpdir(),'loom-walkthrough-proof-'));
  steps=walkthroughSteps(out);const step=await steps.next();
  expect(step.value.phase,step.value.fatal).toBe('ready');ready=true;const report=step.value.report;
  expect(report.signin.ok).toBe(true);expect(report.signin.personBrowser).toBe(true);expect(report.example.members).toEqual(['alex','robin']);
  expect(report.isolation).toMatchObject({http:'blocked',websocket:'blocked'});
  expect(report.isolation.consoleErrors.join(' ')).toContain('Walkthrough console capture probe');
  expect(report.inventory).toEqual(titles);runtimeTitle=report.example.runtime.job.title;expect(report.example.runtime.job.state).toBe('queued');
  expect(report.clock).toMatchObject({householdZone:'America/Chicago',browserZone:'Asia/Tokyo',title:expect.stringMatching(/, America\/Chicago time$/)});
 },60_000);
 it('measures encrypted private-word expiry on the program clock',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('retention');
  const result=step.value.actions?.conversationRetention;expect(result,JSON.stringify(result)).toMatchObject({ok:true,before:{days:14,encrypted:true,readable:true,browserReadable:true,readableUntilDeadline:true},after:{ciphertextErased:true,words:null,metadataRetained:true,metadataCompared:expect.arrayContaining(['sender','kind','at'])}});
 });
 it('expires private words under a shorter household policy after restart',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('short-retention');
  const result=step.value.actions?.conversationShortRetention;
  expect(result,JSON.stringify(result)).toMatchObject({ok:true,before:{days:3,encrypted:true,readableUntilDeadline:true},after:{ciphertextErased:true,words:null,metadataRetained:true}});
 });
 it('compares actual Sharing SQL executions at two and ten projects',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('data-growth');
  const result=step.value.actions.dataSharingSQL;
  expect(result.samples,JSON.stringify(result)).toHaveLength(2);expect(result.samples.map(sample=>sample.projects)).toEqual([2,10]);
  expect(result.samples.every(sample=>sample.sqlExecutions>0)).toBe(true);
  expect(result.ok===false||result.inconclusive===true).toBe(true);
 });
 for(const title of titles)it(`collects ${title} from the real launcher`,{retry:0,...(title==='Approvals'?{timeout:180_000}:{})},async()=>{
  const step=await steps.next();expect(step.value.phase).toBe('app');const app=step.value.row;
  expect(app.title).toBe(title);expect(app.opened||!!app.error).toBe(true);
  expect(app.text.trim().length).toBeGreaterThan(0);
  expect(Array.isArray(app.consoleErrors)).toBe(true);expect(Array.isArray(app.live.frames)).toBe(true);
  expect(readFileSync(join(out,app.screenshot)).subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
  if(title==='Approvals')expect(step.value.report.actions?.approvalRulesAndExpiry,JSON.stringify(step.value.report.actions)).toMatchObject({ok:true});
  if(title==='Settings')expect(app.valueAction,JSON.stringify(app.valueAction)).toMatchObject({ok:true,added:true,replaced:true,removed:true,persistedAfterReload:true,writeOnly:true,recorded:true,ruleSaved:true});
  if(title==='Tasks')expect(step.value.report.actions?.taskQuestions,JSON.stringify(step.value.report.actions)).toMatchObject({ok:true});
  if(title==='Machines and jobs')expect(step.value.report.actions.machineRoster).toMatchObject({ok:true,owner:'alex',agents:['fern','moss']});
  if(title==='Machines and jobs'){expect(app.error).toBeUndefined();expect(app.queuedShownAsRunning).toBe(0);expect(app.runtimeJobs).toContainEqual({title:runtimeTitle,status:expect.stringMatching(/^Queued · queued /)});}
  if(title==='Comms')expect(step.value.report.actions?.taskInlineQuestion,JSON.stringify(step.value.report.actions)).toMatchObject({ok:true});
  if(title==='Approvals')expect(step.value.report.actions?.approvalDecisions,JSON.stringify(step.value.report.actions)).toMatchObject({ok:true});
  if(title==='Changes')expect(step.value.report.actions?.workVisibility,JSON.stringify(step.value.report.actions)).toMatchObject({ok:true});
  if(title==='Settings')expect(app.action,JSON.stringify(app.action)).toMatchObject({ok:true,before:'ask',after:'never',persistedAfterReload:true});
  if(title==='Changes')expect(step.value.report.actions?.changeWorkflow,JSON.stringify(step.value.report.actions)).toMatchObject({ok:true});
  if(title==='Tasks')for(const name of ['taskReady','taskLifecycle','taskStructure','taskComments'])expect(step.value.report.actions?.[name],JSON.stringify(step.value.report.actions)).toMatchObject({ok:true});
  if(title==='Bridges')expect(app.action,JSON.stringify(app.action)).toMatchObject({ok:true,discordChannel:true,slackPerson:true,persistedAfterReload:true});
  if(title==='People')expect(step.value.report.actions?.commsSend,JSON.stringify(step.value.report.actions)).toMatchObject({ok:true,persistedAfterReload:true,inboxCopies:1});
  if(title==='Comms')for(const action of ['conversationTaskSource','conversationApprovalSource','conversationPrivatePair'])expect(step.value.report.actions[action],JSON.stringify(step.value.report.actions[action])).toMatchObject({ok:true});
  if(title==='Comms')expect(app.detailText).toContain('Three fit. The quiet model');
  if(title==='Comms'){const result=step.value.report.actions?.conversationRecords;expect(typeof result?.ok).toBe('boolean');if(!result.ok)expect(result.error).toBeTruthy();}
  if(['Your account','Household setup','Sharing'].includes(title))expect(app.action,JSON.stringify(app.action)).toMatchObject({ok:true});
  if(title==='Home'){const result=step.value.report.actions?.homeMessage;expect(result,JSON.stringify(result)).toMatchObject({ok:true,inboxCopies:1,persistedAfterReload:true});}
  if(title==='Subscriptions')expect(step.value.report.actions.modelsMachines,JSON.stringify(step.value.report.actions.modelsMachines)).toMatchObject({ok:true});
  if(title==='Activity')for(const action of ['activityWorkLinks','activityDays']){
   const result=step.value.report.actions[action];
   expect(result,JSON.stringify(result)).toMatchObject({ok:true});
  }
  if(title==='Knowledge'){
   expect(app.action,JSON.stringify(app.action)).toMatchObject({ok:true,provisional:true,rechecked:true,verified:true,persistedAfterReload:true,connection:'existing /graphql'});
   const source=step.value.report.actions.knowledgeSourceCheck;
   expect(source,JSON.stringify(source)).toMatchObject({ok:true});
  }
  if(title==='Tempo')expect(app.actions.resumed.facts).toMatchObject({sourceKind:'answer',watches:'approval:'+step.value.report.example.approval,lifespan:'once',enabled:false,stillOnceAfterLaterDeadline:true});
  if(title==='Tempo'){expect(app.error).toBeUndefined();expect(app.actions).toMatchObject({held:{ok:true},resumed:{ok:true},settled:{ok:true},cancelled:{ok:true}});for(const name of ['held','resumed','settled','cancelled'])expect(readFileSync(join(out,app.actions[name].screenshot)).subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));}
 });
 it('refreshes an owner advisory and rechecks a stale proposal',{retry:0,timeout:150_000},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('approval-caution');
  const result=step.value.actions?.approvalCaution;expect(result,JSON.stringify(result)).toMatchObject({ok:true});
 });
 it('executes prepared changes through their private approval cards',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('prepared-changes');
  expect(step.value.actions?.approvalPreparedChanges,JSON.stringify(step.value.actions)).toMatchObject({ok:true});
 });
 it('follows conversation PR references to their linked task',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('change-references');
  expect(step.value.actions.conversationChangeCard,JSON.stringify(step.value.actions.conversationChangeCard)).toMatchObject({ok:true,ref:'github:example-house/garden#12',messageSeq:expect.any(Number)});
  expect(step.value.actions.changeInline,JSON.stringify(step.value.actions.changeInline)).toMatchObject({ok:true});
 });
 for(const answer of ['yes','no','words'])it(`records the Inbox ${answer} decision`,{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('inbox-decision');expect(step.value.answer).toBe(answer);
  const result=step.value.actions['inboxDecision'+answer[0].toUpperCase()+answer.slice(1)];expect(result,JSON.stringify(result)).toMatchObject({ok:true,answer});
 });
 it('retains all answered Inbox questions and read marks',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('inbox-history');
  for(const name of ['inboxConsequences','inboxDecisions','inboxHistory'])expect(step.value.actions[name],JSON.stringify(step.value.actions[name])).toMatchObject({ok:true});
 });
 it('counts only items needing an answer on the desk',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('desk-waiting');
  expect(step.value.actions.deskWaiting,JSON.stringify(step.value.actions.deskWaiting)).toMatchObject({ok:true});
 });
 it('shows a live Codex session on its agent’s rail card until it ends',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('desk-jobs');
  expect(step.value.actions.deskJobs,JSON.stringify(step.value.actions.deskJobs)).toMatchObject({ok:true});
 });
 it('tracks the counts on the desktop ticker as work moves',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('desk-ticker');
  expect(step.value.actions.deskTicker,JSON.stringify(step.value.actions.deskTicker)).toMatchObject({ok:true});
 });

 it('reads every installed panel as an owner and a project member',{retry:0,timeout:180_000},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('desk-panel-visibility');
  const result=step.value.actions.deskPanelVisibility;
  expect(result,JSON.stringify(result)).toMatchObject({ok:true});
  expect(result.projectMember).toEqual(result.owner);
 });
 it('answers in Inbox and shows the answer in Comms',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('actions');
  for(const name of ['commsSend','inboxAnswer','commsAnswer'])expect(step.value.actions?.[name],JSON.stringify(step.value.actions)).toMatchObject({ok:true});
 });
 it('measures desk launcher and tile controls',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('desk');
  expect(step.value.actions.deskShell,JSON.stringify(step.value.actions.deskShell)).toMatchObject({ok:true});
  for(const name of ['deskLauncher','deskGeometry','deskLayout']){

   const result=step.value.actions?.[name];expect(typeof result?.ok).toBe('boolean');
   if(!result.ok)expect(result.error).toBeTruthy();
   expect(readFileSync(join(out,result.screenshot)).subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
  }
 });
 it('measures desk looks and persisted appearance',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('appearance');
  for(const name of ['deskLooks','deskAppearance'])expect(step.value.actions[name],JSON.stringify(step.value.actions[name])).toMatchObject({ok:true});
 });
 it('draws all fallback agent faces and follows a reply through its expressions',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('desk-faces');
  expect(step.value.actions.deskFaces,JSON.stringify(step.value.actions.deskFaces)).toMatchObject({ok:true});
 });
 it('keeps appearance choices separate across two signed-in members',{retry:0,timeout:60_000},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('member-appearance');
  expect(step.value.actions.memberAppearance,JSON.stringify(step.value.actions.memberAppearance)).toMatchObject({ok:true});
 });
 it('answers a desktop task question through a single tap on the phone Inbox dock icon',{retry:0,timeout:60_000},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('phone-task');
  expect(step.value.actions.phoneTask).toMatchObject({ok:true});
 });
 it('keeps each agent’s memories in its own file across a restart',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('agent-memory-files');
  expect(step.value.actions.agentMemoryFiles,JSON.stringify(step.value.actions.agentMemoryFiles)).toMatchObject({ok:true});
 });
 it('recalls paraphrases by meaning and retains the most-used fact at the top of mind',{retry:0,timeout:120_000},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('semantic-recall');
  expect(step.value.actions.semanticRecall,JSON.stringify(step.value.actions.semanticRecall)).toMatchObject({ok:true,paraphrases:3});
 });
 it('observes category cooling, archive expiry and lesson confidence across restarts',{retry:0,timeout:40_000},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('memory-temperature');
  expect(step.value.actions.sessionEpisode).toMatchObject({ok:true,day:'2027-01-01'});
  expect(step.value.actions.memoryTemperature).toMatchObject({ok:true,episodeDay:0.5,personDay90:0.5,expiryAtDeadline:true,confidenceObservations:3});
 });
 it('delivers due Knowledge checks to the configured agents on the household clock',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('knowledge-due');
  expect(step.value.actions.knowledgeDue,JSON.stringify(step.value.actions.knowledgeDue)).toMatchObject({ok:true,days:30});
 });
 it('keeps three linked worker start retries across coordinator restarts',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('worker-start-retries');
  expect(step.value.actions.workerRetries,JSON.stringify(step.value.actions.workerRetries)).toMatchObject({ok:true,attempts:4});
 });
 it('writes and reads notes and shared Knowledge through the named MCP tools',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('named-agent-tools');
  for(const name of ['namedNotes','namedKnowledge','sharedKnowledgeAudience','sharedHouseholdFiles'])expect(step.value.actions[name],JSON.stringify(step.value.actions[name])).toMatchObject({ok:true});
 });
 it('keeps and expires notes by path and lifespan across restarts',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('note-lifetimes');
  expect(step.value.actions.noteLifetimes,JSON.stringify(step.value.actions.noteLifetimes)).toMatchObject({ok:true,editedNoteExpiredAfterRenewal:true,onlyFactRecalled:true,after60Days:['keep']});
 });
 it('restores every retained version of memories, person cards and Knowledge pages',{retry:0,timeout:120_000},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('memory-revisions');
  expect(step.value.actions.memoryRevisions,JSON.stringify(step.value.actions.memoryRevisions)).toMatchObject({ok:true,originalVersionsRestoredPerType:10,restoreCallsPerType:11});
 });
 it('measures browser lifetime, owner revocation and credential storage through the sign-in door',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('signin-door');
  const door=step.value.actions.signinDoor;
  expect(door,door.error).toMatchObject({ok:true,checks:{memberIdentityBound:true,sixHourAutomatedSession:true,personSessionRetained:true,ownerHouseholdList:true,ownerSessionRevocation:true,ownerTokenRevocation:true,tokenCookieLinkFingerprints:true,rawSecretsNeverPersisted:true,closed:true}});
 });
 it('upgrades every shipped database and checks its migration ledger on reopen',{retry:0,timeout:300_000},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('migrations');
  expect(step.value.actions.dataMigrations,JSON.stringify(step.value.actions.dataMigrations)).toMatchObject({ok:true,from:1});
 });
 for(const device of ['desktop','phone'])it('observes one data connection through all '+device+' tiles and a disconnect',{retry:0,timeout:180_000},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('tile-reads-'+device);
  const confirmed=step.value.actions.deskTileReads.find(row=>row.device===device);
  expect(confirmed,JSON.stringify(confirmed)).toMatchObject({ok:true,restoredSelection:true,liveReaderUpdate:true});
  expect([...confirmed.tiles].sort()).toEqual([...titles].sort());
 });
 it('measures the data door, fact queries and live changes',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('data');
  for(const name of ['dataDoor','dataSelectionSQL','dataInboxChange','dataWriteReceipt'])expect(step.value.actions[name],JSON.stringify(step.value.actions[name])).toMatchObject({ok:true});
  expect(step.value.actions.dataCaller).toMatchObject({ok:true,browserMember:'alex',tokenMember:'robin'});
  expect(step.value.actions.dataTaskPatches).toMatchObject({ok:true,inconclusive:true,initialRevision:1,requests:1});
  expect(step.value.actions.dataSharingSQL.statements.length).toBeGreaterThan(0);
  expect(step.value.actions.dataSharingSQL.samples.map(sample=>sample.projects)).toEqual([2,10]);
  expect(step.value.actions.dataSharingSQL.samples.every(sample=>sample.sqlExecutions>0)).toBe(true);
  for(const name of ['dataDoor','dataSelectionSQL','dataSharingSQL','dataTaskPatches','dataInboxChange']){const result=step.value.actions?.[name];expect(result?.inconclusive||typeof result?.ok==='boolean').toBe(true);if(result.ok===false)expect(result.error??result.reason).toBeTruthy();}


 });
 it('bounds actual Home summary SQL as owned agents grow',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('home-read-growth');
  const result=step.value.actions.dataHomeGrowth;expect(result,JSON.stringify(result)).toMatchObject({ok:true});
  expect(result.samples.map(sample=>sample.agents)).toEqual([2,10]);expect(result.samples.every(sample=>sample.sqlExecutions>0)).toBe(true);
 });
 it('checks owner and member conversation privacy through normal browser sign-in',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('visibility');
  for(const name of ['conversationLabels','conversationVisibility','commsPrivacy','inboxVisibility','inboxRecipients'])expect(step.value.actions[name],JSON.stringify(step.value.actions[name])).toMatchObject({ok:true,isolation:{http:'blocked',websocket:'blocked'},cleanup:{restored:true,contextClosed:true,credentialAbsent:true}});
 });
 it('follows an Inbox approval to its exact source and resolves the item',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('approval-source');expect(step.value.actions.approvalInbox,JSON.stringify(step.value.actions.approvalInbox)).toMatchObject({ok:true});
 });
 it('follows an Inbox task to its source and records its completed outcome',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('task-source');
  const arrival=step.value.actions.inboxTaskArrival;expect(typeof arrival.ok,JSON.stringify(arrival)).toBe('boolean');
  if(arrival.ok===false)expect(arrival.error).toContain('did not offer a source link');
  for(const name of ['inboxTaskSettlement','inboxSourceOutcome'])expect(step.value.actions[name],JSON.stringify(step.value.actions[name])).toMatchObject({ok:true});
  expect(step.value.actions.inboxSourceTargets).toMatchObject(arrival.ok?{ok:true}:{inconclusive:true});
 });
 it('follows a pending secret request from Inbox to its owner decision',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('secret-source');
  expect(step.value.actions.inboxSecretRequest).toMatchObject({ok:true});
 });
 it('delivers private source replies, a native handoff and a wake through the one Inbox',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('conversation-mail');
  expect(step.value.actions.conversationTurns,JSON.stringify(step.value.actions.conversationTurns)).toMatchObject({ok:true});
  expect(step.value.actions.conversationSingleJob).toMatchObject({ok:true,deliveries:3});
  expect(step.value.actions.conversationTempoDelivery).toMatchObject({ok:true,recipient:'moss'});
  for(const name of ['privateConversationBatch','nativeHandoff','conversationInboxIngress'])expect(step.value.actions[name],JSON.stringify(step.value.actions[name])).toMatchObject({ok:true,currentJobFixtures:true,providerStarted:false});
 });
 it('records a private background question in Inbox and returns its answer to the body',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('conversation-mail-question');
  for(const name of ['privateConversationBatch','nativeHandoff','conversationInboxIngress','privateConversationQuestion'])expect(step.value.actions[name],JSON.stringify(step.value.actions[name])).toMatchObject({ok:true,currentJobFixtures:true,providerStarted:false,cleanup:{jobsStopped:true,credentialsRevoked:true}});
 });
 it('delivers a scheduled reminder only to its recipient and preserves it across restart',{retry:0},async()=>{
  const step=await steps.next();
  expect(step.value.phase,step.value.fatal).toBe('scheduled-inbox');
  const action=step.value.actions.scheduledInbox;
  expect(action,JSON.stringify(action)).toMatchObject({ok:true,recipients:2,delivered:2,unchangedAfterRestart:true});
 });
 it('follows the Inbox documentation links and exercises recipient volume through restarts',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('inbox-volume');
  for(const name of ['inboxDocumentation','inboxVolume'])expect(step.value.actions[name],JSON.stringify(step.value.actions[name])).toMatchObject({ok:true});
 });
 it('opens a standalone FYI in Comms, reopens it and sends a question with the notice in context',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('inbox-discussion');
  const action=step.value.actions.inboxDiscussion;
  expect(action,JSON.stringify(action)).toMatchObject({ok:true,item:expect.any(String),thread:expect.any(String),conversation:expect.any(String)});
 });
 it('updates each Home card independently as terminal jobs start and end',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('home-jobs');
  expect(step.value.actions.homeJobs).toMatchObject({ok:true});
 });
 it('completes the actual worker/body protocol and reads its persisted private reply',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('native-protocol');
  expect(step.value.actions.nativeProtocol,JSON.stringify(step.value.actions.nativeProtocol)).toMatchObject({ok:true,runs:expect.arrayContaining([expect.objectContaining({running:true,state:'done',bootstrapErased:true})])});
  expect(step.value.actions.nativeProtocol.runs).toHaveLength(2);
  expect(step.value.actions.conversationSecretSource).toMatchObject({ok:true});
  expect(step.value.actions.conversationDigest,JSON.stringify(step.value.actions.conversationDigest)).toMatchObject({ok:true});
  expect(step.value.actions.nativeReply).toMatchObject({ok:true,persistedAfterReload:true});
 });
 it('starts a worker body from a timed agent Inbox item',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('scheduled-worker');
  expect(step.value.actions.scheduledWorker,JSON.stringify(step.value.actions.scheduledWorker)).toMatchObject({ok:true,completedConversations:2});
 });
 it('delivers Discord and Slack messages into the receiving agent Inbox',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('bridge-mail');
  expect(step.value.actions.bridgeReceipts,JSON.stringify(step.value.actions.bridgeReceipts)).toMatchObject({ok:true});
  for(const platform of ['discordConversations','slackConversations'])expect(step.value.actions[platform],JSON.stringify(step.value.actions[platform])).toMatchObject({ok:true});
  expect(step.value.actions.bridgeMail,JSON.stringify(step.value.actions.bridgeMail)).toMatchObject({ok:true});
 });
 it('applies Inbox access to the actual HTTP caller',{retry:0},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('inbox-callers');
  expect(step.value.actions.conversationCallers,JSON.stringify(step.value.actions.conversationCallers)).toMatchObject({ok:true});
  expect(step.value.actions.inboxCallers,JSON.stringify(step.value.actions.inboxCallers)).toMatchObject({ok:true});
 });
 afterAll(async()=>{
  try{
   if(!ready)return;
   const step=await steps?.next();expect(step?.done).toBe(true);const report=step?.value;
   expect(report.fatal).toBeUndefined();
   expect(report.live.dataFrames).toBeGreaterThan(0);
   const measured=JSON.parse(readFileSync(join(out,'report.json'),'utf8'));
   expect(measured.pages).toHaveLength(20);
   const tempo=measured.pages.find((page:{page:string})=>page.page==='tempo');
   const observed=tempo.promises.filter((entry:{probe?:{kind:string;action?:string}})=>entry.probe?.kind==='action'&&entry.probe.action?.startsWith('tempo'));expect(observed).toHaveLength(5);expect(observed.map((entry:{status:string})=>entry.status)).toEqual(['met','met','met','met','met']);
   for(const name of ['tempoHeld','tempoResumed','tempoSettled','tempoCancelled'])expect(report.actions[name]).toMatchObject({ok:true,screenshot:expect.any(String)});
   for(const [name,count] of [['tasks',20],['approvals',22],['changes',17]] as const){
    const measuredPage=measured.pages.find((page:{page:string})=>page.page===name);
    expect(measuredPage,`Missing ${name} report`).toBeDefined();
    expect(measuredPage.promises).toHaveLength(count);
    const outstanding=measuredPage.promises.filter((promise:{status:string})=>promise.status!=='met');
    expect(outstanding,`${name} promises lack complete behavioral evidence: ${JSON.stringify(outstanding)}`).toEqual([]);
   }
   expect(measured.pages.every((page:{promises:unknown[]})=>page.promises.length>0)).toBe(true);
   expect(JSON.stringify(report)).not.toMatch(/AGE-SECRET-KEY-|\/login\/[a-zA-Z0-9_-]{24,}/);
  }finally{vi.unstubAllEnvs();await steps?.return(undefined);if(out&&!process.env.LOOM_TEST_SHOTS)rmSync(out,{recursive:true,force:true});}
 });
});
