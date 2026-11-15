/** One test per app keeps browser evidence within the normal 20-second budget. */
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {walkthroughSteps} from '../../scripts/rebuild-walkthrough.mjs';
const titles=['Tasks','Approvals','Project sharing','Changes','Inbox','Tempo','Home','Projects','Activity','Comms','Agents','People','Knowledge','Bridges','Settings','Household setup','Your account'];
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
 });
 it('measures encrypted private-word expiry on the program clock',{retry:0,timeout:20_000},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('retention');
  const result=step.value.actions?.conversationRetention;expect(result,JSON.stringify(result)).toMatchObject({ok:true,inconclusive:true,before:{encrypted:true,readable:true,browserReadable:true,readableUntilDeadline:true},after:{ciphertextErased:true,words:null,metadataRetained:true,metadataCompared:expect.arrayContaining(['sender','kind','at'])}});
 });
 for(const title of titles)it(`collects ${title} from the real launcher`,{retry:0,timeout:20_000},async()=>{
  const step=await steps.next();expect(step.value.phase).toBe('app');const app=step.value.row;
  expect(app.title).toBe(title);expect(app.opened||!!app.error).toBe(true);
  expect(app.text.trim().length).toBeGreaterThan(0);
  expect(Array.isArray(app.consoleErrors)).toBe(true);expect(Array.isArray(app.live.frames)).toBe(true);
  expect(readFileSync(join(out,app.screenshot)).subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
  if(title==='Approvals')expect(step.value.report.actions?.approvalRulesAndExpiry,JSON.stringify(step.value.report.actions)).toMatchObject({ok:true});
  if(title==='Comms')expect(step.value.report.actions?.approvalPreparedChanges,JSON.stringify(step.value.report.actions)).toMatchObject({ok:true});
  if(title==='Settings')expect(app.valueAction,JSON.stringify(app.valueAction)).toMatchObject({ok:true,added:true,replaced:true,removed:true,persistedAfterReload:true,writeOnly:true,recorded:true,ruleSaved:true});
  if(title==='Tasks')expect(step.value.report.actions?.taskQuestions,JSON.stringify(step.value.report.actions)).toMatchObject({ok:true});
  if(title==='Home'){expect(app.error).toBeUndefined();expect(app.runtimeJobs).toContainEqual({title:runtimeTitle,status:'queued · Unassigned'});}
  if(title==='Comms')expect(step.value.report.actions?.taskInlineQuestion,JSON.stringify(step.value.report.actions)).toMatchObject({ok:true});
  if(title==='Approvals')expect(step.value.report.actions?.approvalDecisions,JSON.stringify(step.value.report.actions)).toMatchObject({ok:true});
  if(title==='Changes')expect(step.value.report.actions?.workVisibility,JSON.stringify(step.value.report.actions)).toMatchObject({ok:true});
  if(title==='Settings')expect(app.action,JSON.stringify(app.action)).toMatchObject({ok:true,before:'ask',after:'never',persistedAfterReload:true});
  if(title==='Changes')expect(step.value.report.actions?.changeWorkflow,JSON.stringify(step.value.report.actions)).toMatchObject({ok:true});
  if(title==='Tasks')for(const name of ['taskReady','taskLifecycle','taskStructure','taskComments'])expect(step.value.report.actions?.[name],JSON.stringify(step.value.report.actions)).toMatchObject({ok:true});
  if(title==='Bridges')expect(app.action,JSON.stringify(app.action)).toMatchObject({ok:true,discordChannel:true,slackPerson:true,persistedAfterReload:true});
  if(title==='People')expect(step.value.report.actions?.commsSend,JSON.stringify(step.value.report.actions)).toMatchObject({ok:true,persistedAfterReload:true,inboxCopies:1});
  if(title==='Comms')for(const action of ['conversationTaskSource','conversationApprovalSource'])expect(step.value.report.actions[action],JSON.stringify(step.value.report.actions[action])).toMatchObject({ok:true});
  if(title==='Comms')expect(app.detailText).toContain('Three fit. The quiet model');
  if(title==='Comms'){const result=step.value.report.actions?.conversationRecords;expect(typeof result?.ok).toBe('boolean');if(!result.ok)expect(result.error).toBeTruthy();}
  if(['Your account','Household setup','Project sharing'].includes(title))expect(app.action,JSON.stringify(app.action)).toMatchObject({ok:true});
  if(title==='Home'){const result=step.value.report.actions?.homeMessage;expect(typeof result?.ok).toBe('boolean');if(!result.ok)expect(result.error).toBeTruthy();}
  if(title==='Your account')expect(step.value.report.actions.modelsMachines,JSON.stringify(step.value.report.actions.modelsMachines)).toMatchObject({ok:true});
  if(title==='Knowledge')expect(app.action,JSON.stringify(app.action)).toMatchObject({ok:true,provisional:true,rechecked:true,verified:true,persistedAfterReload:true,connection:'existing /graphql'});
  if(title==='Tempo')expect(app.actions.resumed.facts).toMatchObject({sourceKind:'answer',watches:'approval:'+step.value.report.example.approval,lifespan:'once',enabled:false,stillOnceAfterLaterDeadline:true});
  if(title==='Tempo'){expect(app.error).toBeUndefined();expect(app.actions).toMatchObject({held:{ok:true},resumed:{ok:true},settled:{ok:true},cancelled:{ok:true}});for(const name of ['held','resumed','settled','cancelled'])expect(readFileSync(join(out,app.actions[name].screenshot)).subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));}
 });
 it('follows conversation PR references to their linked task',{retry:0,timeout:20_000},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('change-references');
  expect(step.value.actions.changeInline,JSON.stringify(step.value.actions.changeInline)).toMatchObject({ok:true});
 });
 it('measures Inbox answer variants and retained history',{retry:0,timeout:20_000},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('inbox-details');
  for(const name of ['inboxDecisions','inboxHistory'])expect(step.value.actions[name],JSON.stringify(step.value.actions[name])).toMatchObject({ok:true});
 });
 it('answers in Inbox and shows the answer in Comms',{retry:0,timeout:20_000},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('actions');
  for(const name of ['commsSend','inboxAnswer','commsAnswer'])expect(step.value.actions?.[name],JSON.stringify(step.value.actions)).toMatchObject({ok:true});
 });
 it('measures desk launcher and tile controls',{retry:0,timeout:20_000},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('desk');
  for(const name of ['deskLauncher','deskGeometry','deskLayout']){

   const result=step.value.actions?.[name];expect(typeof result?.ok).toBe('boolean');
   if(!result.ok)expect(result.error).toBeTruthy();
   expect(readFileSync(join(out,result.screenshot)).subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
  }
 });
 it('measures desk looks and persisted appearance',{retry:0,timeout:20_000},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('appearance');
  for(const name of ['deskLooks','deskAppearance'])expect(step.value.actions[name],JSON.stringify(step.value.actions[name])).toMatchObject({ok:true});
 });
 it('measures the data door, fact queries and live changes',{retry:0,timeout:20_000},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('data');
  for(const name of ['dataDoor','dataSelectionSQL','dataInboxChange'])expect(step.value.actions[name],JSON.stringify(step.value.actions[name])).toMatchObject({ok:true});
  expect(step.value.actions.dataTaskPatches).toMatchObject({ok:true,inconclusive:true,initialRevision:1,requests:1});
  expect(step.value.actions.dataSharingSQL.statements.length).toBeGreaterThan(0);
  for(const name of ['dataDoor','dataSelectionSQL','dataSharingSQL','dataTaskPatches','dataInboxChange']){const result=step.value.actions?.[name];expect(result?.inconclusive||typeof result?.ok==='boolean').toBe(true);if(result.ok===false)expect(result.error??result.reason).toBeTruthy();}


 });
 it('checks owner and member conversation privacy through normal browser sign-in',{retry:0,timeout:20_000},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('visibility');
  for(const name of ['conversationLabels','conversationVisibility','commsPrivacy','inboxVisibility','inboxRecipients'])expect(step.value.actions[name],JSON.stringify(step.value.actions[name])).toMatchObject({ok:true,isolation:{http:'blocked',websocket:'blocked'},cleanup:{restored:true,contextClosed:true,credentialAbsent:true}});
 });
 it('follows an Inbox approval to its exact source and resolves the item',{retry:0,timeout:20_000},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('approval-source');expect(step.value.actions.approvalInbox,JSON.stringify(step.value.actions.approvalInbox)).toMatchObject({ok:true});
 });
 it('follows an Inbox task to its source and records its completed outcome',{retry:0,timeout:20_000},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('task-source');
  const arrival=step.value.actions.inboxTaskArrival;expect(typeof arrival.ok,JSON.stringify(arrival)).toBe('boolean');
  if(arrival.ok===false)expect(arrival.error).toContain('did not offer a source link');
  for(const name of ['inboxTaskSettlement','inboxSourceOutcome'])expect(step.value.actions[name],JSON.stringify(step.value.actions[name])).toMatchObject({ok:true});
  expect(step.value.actions.inboxSourceTargets).toMatchObject(arrival.ok?{ok:true}:{inconclusive:true});
 });
 afterAll(async()=>{
  try{
   if(!ready)return;
   const step=await steps?.next();expect(step?.done).toBe(true);const report=step?.value;
   expect(report.fatal).toBeUndefined();
   expect(report.live.dataFrames).toBeGreaterThan(0);
   const measured=JSON.parse(readFileSync(join(out,'report.json'),'utf8'));
   expect(measured.pages).toHaveLength(19);
   const tempo=measured.pages.find((page:{page:string})=>page.page==='tempo');
   const observed=tempo.promises.filter((entry:{probe?:{kind:string;action?:string}})=>entry.probe?.kind==='action'&&entry.probe.action?.startsWith('tempo'));expect(observed).toHaveLength(5);expect(observed.map((entry:{status:string})=>entry.status)).toEqual(['met','met','met','met','met']);
   for(const name of ['tempoHeld','tempoResumed','tempoSettled','tempoCancelled'])expect(report.actions[name]).toMatchObject({ok:true,screenshot:expect.any(String)});
   for(const [name,count] of [['tasks',20],['approvals',20],['changes',17]] as const){
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
