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
  expect(report.signin.ok).toBe(true);expect(report.example.members).toEqual(['alex','robin']);
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
  if(title==='Comms')expect(app.detailText).toContain('Three fit. The quiet model');
  if(title==='Knowledge')expect(app.action,JSON.stringify(app.action)).toMatchObject({ok:true,provisional:true,rechecked:true,verified:true,persistedAfterReload:true,connection:'existing /graphql'});
 });
 it('sends and answers through the real Comms and Inbox controls',{retry:0,timeout:20_000},async()=>{
  const step=await steps.next();expect(step.value.phase,step.value.fatal).toBe('actions');
  for(const name of ['commsSend','inboxAnswer','commsAnswer'])expect(step.value.actions?.[name],JSON.stringify(step.value.actions)).toMatchObject({ok:true});
 });
 afterAll(async()=>{
  try{
   if(!ready)return;
   const step=await steps?.next();expect(step?.done).toBe(true);const report=step?.value;
   expect(report.fatal).toBeUndefined();
   expect(report.live.dataFrames).toBeGreaterThan(0);
   const measured=JSON.parse(readFileSync(join(out,'report.json'),'utf8'));
   expect(measured.pages).toHaveLength(19);
   expect(measured.counts['not checkable yet']).toBeGreaterThan(0);
   expect(measured.pages.every((page:{promises:unknown[]})=>page.promises.length>0)).toBe(true);
   expect(JSON.stringify(report)).not.toMatch(/AGE-SECRET-KEY-|\/login\/[a-zA-Z0-9_-]{24,}/);
  }finally{await steps?.return();if(out&&!process.env.LOOM_TEST_SHOTS)rmSync(out,{recursive:true,force:true});}
 });
});
