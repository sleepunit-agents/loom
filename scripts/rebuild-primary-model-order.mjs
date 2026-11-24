import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {exampleHome} from '../dist/example-home.js';
import exampleAdapters from '../dist/example-home-adapters.js';
import {exampleModelRoles} from '../dist/example-runtime.js';
import {startSharedHome} from '../dist/shared-startup.js';
import {FakeClock} from '../dist/core/clock.js';
import {httpWorkerControl} from '../dist/runtime/worker-http.js';

const first=exampleModelRoles[0];
const second={...first,model:'example-blue'};
const unavailable={...first,model:'example-offline',provider:'example-unconfigured'};
export default function adapters(inputs){
 return {...exampleAdapters(inputs),modelRoles:()=>[first,second,unavailable]};
}

export async function primaryModelOrder({browser,parent}){
 for(const {order,expected} of [
  {order:[second,first,unavailable],expected:second},
  {order:[unavailable,first,second],expected:first},
 ]){
  const home=join(parent,'model-order-'+expected.model),example=await exampleHome(home);
  assert(example.fictional);
  const program=JSON.parse(await readFile(join(home,'program.json'),'utf8'));
  await writeFile(program.adapters,'export {default} from '+JSON.stringify(import.meta.url)+';\n');
  const app=await startSharedHome({home,port:0,clock:new FakeClock(Date.parse(example.createdAt)),stdout(){}});
  let context;
  try{
   context=await browser.newContext({reducedMotion:'reduce',serviceWorkers:'block'});
   await context.route('**/*',route=>new URL(route.request().url()).origin===app.url?route.continue():route.abort());
   await context.routeWebSocket(url=>url.origin!==app.url.replace(/^http/,'ws'),route=>route.close());
   const page=await context.newPage();
   page.setDefaultTimeout(10000);
   await page.goto(app.signinLink('alex'));
   await page.getByRole('button',{name:'Sign in',exact:true}).click();
   await page.goto(app.url+'/p/subscriptions');
   const list=agent=>page.locator('article').filter({has:page.getByRole('heading',{name:agent,exact:true})}).getByRole('listitem');
   await list('moss').filter({hasText:first.model+' · Primary'}).waitFor();
   app.writes.run(()=>app.services.setup.models({agent:'moss',models:order.map(role=>role.model)}));
   await list('moss').filter({hasText:order[0].model+' · Primary'}).waitFor();
   assert.deepEqual(await list('moss').allTextContents(),order.map((role,i)=>role.model+(i===0?' · Primary':'')));
   assert.deepEqual(await list('fern').allTextContents(),[first.model+' · Primary']);
   const {box,job}=example.runtime;
   const token=app.writes.run(()=>app.services.signin.issue({kind:'runner',box,label:'Fictional model order check'})).value.token;
   const worker=httpWorkerControl({url:app.url,token,slots:12,signal:AbortSignal.timeout(10000)});
   let assignment;
   do{assignment=await worker.next();assert(assignment);}while(assignment.id!==job.id);
   assert.equal(assignment.model,expected.model);
   assert.equal(assignment.harness,expected.harness);
   assert.equal(assignment.account,example.runtime.account);
  }finally{try{await context?.close();}finally{await app.close();}}
 }
 return {ok:true,reason:'The open desktop updated Moss’s primary and ordered alternatives while Fern kept its own primary. A worker claimed the example conversation on the preferred model with a configured subscription, then used the next listed model in a second household where the primary had no subscription.'};
}
