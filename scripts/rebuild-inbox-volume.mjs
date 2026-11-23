import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {exampleHome} from '../dist/example-home.js';
import {startSharedHome} from '../dist/shared-startup.js';
import {FakeClock} from '../dist/core/clock.js';

/** Isolate the two deadline restarts from the main walkthrough's jobs and clock. */
export async function inboxVolume({browser,home,out}) {
 const seed=await exampleHome(home);
 let clock=new FakeClock(Date.parse(seed.createdAt)),app,context;
 const start=port=>startSharedHome({home,port,clock,stdout(){}});
 try {
  app=await start(0);
  const origin=app.url,port=Number(new URL(origin).port);
  context=await browser.newContext({viewport:{width:1500,height:900},reducedMotion:'reduce',serviceWorkers:'block'});
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await context.routeWebSocket(url=>url.origin!==origin.replace(/^http/,'ws'),route=>route.close());
  const page=await context.newPage();
  page.setDefaultTimeout(8000);
  const signIn=async()=>{
   await page.goto(app.signinLink('alex'));
   await page.getByRole('button',{name:'Sign in',exact:true}).click();
   await page.locator('.next-shell').waitFor();
   await page.goto(origin+'/p/inbox-preview');
  };
  await signIn();
  const tile=page.getByRole('region',{name:'Inbox tile',exact:true});
  const control=tile.getByRole('combobox',{name:'Notify',exact:true});
  const who={kind:'agent',id:'fern'},recipient={kind:'member',id:'alex'};
  const ask=(id,words)=>app.services.tasks.ask(id,{to:recipient,ask:words,ifYes:'Inspect it.',ifNo:'Leave it.'},who);
  const observed=id=>app.services.conversations.item(id);
  const volume=async(words,id,level)=>{
   const row=tile.locator('[data-split-row]').filter({hasText:words});
   await row.click();
   const [response]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/inbox/volume')&&r.request().method()==='POST'),control.selectOption(level)]);
   assert.equal(response.status(),200);assert.equal((await response.json()).ok,true);
   assert.equal(observed(id).volume,level);
   return row;
  };
  for(const level of ['dim','mute']){
   for(const named of [false,true]){
    const words=`Inspect the ${level} ${named?'named':'ordinary'} garden fixture?`;
    const task=app.writes.run(()=>{
     const newTask=app.services.tasks.create({title:words,goal:'Check the garden.',why:'Example volume check.',owner:who},who);
     ask(newTask.id,words);return newTask;
    }).value;
    const {id}=app.services.comms.db.$client.prepare("SELECT id FROM inbox WHERE waits_on_kind='task' AND waits_on_id=? AND state='waiting'").get(task.id);
    await volume(words,id,level);
    app.writes.run(()=>named?ask(task.id,words+' Again?'):app.services.tasks.close(task.id,'Inspection finished.'));
    const changed=observed(id);
    assert.equal(changed.state,'resolved');
    assert.equal(changed.volume,named||level==='dim'?'full':'mute');
   }
  }
  const title='Check the hose after the quiet period?',detail='Bring the spare nozzle.';
  const commit=await app.services.comms.prepareAsk(seed.thread,'fern','quiet-period',{words:title+'\n'+detail,answers:'words'});
  const id=app.writes.run(commit).value.inboxItem;
  const row=await volume(title,id,'dim');
  await page.reload();await control.waitFor();
  assert.equal(await control.inputValue(),'dim');
  assert.equal(await row.locator('.loom-kit-title').textContent(),title);
  assert.ok((await tile.locator('[aria-label="Inbox item"]').innerText()).includes(detail));
  const screenshot='action-inboxVolume.png';
  await tile.screenshot({path:join(out,screenshot)});
  const day=86_400_000;
  const restartBefore=async(deadline,level)=>{
   await page.goto('about:blank');await context.clearCookies();
   await app.close();app=undefined;
   clock=new FakeClock(deadline-1);
   app=await start(port);
   assert.equal(observed(id).volume,level);
   clock.advance(1);
   assert.equal(observed(id).volume,'full');assert.equal(observed(id).quietUntil,null);
   await signIn();await row.click();assert.equal(await control.inputValue(),'full');
  };
  assert.equal(Date.parse(observed(id).quietUntil)-clock.now(),day);
  await restartBefore(Date.parse(observed(id).quietUntil),'dim');
  await volume(title,id,'mute');await row.waitFor({state:'detached'});
  assert.equal(Date.parse(observed(id).quietUntil)-clock.now(),7*day);
  await restartBefore(Date.parse(observed(id).quietUntil),'mute');
  const item=app.writes.run(()=>app.services.conversations.send({toKind:'agent',to:'fern',source:'notice',fromKind:'schedule',words:'Fictional agent reminder'})).value;
  const credential=app.services.signin.issue({kind:'agent',agent:'fern',label:'Fictional recipient'});
  try{
   const response=await fetch(origin+'/api/inbox/volume',{method:'POST',headers:{authorization:'Bearer '+credential.token,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),input:{item:item.id,volume:'dim'}})});
   assert.equal(response.status,200);assert.equal((await response.json()).ok,true);assert.equal(observed(item.id).volume,'dim');
  }finally{app.services.signin.revoke(credential.fingerprint);}
  return {ok:true,screenshot,reason:'Alex changed volume in Inbox and Fern changed its own reminder. Quiet kept the first line and Hidden removed the row. Closing a task returned Quiet to Normal and left Hidden alone. Asking Alex again returned both to Normal. Restarts preserved both levels until their exact one-day and seven-day deadlines.'};
 }catch(error){return {ok:false,error:String(error)};}
 finally{try{await context?.close();}finally{await app?.close();}}
}

/** Follow the approved Inbox page’s links to the two descriptions it promises. */
export async function inboxDocumentation(browser){
 const base=pathToFileURL(join(process.cwd(),'docs/how-it-works/site/')).href;
 const context=await browser.newContext({javaScriptEnabled:false,serviceWorkers:'block'});
 try{
  const page=await context.newPage();page.setDefaultTimeout(5000);
  const allowed=new Set(['inbox','conversations','tempo'].map(name=>base+name+'.html'));
  await context.route('**/*',route=>allowed.has(route.request().url())?route.continue():route.abort());
  await page.goto(base+'inbox.html');
  const columns=async()=> (await page.locator('#t-inbox .col code').allTextContents()).flatMap(name=>name.split(', '));
  const fields=await columns();assert.ok(fields.includes('to_kind') && fields.includes('to') && fields.includes('volume'));
  const note=page.locator('p.note').filter({hasText:'The same inbox table'});
  await note.getByRole('link',{name:'Conversations',exact:true}).click();
  assert.equal(page.url(),base+'conversations.html');assert.deepEqual(await columns(),fields);
  await page.goBack();await note.getByRole('link',{name:'Tempo',exact:true}).click();
  assert.equal(page.url(),base+'tempo.html');
  const section=page.locator('.how__p').filter({has:page.getByRole('heading',{name:'Volume',exact:true})});
  assert.deepEqual(await section.locator('li b').allTextContents(),['full','dim','mute']);
  assert.deepEqual(await section.locator('li span').allTextContents(),['the default','one line','hidden, and always ends']);
  return {ok:true,reason:`The Inbox links opened Conversations and Tempo. Both mailbox diagrams named the same ${fields.length} columns in order, and Tempo described full, dim and mute.`};
 }catch(error){return {ok:false,error:String(error)};}
 finally{await context.close();}
}
