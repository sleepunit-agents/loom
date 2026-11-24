import assert from 'node:assert/strict';
import {browserRead} from './rebuild-conversation-visibility.mjs';
import {exampleHome} from '../dist/example-home.js';
import {startSharedHome} from '../dist/shared-startup.js';
import {FakeClock} from '../dist/core/clock.js';
import {Jobs,QUEUE_DEADLINE_MS} from '../dist/runtime/jobs.js';
import {SILENCE_MS} from '../dist/runtime/silence.js';
import {httpWorkerControl,reportWorkerHealth,reportWorkerAccountLogins} from '../dist/runtime/worker-http.js';

export async function machineSignInWarnings({browser,home}){
 const example=await exampleHome(home);
 assert(example.fictional);
 const clock=new FakeClock(Date.parse(example.createdAt));
 const app=await startSharedHome({home,clock,port:0,stdout(){}});
 let context,memberContext;
 try{
  context=await browser.newContext({reducedMotion:'reduce',serviceWorkers:'block'});
  await context.route('**/*',route=>new URL(route.request().url()).origin===app.url?route.continue():route.abort());
  let offline=false;
  const sockets=new Set();
  await context.routeWebSocket('**/*',socket=>{
   if(offline || new URL(socket.url()).origin!==app.url.replace(/^http/,'ws'))return socket.close();
   const server=socket.connectToServer();
   sockets.add(socket);
   socket.onClose(()=>{sockets.delete(socket);server.close();});
   server.onClose(()=>{sockets.delete(socket);socket.close();});
  });
  const page=await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(app.signinLink('alex'));
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.locator('.next-shell').waitFor();
  await page.goto(app.url+'/p/machines');
  const {box,account,job,publicJob}=example.runtime;
  const machine=page.getByRole('heading').filter({has:page.getByRole('button',{name:'Example workshop',exact:true})});
  await machine.waitFor();
  const warning=machine.getByRole('img',{name:'A sign-in needs attention'});
  const worker={url:app.url,token:app.writes.run(()=>app.services.signin.issue({kind:'runner',box,label:'Example workshop'})).value.token,facts:['cpu:example'],signal:AbortSignal.timeout(60000)};
  const login={account,harness:'claude',place:'containers',state:'signed-in'};
  await reportWorkerHealth(worker);
  await reportWorkerAccountLogins(worker,[{...login,state:'signed-out'}]);
  await warning.waitFor();
  await reportWorkerAccountLogins(worker,[{...login,expiresAt:new Date(clock.now()+3*86400000+1000).toISOString()}]);
  await warning.waitFor({state:'hidden'});
  clock.advance(1000);
  await warning.waitFor();
  clock.advance(SILENCE_MS);
  await warning.waitFor({state:'hidden'});
  await reportWorkerHealth(worker);
  await warning.waitFor();
  await reportWorkerAccountLogins(worker,[login]);
  await warning.waitFor({state:'hidden'});
  assert(sockets.size>0);
  offline=true;
  for(const socket of sockets)await socket.close({code:1012,reason:'Fixture disconnect'});
  await reportWorkerAccountLogins(worker,[{...login,state:'signed-out'}]);
  offline=false;
  await warning.waitFor();
  assert.equal(await httpWorkerControl(worker).next(),undefined);
  const readDiagnosis=async()=> (await browserRead(page,'{jobHistory(agent:"moss",id:'+JSON.stringify(job.id)+'){ signInBlocked }}')).jobHistory;
  assert.deepEqual(await readDiagnosis(),[{signInBlocked:false}]);
  const otherEnd=app.writes.run(()=>new Jobs(app.services.comms.db,()=>new Date(clock.now()).toISOString())
   .unplaceable(publicJob.id,'The example assignment ended.')).value;
  assert.equal(otherEnd.state,'failed');
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
  const unrelated=page.getByRole('button').filter({has:page.getByText(publicJob.title,{exact:true})});
  await unrelated.waitFor();
  assert.match(await unrelated.innerText(),/Failed/);
  assert.equal(await unrelated.getByRole('img',{name:'A machine needed sign-in on the last placement check'}).count(),0);
  assert.deepEqual(await readDiagnosis(),[{signInBlocked:true}]);
  await reportWorkerAccountLogins(worker,[login]);
  await warning.waitFor({state:'hidden'});
  await page.reload();
  await page.getByLabel('Jobs for').selectOption('moss');
  await jobWarning.waitFor();
  assert.equal(await warning.count(),0);
  // A member can own a worker without owning the subscription reported there.
  app.writes.run(()=>app.services.comms.db.$client.prepare("UPDATE boxes SET owner='robin' WHERE id=?").run(box));
  await reportWorkerHealth(worker);
  await reportWorkerAccountLogins(worker,[{...login,state:'signed-out'}]);
  const other=page.getByRole('region',{name:'Other visible machines'}).getByRole('heading',{name:/Example workshop/});
  await other.getByRole('img',{name:'A sign-in needs attention'}).waitFor();
  memberContext=await browser.newContext({reducedMotion:'reduce',serviceWorkers:'block'});
  await memberContext.route('**/*',route=>new URL(route.request().url()).origin===app.url?route.continue():route.abort());
  await memberContext.routeWebSocket(url=>url.origin!==app.url.replace(/^http/,'ws'),socket=>socket.close());
  const member=await memberContext.newPage();
  member.setDefaultTimeout(10000);
  await member.goto(app.signinLink('robin'));
  await member.getByRole('button',{name:'Sign in',exact:true}).click();
  await member.locator('.next-shell').waitFor();
  await member.goto(app.url+'/p/machines');
  await member.getByRole('button',{name:'Example workshop',exact:true}).waitFor();
  assert.equal(await member.getByRole('img',{name:'A sign-in needs attention'}).count(),0);
  return {ok:true,reason:'The machine warning appeared at the three-day boundary, cleared during worker silence, and returned after the browser reconnected to a signed-out worker. Only the member with account detail saw it on a shared machine. The job warning appeared after the missed deadline and survived renewal and reload.'};
 }finally{try{await memberContext?.close();await context?.close();}finally{await app.close();}}
}
