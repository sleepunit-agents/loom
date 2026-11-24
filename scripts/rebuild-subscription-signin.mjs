import assert from 'node:assert/strict';
import {exampleHome} from '../dist/example-home.js';
import {startSharedHome} from '../dist/shared-startup.js';
import {workerSignIn} from '../dist/runtime/worker-http.js';

export async function subscriptionSignIn({browser,home}) {
 const example=await exampleHome(home);
 const app=await startSharedHome({home,port:0,stdout(){}});
 let context;
 try {
  context=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce'});
  const providerPage='https://garden.example.invalid/device';
  await context.route('**/*',route=>{
   if(route.request().url()===providerPage)return route.fulfill({contentType:'text/html',body:`<form><label>Device code <input required pattern="GARD-1234"></label><button>Sign in</button></form><output></output>
    <script>document.querySelector('form').onsubmit=event=>{event.preventDefault();document.querySelector('output').textContent='Device authorized';};</script>`});
   return new URL(route.request().url()).origin===app.url?route.continue():route.abort();
  });
  await context.routeWebSocket(url=>url.origin!==app.url.replace(/^http/,'ws'),route=>route.close());
  const page=await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(app.signinLink('alex'));
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.locator('.next-shell').waitFor();
  const subscriptions=app.url+'/p/subscriptions';
  await page.goto(subscriptions);
  await page.locator('summary').filter({hasText:/^Add a subscription$/}).click();
  const form=page.getByRole('form',{name:'Add a subscription'});
  const label='Workshop spare',machine='Example workshop',provider='example-provider';
  await form.locator('select[name=provider]').selectOption(provider);
  await form.locator('input[name=label]').fill(label);
  await form.getByRole('checkbox',{name:machine}).check();
  const [created]=await Promise.all([page.waitForResponse(r=>r.url()===app.url+'/api/runtime/accountCreate'),form.getByRole('button',{name:'Add subscription'}).click()]);
  const result=await created.json();
  assert.equal(result.ok,true);
  assert.notEqual(result.value.id,example.account.id);
  const group=page.locator('summary').filter({hasText:/^example-provider · 2 ·/}).locator('..');
  const summary=group.locator('summary').filter({hasText:label});
  await summary.filter({hasText:'Sign-in requested'}).click();
  await summary.locator('..').getByText(machine+' · Sign-in requested',{exact:true}).waitFor();
  const credential=app.writes.run(()=>app.services.signin.issue({kind:'runner',box:example.runtime.box,label:'Fictional sign-in walkthrough'})).value;
  const worker=workerSignIn({url:app.url,token:credential.token,signal:AbortSignal.timeout(60000)});
  const request=await worker.next();
  assert.ok(request?.id);
  assert.equal(request.account,result.value.id);
  assert.equal(request.owner,'alex');
  assert.equal(request.provider,provider);
  await worker.page({id:request.id,link:providerPage,userCode:'GARD-1234'});
  await page.goto(app.url+'/p/inbox-preview');
  const inbox=page.getByRole('region',{name:'Inbox tile',exact:true});
  await inbox.getByRole('button',{name:/^FYI\b/i}).first().click();
  await inbox.locator('[data-split-row]').filter({hasText:label}).click();
  const reader=inbox.getByRole('article',{name:'Inbox item'});
  const words=await reader.getByRole('heading').innerText();
  const code=words.match(/enter the code ([A-Z0-9-]+)/)?.[1];
  assert.equal(code,'GARD-1234');
  const link=reader.getByRole('link',{name:'Open linked page'});
  assert.equal(await link.getAttribute('href'),providerPage);
  const [device]=await Promise.all([context.waitForEvent('page'),link.click()]);
  await device.getByLabel('Device code').fill(code);
  await device.getByRole('button',{name:'Sign in'}).click();
  await device.getByText('Device authorized',{exact:true}).waitFor();
  await worker.done({id:request.id,signedIn:true});
  const receipt=app.services.comms.db.$client.prepare('SELECT state,resolution FROM inbox WHERE source_id=?').get('signin:'+request.id);
  assert.deepEqual(receipt,{state:'resolved',resolution:'Signed in'});
  await page.goto(subscriptions);
  await page.reload();
  await summary.click();
  assert.doesNotMatch(await summary.innerText(),/Sign-in requested/);
  await summary.locator('..').getByText('Configured machines: '+machine,{exact:true}).waitFor();
  return {ok:true,reason:'Alex added a second subscription with the desktop form, received its device link and code in Inbox, and saw the selected machine after the fixture provider completed the worker sign-in and the desktop reloaded.'};
 }finally{await context?.close();await app.close();}
}
