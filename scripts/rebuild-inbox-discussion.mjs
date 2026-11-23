import assert from 'node:assert/strict';
import {join} from 'node:path';
import {exampleHome} from '../dist/example-home.js';
import {startSharedHome} from '../dist/shared-startup.js';
import {prepareHistoryContext} from '../dist/core/conversations/history-context.js';

export async function inboxDiscussion({browser,home,out}) {
 await exampleHome(home);
 const app=await startSharedHome({home,port:0,stdout(){}});
 let context;
 try {
  context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce',serviceWorkers:'block'});
  await context.route('**/*', route=>new URL(route.request().url()).origin===app.url?route.continue():route.abort());
  await context.routeWebSocket(url=>url.origin!==app.url.replace(/^http/,'ws'), route=>route.close());
  const page=await context.newPage();
  page.setDefaultTimeout(10000);
  const words='The fictional rain gauge lost power during its overnight check.';
  const item=app.writes.run(()=>app.services.conversations.send({toKind:'person',to:'alex',member:'alex',source:'notice',fromKind:'unknown',words})).value;
  const db=app.services.comms.db.$client;
  const threadCount=()=>db.prepare('SELECT count(*) AS n FROM threads').get().n;
  const agentMailCount=()=>db.prepare("SELECT count(*) AS n FROM inbox WHERE to_kind='agent'").get().n;
  const threadsBefore=threadCount(),mailBefore=agentMailCount();
  await page.goto(app.signinLink('alex'));
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.locator('.next-shell').waitFor();
  const readNotice=async()=>{
   await page.goto(app.url+'/p/inbox-preview');
   const tile=page.getByRole('region',{name:'Inbox tile',exact:true});
   await tile.getByRole('button',{name:/^FYI\b/i}).first().click();
   await tile.locator('[data-split-row]').filter({hasText:words}).click();
   const reader=tile.getByRole('article',{name:'Inbox item',exact:true});
   await reader.getByRole('heading',{name:words,exact:true}).waitFor();
   return reader.getByRole('button',{name:'Discuss with Fern',exact:true});
  };
  const discuss=async button=>{
   const [reply]=await Promise.all([page.waitForResponse(r=>r.url()===app.url+'/api/inbox/discuss'&&r.request().method()==='POST'),button.click()]);
   assert.equal(reply.status(),200);
   const result=await reply.json();
   assert.equal(result.ok,true);
   const tile=page.getByRole('region',{name:'Comms tile',exact:true});
   await tile.getByText('From your Inbox',{exact:true}).waitFor();
   await tile.getByRole('blockquote').filter({hasText:words}).waitFor();
   return result.value;
  };
  const button=await readNotice();
  assert.equal(threadCount(),threadsBefore);
  const first=await discuss(button);
  assert.equal(threadCount(),threadsBefore+1);
  assert.equal(agentMailCount(),mailBefore);
  const route=page.url();
  const reopened=await discuss(await readNotice());
  assert.deepEqual(reopened,first);
  assert.equal(page.url(),route);
  assert.equal(threadCount(),threadsBefore+1);
  assert.equal(agentMailCount(),mailBefore);
  const question='When was the rain gauge last online?';
  const tile=page.getByRole('region',{name:'Comms tile',exact:true});
  const composer=tile.getByRole('textbox',{name:/message fern/i});
  await composer.fill(question);
  await composer.press('Enter');
  await tile.getByText(question,{exact:true}).waitFor();
  const deliveries=db.prepare("SELECT [to] AS recipient,thread,message_seq AS seq FROM inbox WHERE conversation=? AND source='thread' AND to_kind='agent'").all(first.conversation);
  assert.deepEqual(deliveries,[{recipient:'fern',thread:first.thread,seq:2}]);
  const history=await prepareHistoryContext(app.services.comms,first.conversation,deliveries[0].seq);
  assert.deepEqual(history().map(({sender,kind,words})=>({sender,kind,words})),[{sender:'loom',kind:'notice',words}]);
  const screenshot='action-inboxDiscussion.png';
  await tile.screenshot({path:join(out,screenshot)});
  return {ok:true,screenshot,reason:'Reading the FYI created no chat. Discuss opened one private thread with Fern and the quoted notice. Reopening returned to it. Sending the first question delivered it once with the FYI available in its history.',item:item.id,...first};
 } finally {
  try {await context?.close();}finally{await app.close();}
 }
}
