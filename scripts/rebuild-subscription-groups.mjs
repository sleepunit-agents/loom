import {subscriptionLoginRows} from './rebuild-subscription-login-rows.mjs';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {exampleHome} from '../dist/example-home.js';
import exampleAdapters from '../dist/example-home-adapters.js';
import {exampleModelRoles} from '../dist/example-runtime.js';
import {startSharedHome} from '../dist/shared-startup.js';
import {FakeClock} from '../dist/core/clock.js';
import {readWorkerAccountBasis,reportWorkerAccountUsage} from '../dist/runtime/worker-http.js';

const otherProvider='garden-service';
export default function adapters(inputs){
 return {...exampleAdapters(inputs),modelRoles:()=>[...exampleModelRoles,
  {provider:otherProvider,model:'garden-model',series:'garden',harness:'codex'}]};
}

export async function subscriptionGroups({browser,home}){
 const example=await exampleHome(home);
 assert(example.fictional);
 const config=join(home,'program.json');
 const program=JSON.parse(await readFile(config,'utf8'));
 await writeFile(program.adapters,'export {default} from '+JSON.stringify(import.meta.url)+';\n');
 const clock=new FakeClock(Date.parse(example.createdAt));
 const app=await startSharedHome({home,clock,port:0,stdout(){}});
 let context;
 try{
  context=await browser.newContext({reducedMotion:'reduce',serviceWorkers:'block'});
  await context.route('**/*',route=>new URL(route.request().url()).origin===app.url?route.continue():route.abort());
  await context.routeWebSocket(url=>url.origin!==app.url.replace(/^http/,'ws'),route=>route.close());
  const page=await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(app.signinLink('alex'));
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.locator('.next-shell').waitFor();
  const box=example.runtime.box;
  const token=app.writes.run(()=>app.services.signin.issue({kind:'runner',box,label:'Fictional usage observer'})).value.token;
  const worker={url:app.url,token,signal:AbortSignal.timeout(60000)};
  async function command(name,input){
   const response=await page.request.post(app.url+'/api/runtime/'+name,{headers:{origin:app.url},data:{id:crypto.randomUUID(),input}});
   const result=await response.json();
   assert.equal(result.ok,true,name);
   return result.value;
  }
  async function report(account,provider,fraction){
   clock.advance(1000);
   const identity={owner:'alex',provider,account};
   const {basis}=await readWorkerAccountBasis(worker,identity);
   const windows=[{name:'week',usage:fraction,durationMs:604800000,readAt:new Date(clock.now()).toISOString(),resetsAt:new Date(clock.now()+604800000).toISOString()}];
   assert.equal((await reportWorkerAccountUsage(worker,{...identity,basis,windows})).recorded,true);
  }
  const provider=exampleModelRoles[0].provider;
  const spare=await command('accountCreate',{provider,label:'Workshop spare'});
  const garden=await command('accountCreate',{provider:otherProvider,label:'Garden subscription'});
  for(const {id} of [spare,garden])await command('accountSignedIn',{account:id,box});
  await report(spare.id,provider,.65);
  await report(garden.id,otherProvider,.9);
  await page.goto(app.url+'/p/subscriptions');
  const list=page.getByRole('region',{name:'Subscriptions',exact:true});
  const summary=(root,text)=>root.locator('summary').filter({hasText:text});
  const group=name=>summary(list,new RegExp('^'+name+' ·')).locator('..');
  const first=group(provider),second=group(otherProvider);
  await summary(first,provider+' · 2 · getting full').waitFor();
  await summary(second,otherProvider+' · 1 · almost full').waitFor();
  await summary(first,'Example model subscription · alex · plenty').waitFor();
  const spareCard=summary(first,'Workshop spare · alex · getting full');
  await spareCard.waitFor();
  await summary(second,'Garden subscription · alex · almost full').waitFor();
  assert.equal(await summary(first,'Garden subscription').count(),0);
  assert.equal(await summary(second,'Workshop spare').count(),0);
  await summary(first,provider+' · 2 · getting full').click();
  await spareCard.waitFor({state:'hidden'});
  await report(spare.id,provider,.12);
  await summary(first,provider+' · 2 · plenty').click();
  await summary(first,'Workshop spare · alex · plenty').waitFor();
  await summary(second,'Garden subscription · alex · almost full').waitFor();
  const groups={ok:true,reason:'Three subscriptions appeared under the two corresponding services. Each card showed its own usage level, and a collapsed service updated its fullest level after a worker reading while the other service retained its level.'};
  try{
   const signins=await subscriptionLoginRows({page,account:example.runtime.account,worker,clock});
   return {subscriptionGroups:groups,subscriptionLoginRows:signins};
  }catch(error){return {subscriptionGroups:groups,subscriptionLoginRows:{ok:false,error:String(error)}};}

 }finally{try{await context?.close();}finally{await app.close();}}
}
