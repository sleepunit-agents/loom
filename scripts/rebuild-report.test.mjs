import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {it,expect} from 'vitest';
import {evaluate,summarizePages,rebuildReport} from './rebuild-report.mjs';
const promise={probe:{kind:'ui',app:'Tasks',contains:['Claim','Close']}};
it('never counts an open tile or a claim button as proof that its actions work',()=>{
 expect(evaluate({promise:'Claiming changes task state.'},{apps:[]} ).status).toBe('not checkable yet');
 expect(evaluate(promise,{apps:[{title:'Tasks',opened:true,text:'Claim'}]}).status).toBe('not met');
 expect(evaluate(promise,{apps:[{title:'Tasks',opened:true,text:'Claim Close'}]}).status).toBe('met');
});
it('does not turn missing apps or failed sign-in into a pass',()=>{
 expect(evaluate(promise,{apps:[]}).status).toBe('not met');
 expect(evaluate(promise,{apps:[],fatal:'Sign-in failed'}).status).toBe('not checkable yet');
 expect(evaluate({probe:{kind:'signin'}},{signin:{ok:false}}).status).toBe('not met');
});
it('requires actual GraphQL data and no GraphQL errors for the live observation',()=>{
 const promise={probe:{kind:'live'}};
 expect(evaluate(promise,{live:{dataFrames:0,errors:[]}}).status).toBe('not met');
 expect(evaluate(promise,{live:{dataFrames:1,errors:['bad query']}}).status).toBe('not met');
 expect(evaluate(promise,{live:{dataFrames:1,errors:[]}}).status).toBe('met');
});
it('counts action evidence only when the browser observed the persisted outcome',()=>{
 const promise={probe:{kind:'action',action:'inboxAnswer'}};
 expect(evaluate(promise,{apps:[{title:'Inbox',opened:true,text:'Yes No'}]}).status).toBe('not checkable yet');
 expect(evaluate(promise,{actions:{inboxAnswer:{ok:false,answeredBy:'alex',agentAnswerCopies:0}}}).status).toBe('not met');
 expect(evaluate(promise,{actions:{inboxAnswer:{ok:true,screenshot:'action-inbox-answer.png'}}})).toMatchObject({status:'met',evidence:'action-inbox-answer.png'});
 expect(evaluate(promise,{fatal:'Startup failed'})).toMatchObject({status:'not checkable yet',reason:'Startup failed'});
});

it('summarizes each page without treating untested promises as passing',()=>{
 const page=(name,statuses)=>({page:name,title:name,ownerTask:'t-example',promises:statuses.map(status=>({status}))});
 expect(summarizePages([
  page('passed',['met','met']),
  page('unknown',['met','not checkable yet']),
  page('failed',['not met','not checkable yet']),
  page('unmeasured',['not checkable yet']),
 ])).toEqual([
  {page:'passed',title:'passed',ownerTask:'t-example',status:'met',counts:{met:2,'not met':0,'not checkable yet':0}},
  {page:'unknown',title:'unknown',ownerTask:'t-example',status:'not checkable yet',counts:{met:1,'not met':0,'not checkable yet':1}},
  {page:'failed',title:'failed',ownerTask:'t-example',status:'not met',counts:{met:0,'not met':1,'not checkable yet':1}},
  {page:'unmeasured',title:'unmeasured',ownerTask:'t-example',status:'not checkable yet',counts:{met:0,'not met':0,'not checkable yet':1}},
 ]);
});

it('reports a measured app action without counting a visible control as an outcome',()=>{
 const promise={probe:{kind:'action',app:'Knowledge'}};
 expect(evaluate(promise,{apps:[{title:'Knowledge',opened:true,text:'Still true'}]}).status).toBe('not checkable yet');
 expect(evaluate(promise,{apps:[{title:'Knowledge',action:{ok:false,error:'Fresh words did not survive reload',screenshot:'failed.png'}}]})).toMatchObject({status:'not met',reason:'Fresh words did not survive reload',evidence:'failed.png'});
 expect(evaluate(promise,{apps:[{title:'Knowledge',action:{ok:true,screenshot:'verified.png'}}]})).toMatchObject({status:'met',evidence:'verified.png'});
 expect(evaluate(promise,{apps:[{title:'Other app',action:{ok:true}}]}).status).toBe('not checkable yet');
});

it('keeps the measured revision and every page count in both regenerated reports',()=>{
 const out=mkdtempSync(join(tmpdir(),'rebuild-report-test-'));
 const source={commit:'a'.repeat(40),ref:'refs/pull/123/merge',repository:'example/loom',run:'123',attempt:'2'};
 try{
  const report=rebuildReport({source,example:{gaps:[]},apps:[],signin:{ok:false},live:{dataFrames:0,errors:[]}},out);
  const json=JSON.parse(readFileSync(join(out,'report.json'),'utf8')),md=readFileSync(join(out,'report.md'),'utf8');
  expect(json.source).toEqual(source);expect(md).toContain('Tested commit: '+source.commit);expect(md).toContain('Attempt: 2');
  expect(report.summary).toHaveLength(19);
  expect(report.summary.map(p=>p.page).sort()).toEqual(report.pages.map(p=>p.page).sort());
  for(const status of ['met','not met','not checkable yet'])expect(report.summary.reduce((sum,page)=>sum+page.counts[status],0)).toBe(report.counts[status]);
  for(const page of report.summary)expect(md).toContain('](#page-'+page.page+')');
 }finally{rmSync(out,{recursive:true,force:true});}
});
it('requires persisted Account Household and Sharing action evidence from their checked-in checklists',()=>{
 for(const [file,app]of [['signing-in','Your account'],['people','Household setup'],['people','Project sharing']]){
  const checklist=JSON.parse(readFileSync(new URL('../docs/rebuild-checklists/'+file+'.json',import.meta.url),'utf8'));
  const promise=checklist.promises.find(row=>row.probe?.kind==='action'&&row.probe.app===app);
  expect(promise).toBeDefined();
  expect(evaluate(promise,{apps:[{title:app,opened:true}]}).status).toBe('not checkable yet');
  expect(evaluate(promise,{apps:[{title:app,action:{ok:false,error:'Fixture failed'}}]}).status).toBe('not met');
  expect(evaluate(promise,{apps:[{title:app,action:{ok:true,screenshot:'proof.png'}}]}).status).toBe('met');
 }
});
