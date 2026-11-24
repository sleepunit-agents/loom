import assert from 'node:assert/strict';
import {exampleHome} from '../dist/example-home.js';
import {startSharedHome} from '../dist/shared-startup.js';
import {FakeClock} from '../dist/core/clock.js';
import {QUEUE_DEADLINE_MS} from '../dist/runtime/jobs.js';
import {SILENCE_MS} from '../dist/runtime/silence.js';
import {httpWorkerControl,reportWorkerHealth,reportWorkerAccountLogins} from '../dist/runtime/worker-http.js';

export async function machineSignInWarnings({browser,home}){
 const example=await exampleHome(home);
 assert(example.fictional);
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
  await page.goto(app.url+'/p/machines');
  const {box,account,job}=example.runtime;
  const machine=page.getByRole('heading').filter({has:page.getByRole('button',{name:'Example workshop',exact:true})});
  await machine.waitFor();
  const warning=machine.getByRole('img',{name:'A sign-in needs attention'});
  const worker={url:app.url,token:app.writes.run(()=>app.services.signin.issue({kind:'runner',box,label:'Example workshop'})).value.token,facts:['cpu:example'],signal:AbortSignal.timeout(60000)};
  const login={account,harness:'claude',place:'containers',state:'signed-in'};
  await reportWorkerHealth(worker);
  await reportWorkerAccountLogins(worker,[{...login,expiresAt:new Date(clock.now()+3*86400000+1000).toISOString()}]);
  assert.equal(await warning.count(),0);
  clock.advance(1000);
  await warning.waitFor();
  clock.advance(SILENCE_MS);
  await warning.waitFor({state:'hidden'});
  await reportWorkerHealth(worker);
  await warning.waitFor();
  await reportWorkerAccountLogins(worker,[{...login,state:'signed-out'}]);
  assert.equal(await httpWorkerControl(worker).next(),undefined);
  await page.getByLabel('Jobs for').selectOption('moss');
  const jobRow=page.getByRole('button').filter({has:page.getByText(job.title,{exact:true})});
  await jobRow.waitFor();
  const jobWarning=jobRow.getByRole('img',{name:'A machine needed sign-in on the last placement check'});
  assert.equal(await jobWarning.count(),0);
  // Only the fixture's age is seeded. The coordinator's normal sweep decides the end and the reason.
  app.writes.run(()=>app.services.comms.db.$client.prepare('UPDATE jobs SET queued_at=? WHERE id=? AND state=\'queued\'')
   .run(new Date(clock.now()-QUEUE_DEADLINE_MS).toISOString(),job.id));
  clock.advance(30_000);
  await jobWarning.waitFor();
  assert.match(await jobRow.innerText(),/Failed/);
  await reportWorkerAccountLogins(worker,[login]);
  await warning.waitFor({state:'hidden'});
  await page.reload();
  await page.getByLabel('Jobs for').selectOption('moss');
  await jobWarning.waitFor();
  assert.equal(await warning.count(),0);
  return {ok:true,reason:'The machine warning appeared at the three-day boundary, disappeared while offline and cleared on renewal. A real worker could not claim a signed-out job. The deadline ended it and its historical warning survived renewal and reload.'};
 }finally{try{await context?.close();}finally{await app.close();}}
}
