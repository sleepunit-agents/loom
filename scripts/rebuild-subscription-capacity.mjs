import assert from 'node:assert/strict';
import {FakeClock} from '../dist/core/clock.js';
import {exampleHome} from '../dist/example-home.js';
import {startSharedHome} from '../dist/shared-startup.js';
import {httpWorkerControl,readWorkerAccountBasis,reportWorkerAccountUsage} from '../dist/runtime/worker-http.js';

export async function subscriptionCapacity({browser,home}) {
 const example=await exampleHome(home);
 const clock=new FakeClock(Date.parse(example.createdAt));
 const app=await startSharedHome({home,clock,port:0,stdout(){}});
 let context;
 try {
  context=await browser.newContext({viewport:{width:1600,height:1000},reducedMotion:'reduce',serviceWorkers:'block'});
  await context.route('**/*',route=>new URL(route.request().url()).origin===app.url?route.continue():route.abort());
  await context.routeWebSocket(url=>url.origin!==app.url.replace(/^http/,'ws'),route=>route.close());
  context.setDefaultTimeout(10000);
  const desk=await context.newPage();
  await desk.goto(app.signinLink('alex'));
  await desk.getByRole('button',{name:'Sign in',exact:true}).click();
  await desk.locator('.next-shell').waitFor();
  const {box,account}=example.runtime;
  const token=app.writes.run(()=>app.services.signin.issue({kind:'runner',box,label:'Fixture capacity walkthrough'})).value.token;
  const worker={url:app.url,token,signal:AbortSignal.timeout(60000)};
  const assigned=await httpWorkerControl({...worker,facts:['cpu:example'],slots:1}).next();
  assert.equal(assigned?.account,account);
  const job=app.services.comms.db.$client.prepare('SELECT title FROM jobs WHERE id=? AND agent=?').get(assigned.id,assigned.agent);
  assert.ok(job);
  const provider='example-provider';
  async function command(name,input) {
   const response=await desk.request.post(app.url+'/api/runtime/'+name,{headers:{origin:app.url},maxRedirects:0,data:{id:'fixture-capacity-'+name,input}});
   const result=await response.json();
   assert.equal(result.ok,true);
   return result.value;
  }
  const spare=await command('accountCreate',{label:'Garden spare',provider});
  await command('accountSignedIn',{account:spare.id,box});
  async function report(account,fiveHour,week) {
   clock.advance(1000);
   const identity={account,provider,owner:'alex'};
   const {basis}=await readWorkerAccountBasis(worker,identity);
   const windows=[['five-hour',fiveHour,5*3600000],['week',week,7*86400000]].map(([name,usage,durationMs])=>({
    name,usage,durationMs,readAt:new Date(clock.now()).toISOString(),resetsAt:new Date(clock.now()+durationMs/2).toISOString()
   }));
   const result=await reportWorkerAccountUsage(worker,{...identity,basis,windows});
   assert.equal(result.recorded,true);
  }
  await report(spare.id,.1,.2);
  await desk.goto(app.url+'/p/tempo');
  const day=desk.getByRole('region',{name:'Current subscriptions'});
  await day.getByText('Garden spare · plenty',{exact:true}).waitFor();
  const jobs=await context.newPage();
  await jobs.goto(app.url+'/p/machines');
  await jobs.getByLabel('Jobs for').selectOption(assigned.agent);
  await jobs.getByRole('group',{name:assigned.agent+' jobs now'}).getByRole('button').filter({has:jobs.getByText(job.title,{exact:true})}).click();
  const detail=jobs.getByRole('region',{name:'Job details'});
  const ticker=desk.locator('.loom-tick__line:not([aria-hidden])');
  const link=ticker.getByRole('link',{name:/Example model subscription/});
  for(const [fiveHour,week,level] of [[.65,.1,'getting full'],[.2,.9,'almost full'],[.15,.2,'plenty']]) {
   await report(account,fiveHour,week);
   const label='Example model subscription · '+level;
   for(const surface of [day,detail]){
    const mark=surface.getByText(label,{exact:true});
    await mark.waitFor();
    assert.equal(await mark.getAttribute('data-capacity'),level);
    assert.equal(await mark.evaluate(el=>getComputedStyle(el,'::after').display),'inline-block');
   }
   await day.getByText('Garden spare · plenty',{exact:true}).waitFor();
   assert.equal(await detail.getByText(/Garden spare/).count(),0);
   if(level==='plenty')await link.waitFor({state:'hidden'});
   else {
    await link.filter({hasText:level}).waitFor();
    assert.equal(await link.getAttribute('data-capacity'),level);
   }
   assert.equal(await ticker.getByRole('link',{name:/Garden spare/}).count(),0);
  }
  return {ok:true,reason:'Two subscriptions shared a provider. A real worker claimed the example job and reported both quota windows. Tempo and the job detail followed the fullest window while the ticker showed only warning levels and cleared on recovery.'};
 } finally {await context?.close();await app.close();}
}
