/** One test per app keeps browser evidence within the normal 20-second budget. */
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {walkthroughSteps} from '../../scripts/rebuild-walkthrough.mjs';
const titles=['Tasks','Approvals','Project sharing','Changes','Inbox','Tempo','Home','Projects','Activity','Comms','Agents','People','Knowledge','Bridges','Settings','Household setup','Your account'];
describe.skipIf(!process.env.LOOM_TEST_CHROME)('built program walkthrough',()=>{
 let steps:ReturnType<typeof walkthroughSteps>,out:string,ready=false;
 beforeAll(async()=>{
  out=process.env.LOOM_TEST_SHOTS??mkdtempSync(join(tmpdir(),'loom-walkthrough-proof-'));
  steps=walkthroughSteps(out);const step=await steps.next();
  expect(step.value.phase,step.value.fatal).toBe('ready');ready=true;const report=step.value.report;
  expect(report.signin.ok).toBe(true);expect(report.signin.personBrowser).toBe(true);expect(report.example.members).toEqual(['alex','robin']);
  expect(report.isolation).toMatchObject({http:'blocked',websocket:'blocked'});
  expect(report.isolation.consoleErrors.join(' ')).toContain('Walkthrough console capture probe');
  expect(report.inventory).toEqual(titles);
 });
 for(const title of titles)it(`collects ${title} from the real launcher`,{retry:0,timeout:20_000},async()=>{
  const step=await steps.next();expect(step.value.phase).toBe('app');const app=step.value.row;
  expect(app.title).toBe(title);expect(app.opened||!!app.error).toBe(true);
  expect(app.text.trim().length).toBeGreaterThan(0);
  expect(Array.isArray(app.consoleErrors)).toBe(true);expect(Array.isArray(app.live.frames)).toBe(true);
  expect(readFileSync(join(out,app.screenshot)).subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
  if(title==='Approvals')expect(step.value.report.actions?.approvalRulesAndExpiry,JSON.stringify(step.value.report.actions)).toMatchObject({ok:true});
  if(title==='Comms')expect(step.value.report.actions?.approvalPreparedChanges,JSON.stringify(step.value.report.actions)).toMatchObject({ok:true});
  if(title==='Inbox')for(const name of ['inboxDecisions','inboxHistory']){const result=step.value.report.actions?.[name];expect(typeof result?.ok).toBe('boolean');if(!result.ok)expect(result.error).toBeTruthy();}
  if(title==='Inbox')expect(step.value.report.actions?.taskQuestions,JSON.stringify(step.value.report.actions)).toMatchObject({ok:true});
  if(title==='Comms')expect(step.value.report.actions?.taskInlineQuestion,JSON.stringify(step.value.report.actions)).toMatchObject({ok:true});
  if(title==='Approvals')expect(step.value.report.actions?.approvalDecisions,JSON.stringify(step.value.report.actions)).toMatchObject({ok:true});
  if(title==='Changes')expect(step.value.report.actions?.workVisibility,JSON.stringify(step.value.report.actions)).toMatchObject({ok:true});
  if(title==='Settings')expect(app.action,JSON.stringify(app.action)).toMatchObject({ok:true,before:'ask',after:'never',persistedAfterReload:true});
  if(title==='Changes')expect(step.value.report.actions?.changeWorkflow,JSON.stringify(step.value.report.actions)).toMatchObject({ok:true});
  if(title==='Comms')expect(step.value.report.actions?.changeInline,JSON.stringify(step.value.report.actions)).toMatchObject({ok:true});
  if(title==='Tasks')for(const name of ['taskReady','taskLifecycle','taskStructure','taskComments'])expect(step.value.report.actions?.[name],JSON.stringify(step.value.report.actions)).toMatchObject({ok:true});
  if(title==='Bridges')expect(app.action,JSON.stringify(app.action)).toMatchObject({ok:true,discordChannel:true,slackPerson:true,persistedAfterReload:true});
  if(title==='Comms')expect(app.detailText).toContain('Three fit. The quiet model');
  if(['Your account','Household setup','Project sharing'].includes(title))expect(app.action,JSON.stringify(app.action)).toMatchObject({ok:true});
  if(title==='Knowledge')expect(app.action,JSON.stringify(app.action)).toMatchObject({ok:true,provisional:true,rechecked:true,verified:true,persistedAfterReload:true,connection:'existing /graphql'});
  if(title==='Tempo'){expect(app.error).toBeUndefined();expect(app.actions).toMatchObject({held:{ok:true},resumed:{ok:true},settled:{ok:true},cancelled:{ok:true}});for(const name of ['held','resumed','settled','cancelled'])expect(readFileSync(join(out,app.actions[name].screenshot)).subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));}
 });
 it('sends and answers through the real Comms and Inbox controls',{retry:0,timeout:20_000},async()=>{
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
 it('measures the data door, fact queries and live changes',{retry:0,timeout:20_000},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('data');
  for(const name of ['dataDoor','dataSelectionSQL','dataInboxChange'])expect(step.value.actions[name],JSON.stringify(step.value.actions[name])).toMatchObject({ok:true});
  expect(step.value.actions.dataTaskPatches).toMatchObject({ok:true,inconclusive:true,initialRevision:1,requests:1});
  expect(step.value.actions.dataSharingSQL.statements.length).toBeGreaterThan(0);
  for(const name of ['dataDoor','dataSelectionSQL','dataSharingSQL','dataTaskPatches','dataInboxChange']){const result=step.value.actions?.[name];expect(result?.inconclusive||typeof result?.ok==='boolean').toBe(true);if(result.ok===false)expect(result.error??result.reason).toBeTruthy();}

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
   const observed=tempo.promises.filter((entry:{probe?:{kind:string;action?:string}})=>entry.probe?.kind==='action'&&entry.probe.action?.startsWith('tempo'));expect(observed).toHaveLength(4);expect(observed.map((entry:{status:string})=>entry.status)).toEqual(['met','met','met','met']);
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
  }finally{await steps?.return();if(out&&!process.env.LOOM_TEST_SHOTS)rmSync(out,{recursive:true,force:true});}
 });
});
