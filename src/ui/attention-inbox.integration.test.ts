/** One browser proof; CI owns Chromium and the six screenshot artifacts. */
import { it, expect } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startLoom } from '../foundation.js';
import { FakeClock } from '../core/clock.js';
import { fixture, fixtureSharing, installFixture } from '../fixture.js';
import { approvalAskId, taskAskId } from '../pieces/attention/role.js';
import { installApprovals } from '../pieces/approvals/index.js';
import { privateQuestionCreator } from '../pieces/comms/private-questions.js';
import { loadKey } from '../pieces/comms/crypto.js';
import { attentionRole } from '../pieces/attention/role.js';
import { TokenDatabase } from '../core/household/tokens.js';
const root=resolve(import.meta.dirname,'../../dist/web');
const chrome=[process.env.LOOM_TEST_CHROME,'/usr/bin/google-chrome','/usr/bin/chromium',chromium.executablePath()].find(p=>p&&existsSync(p));
it.runIf(chrome && existsSync(join(root,'next.html')))('Inbox confirms asks, answers once across windows, respects private scope and captures both looks',async()=>{
  const home=mkdtempSync(join(tmpdir(),'loom-inbox-browser-')); fixture(home);
  const clock=new FakeClock(Date.parse('2026-11-13T06:00:00Z'));
  const owner={kind:'member' as const,id:'jonathan'};
  const loom=await startLoom({home,clock,next:true,staging:true,sharing:fixtureSharing,webRoot:root,install:app=>{installApprovals(app.db,app.operations,app.live,fixtureSharing,{caller:v=>({who:{agent:v.id,where:'h-browser'},for:'owner',project:'pond'})});installFixture(app);app.db.transaction(()=>new TokenDatabase(app.db).replace({v:1,tokens:[]},{}))();}});
  let serial=0;
  const raise=(input:object)=>{const result=loom.operations.call('direct',owner,'attention.raise',{agent:'art',answers:'yes-no',source:{kind:'piece',id:'fixture'},...input},`raise:${++serial}`);expect(result.ok).toBe(true);};
  raise({id:'public',ask:'Continue the Attention rebuild?',why:'The shared Inbox should show one current question in every window.',if_yes:'I build the remaining Home cards.',if_no:'I stop and keep this preview available.',refs:['t-2205','sleepunit-agents/loom#912']});
  raise({id:'reading',ask:'Read this without answering it?'});
  raise({id:'private',member:'jonathan',ask:'Private conversation needs you'});
  const opened=await loom.operations.callAsync('socket',owner,'comms.open',{agent:'art',id:'cccccccccccccccc',text:'Private Inbox fixture'},'inbox-private-open',true);
  if(!opened.ok)throw Error(opened.message);
  const privateThread=(opened.value as {thread:string}).thread;
  const thread=JSON.parse((loom.db.prepare('SELECT record FROM comms_threads WHERE id=?').get(privateThread) as {record:string}).record);
  raise({id:'private-reply',member:'jonathan',source:{kind:'conversation',id:thread.conversation},ask:'Reply privately about the plan?',answers:'words'});
  raise({id:'pond',agent:'pond-bot',project:'pond',ask:'Review the shared Pond plan?'});
  const browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  try {
    const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});
    await context.grantPermissions(['local-network-access'],{origin:loom.url});
    const a=await context.newPage(),b=await context.newPage();
    const signIn=async(page:typeof a,member:string)=>{
      const link=loom.operations.call('direct',owner,'signin.link',{member});
      expect(link.ok).toBe(true);if(!link.ok)throw Error('Fixture sign-in failed');
      await page.goto(loom.url+(link.value as {path:string}).path);
      const response=page.waitForResponse(r=>r.request().method()==='POST');
      await page.getByRole('button',{name:'Sign in',exact:true}).click();expect((await response).status()).toBe(303);
    };
    await signIn(a,'jonathan');
    await Promise.all([a.goto(`${loom.url}/p/inbox-preview/ask/public`),b.goto(`${loom.url}/p/inbox-preview/ask/public`)]);
    const readingRow=b.locator('[data-split-row]').filter({hasText:'Read this without answering it?'});
    await expect.poll(()=>readingRow.getAttribute('data-unread')).toBe('true');
    await a.goto(`${loom.url}/p/inbox-preview/ask/reading`);
    await expect.poll(()=>readingRow.getAttribute('data-unread')).toBe(null);
    expect(loom.operations.call('direct',owner,'attention.get',{id:'reading'})).toMatchObject({ok:true,value:{state:'open'}});
    await a.goto(`${loom.url}/p/inbox-preview/ask/public`);
    await a.getByRole('button',{name:'Check again',exact:true}).click();
    await b.getByRole('button',{name:'Check again',exact:true}).click();
    const yes=(p:typeof a)=>p.getByRole('button',{name:'Yes',exact:true});
    await expect.poll(()=>yes(a).isEnabled()).toBe(true);await expect.poll(()=>yes(b).isEnabled()).toBe(true);
    await a.getByRole('textbox',{name:'Or answer in your own words'}).fill('Continue after the small fix.');
    expect(await yes(a).isDisabled()).toBe(true);
    await expect.poll(()=>b.getByRole('textbox',{name:'Or answer in your own words'}).inputValue()).toBe('Continue after the small fix.');
    await a.reload();
    await a.getByRole('button',{name:'Check again',exact:true}).click();
    await expect.poll(()=>a.getByRole('textbox',{name:'Or answer in your own words'}).inputValue()).toBe('Continue after the small fix.');
    await a.goto(`${loom.url}/p/inbox-preview/ask/private`);
    await a.getByText('Answer this in its private conversation. Private replies stay there.').waitFor();
    expect(await a.getByRole('textbox',{name:'Or answer in your own words'}).count()).toBe(0);
    await a.goto(`${loom.url}/p/inbox-preview/ask/public`);
    await a.getByRole('button',{name:'Check again',exact:true}).click();
    await expect.poll(()=>a.getByRole('textbox',{name:'Or answer in your own words'}).inputValue()).toBe('Continue after the small fix.');
    const shots=resolve('artifacts/attention-inbox');mkdirSync(shots,{recursive:true});

    await a.getByRole('button',{name:'Record answer',exact:true}).click();
    await expect.poll(()=>yes(b).count()).toBe(0);
    await expect.poll(()=>b.getByText(/words · jonathan/).count()).toBe(1);
    await expect.poll(()=>b.getByText('Continue after the small fix.',{exact:true}).count()).toBe(1);
    await expect.poll(()=>a.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('loom:inbox:draft:') && localStorage.getItem(key)==='Continue after the small fix.').length)).toBe(0);
    expect(loom.operations.call('direct',owner,'attention.get',{id:'public'})).toMatchObject({ok:true,value:{answer:{kind:'words',text:'Continue after the small fix.',by:owner}}});
    await b.setViewportSize({width:1280,height:900});
    await b.getByRole('button',{name:/Answered/}).click();
    await expect.poll(()=>b.locator('[data-split-row]').filter({hasText:'Continue the Attention rebuild?'}).count()).toBe(1);
    await b.goto(`${loom.url}/p/inbox-preview/ask/private`);
    await expect.poll(()=>b.getByText('Answer this in its private conversation. Private replies stay there.').count()).toBe(1);
    expect(await yes(b).count()).toBe(0);
    const member=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});
    await member.grantPermissions(['local-network-access'],{origin:loom.url});
    const p=await member.newPage();await signIn(p,'pollock');await p.goto(`${loom.url}/p/inbox-preview`);
    await expect.poll(()=>p.locator('[data-split-row]').filter({hasText:'Review the shared Pond plan?'}).count()).toBe(1);
    expect(await p.getByText('Private conversation needs you').count()).toBe(0);
    expect(await p.getByText('Continue the Attention rebuild?').count()).toBe(0);
    // Source-owned owner tasks file centrally but decisions stay in Tasks.
    expect(loom.operations.call('direct',owner,'tasks.update',{id:'t-1',set:{assignee:'jonathan',ask:'Approve the source task plan?'},actor:'art',at:'2026-11-13T06:00:00Z'},'inbox-file-task')).toMatchObject({ok:true,value:{result:{ok:true}}});
    for(const page of [a,b]) {
      await page.goto(`${loom.url}/p/inbox-preview/ask/${taskAskId('t-1')}`);
      await page.getByRole('button',{name:'Open task',exact:true}).waitFor();
      expect(await yes(page).count()).toBe(0);
    }

    await a.getByRole('button',{name:'Open task',exact:true}).click();
    await expect.poll(()=>new URL(a.url()).pathname).toBe('/p/tasks-preview/task/t-1');
    await a.getByRole('heading',{name:'Pond work',exact:true}).waitFor();
    // Arriving live waits reconcile through the signed-in member, in both windows.
    expect(loom.operations.call('direct',owner,'tasks.close',{id:'t-1',actor:'jonathan',at:'2026-11-13T06:00:00Z'},'inbox-close-wait-task').ok).toBe(true);
    await expect.poll(()=>loom.operations.call('direct',owner,'attention.get',{id:taskAskId('t-1')})).toMatchObject({ok:true,value:{state:'resolved'}});
    await b.getByRole('heading',{name:'Task no longer needs you',exact:true}).waitFor();
    raise({id:'closed-task',ask:'Check the completed work?',waits_on:{task:'t-1'}});
    await expect.poll(()=>loom.operations.call('direct',owner,'attention.get',{id:'closed-task'})).toMatchObject({ok:true,value:{state:'resolved',resolution:'t-1 is closed'}});
    for(const page of [a,b]) {
      await page.goto(`${loom.url}/p/inbox-preview/ask/closed-task`);
      await expect.poll(()=>page.getByText('t-1 is closed',{exact:true}).count()).toBe(1);
      expect(await yes(page).count()).toBe(0);
    }
    const fact=loom.operations.call('direct',owner,'attention.get',{id:'closed-task'});
    if(!fact.ok)throw Error('Missing wait');expect(fact.value).not.toHaveProperty('answer');
    // The same resolution is quiet FYI, never a human answer or another open need.
    await b.setViewportSize({width:1280,height:900});
    await b.getByRole('button',{name:/^FYI/}).click();
    await expect.poll(()=>b.locator('[data-split-row]').filter({hasText:'Check the completed work?'}).count()).toBe(1);
    await b.getByRole('searchbox',{name:'Search asks'}).fill('t-1 is closed');
    await b.locator('[data-split-row]').filter({hasText:'Check the completed work?'}).click();
    await b.getByRole('heading',{name:'Check the completed work?',exact:true}).waitFor();
    expect(await yes(b).count()).toBe(0);

    await b.setViewportSize({width:1280,height:900});
    await b.getByRole('searchbox',{name:'Search asks'}).fill('');
    await b.getByRole('button',{name:/^Answered/}).click();
    expect(await b.locator('[data-split-row]').filter({hasText:'Check the completed work?'}).count()).toBe(0);
    await b.locator('.loom-split').getByRole('button',{name:/^Needs you/}).click();
    // An owning Clock outcome produces the real managed notice; acknowledgement leaves work alone.
    const wakeResult=loom.operations.call('direct',owner,'clock.in',{agent:'art',prompt:'Fixture scheduled work',note:'Inbox alert fixture',when:'1m'},'inbox-clock-wake');
    if(!wakeResult.ok)throw Error(wakeResult.message);
    const wake=wakeResult.value as {id:string;due:number}; clock.advance(wake.due-clock.now());
    // FakeClock may synchronously commit the daemon intent before its deferred external call.
    const current=JSON.parse((loom.db.prepare('SELECT record FROM clock_wakes WHERE id=?').get(wake.id) as {record:string}).record) as {state:string;attempt?:string};
    const attempt=current.state==='firing' ? current.attempt! : 'inbox-clock-attempt';
    if(current.state!=='firing')expect(loom.operations.call('direct',owner,'clock.dispatch',{id:wake.id,attempt},'inbox-clock-dispatch').ok).toBe(true);
    const outcome=loom.operations.call('direct',owner,'clock.outcome',{id:wake.id,attempt,result:{state:'not-started',code:'quota',reason:'Fixture capacity wait'}},'inbox-clock-outcome');
    expect(outcome.ok).toBe(true);
    const noticeId=`clock:${wake.id}:quota`;
    await b.goto(`${loom.url}/p/inbox-preview/ask/${encodeURIComponent(noticeId)}`);
    await b.getByRole('button',{name:'Check again',exact:true}).click();
    await b.getByRole('button',{name:'Acknowledge',exact:true}).waitFor();
    expect(await yes(b).count()).toBe(0);
    await b.locator('.loom-split').getByRole('button',{name:/^Alerts/}).click();
    await b.locator('[data-split-row]').filter({hasText:'Review clock work waiting for model capacity.'}).click();
    await b.getByRole('button',{name:'Acknowledge',exact:true}).waitFor();

    await b.setViewportSize({width:1280,height:900});
    const beforeAck=loom.operations.call('direct',owner,'clock.list',{});
    expect(beforeAck.ok).toBe(true);
    await b.getByRole('button',{name:'Acknowledge',exact:true}).click();
    await expect.poll(()=>loom.operations.call('direct',owner,'attention.get',{id:noticeId})).toMatchObject({ok:true,value:{state:'answered',answer:{kind:'done'}}});
    expect(loom.operations.call('direct',owner,'clock.list',{})).toEqual(beforeAck);
    await b.locator('.loom-split').getByRole('button',{name:'Open Clock',exact:true}).click();
    await expect.poll(()=>new URL(b.url()).pathname).toBe('/p/clock-preview');
    await b.goto(`${loom.url}/p/inbox-preview`);
    // One actual central approval, with the owning page's action and two-window withdrawal.
    const requested=loom.operations.call('direct',{kind:'agent',id:'art'},'approvals.request',{kind:'merge',target:`github:acme/app#12@${'a'.repeat(40)}`,ask:'Merge the Inbox source fix?',why:'The source card keeps the exact decision and receipt.',if_yes:'I merge the fix.',if_no:'I hold it.'},'inbox-request-approval');
    expect(requested.ok).toBe(true);if(!requested.ok)throw Error(requested.message);
    const approvalId=(requested.value as {id:string}).id;
    for(const page of [a,b]){
      await page.goto(`${loom.url}/p/inbox-preview/ask/${approvalAskId(approvalId)}`);
      await page.getByRole('button',{name:'Open approval',exact:true}).waitFor();
      expect(await yes(page).count()).toBe(0);
    }

    raise({id:'approval-wait',source:{kind:'conversation',id:'cv-approval-wait'},project:'pond',ask:'Please decide the Inbox fix?',waits_on:{approval:approvalId}});
    raise({id:'approval-wait-2',source:{kind:'conversation',id:'cv-approval-wait-2'},project:'pond',ask:'Another conversation about the fix?',waits_on:{approval:approvalId}});
    for(const page of [a,b]){
      await expect.poll(()=>page.locator('[data-split-row]').filter({hasText:'Please decide the Inbox fix?'}).count()).toBe(1);
      await expect.poll(()=>page.locator('[data-split-row]').filter({hasText:'Merge the Inbox source fix?'}).count()).toBe(0);
      expect(await page.locator('[data-split-row]').filter({hasText:'Another conversation about the fix?'}).count()).toBe(0);
    }
    await a.getByRole('button',{name:'Open approval',exact:true}).click();
    await expect.poll(()=>new URL(a.url()).pathname).toBe(`/p/approvals-preview/approval/${approvalId}`);
    expect(loom.operations.call('direct',owner,'approvals.answer',{id:approvalId,action:'deny'},'inbox-deny-approval').ok).toBe(true);
    await b.getByRole('heading',{name:'Approval no longer needs you',exact:true}).waitFor();
    // An actual owning private conversation: typed words never enter Attention or device storage.
    for(const page of [a,b]){
      await page.goto(`${loom.url}/p/inbox-preview/ask/private-reply`);
      await page.getByRole('button',{name:'Check again',exact:true}).click();
      await page.getByRole('textbox',{name:'Your private reply',exact:true}).waitFor();
      expect(await yes(page).count()).toBe(0);
    }
    const privateWords='Private Inbox reply fixture sentinel';
    await a.getByRole('textbox',{name:'Your private reply',exact:true}).fill(privateWords);
    expect(await b.getByRole('textbox',{name:'Your private reply',exact:true}).inputValue()).toBe('');
    expect(await a.evaluate(words=>JSON.stringify(localStorage).includes(words),privateWords)).toBe(false);
    await a.getByRole('button',{name:'Send private reply',exact:true}).click();
    await expect.poll(()=>b.getByRole('button',{name:'Send private reply',exact:true}).count()).toBe(0);
    const privateFact=loom.operations.call('direct',owner,'attention.get',{id:'private-reply'});
    expect(privateFact).toMatchObject({ok:true,value:{state:'answered',answer:{kind:'replied',reply:{thread:privateThread}}}});
    for(const table of ['attention_asks','attention_digests','core_operations','comms_messages'])expect(JSON.stringify(loom.db.prepare(`SELECT * FROM ${table}`).all())).not.toContain(privateWords);
    const messages=await loom.operations.callAsync('socket',owner,'comms.messages',{thread:privateThread},'inbox-private-read',true);
    expect(messages).toMatchObject({ok:true,value:expect.arrayContaining([expect.objectContaining({text:privateWords,ref:'private-reply'})])});
    await b.getByRole('button',{name:'Open private reply',exact:true}).click();
    await expect.poll(()=>new URL(b.url()).pathname).toBe(`/p/comms-preview/thread/${privateThread.replace(/^th:/,'')}`);
    // Trusted owning Comms producer, using the same encrypted source capability as Runtime.
    const key=await loadKey(home);
    const askPrivate=privateQuestionCreator({...loom,clock,key,sharing:()=>fixtureSharing,attention:attentionRole(loom.operations),runtime:{deliver:async()=>{},end:async()=>{}},hold:async f=>f(),closed:()=>false,changed:(t,seq,ref)=>loom.live.changed([{type:'thread',id:t.id},{type:'message',id:`${t.id}:${seq}`},{type:'attention.ask',id:ref}])});
    const sealedWords='Keep the sealed Inbox plan private?';
    const sealed=await askPrivate('art',privateThread,{id:'inbox-sealed',question:{ask:sealedWords,why:'Only this member sees the full question.',if_yes:'Continue the private plan.',if_no:'Hold the private plan.',answers:'yes-no'}});
    for(const page of [a,b]){
      await page.goto(`${loom.url}/p/inbox-preview/ask/${encodeURIComponent(sealed.ref)}`);
      await page.getByRole('heading',{name:sealedWords,exact:true}).waitFor();
      await page.getByRole('button',{name:'Check private question',exact:true}).click();
      await page.getByRole('textbox',{name:'Your private reply',exact:true}).waitFor();
    }
    await a.getByRole('textbox',{name:'Your private reply',exact:true}).fill('Sealed typed Inbox answer');
    expect(await b.getByRole('textbox',{name:'Your private reply',exact:true}).inputValue()).toBe('');
    expect(await a.evaluate(()=>JSON.stringify(localStorage).includes('Sealed typed Inbox answer'))).toBe(false);
    for(const look of ['neon','daylight'])for(const width of [390,1280,1920]){
      await a.setViewportSize({width,height:900});
      await a.evaluate(look=>{document.documentElement.dataset.look=look;document.documentElement.dataset.mode=look==='daylight'?'light':'dark';document.documentElement.dataset.motion='reduce';},look);
      await expect.poll(()=>a.locator('.loom-split').getAttribute('data-mode')).toBe(width<640?'one':'three');
      expect(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await a.screenshot({path:join(shots,`inbox-sealed-${look}-${width}.png`),fullPage:true,animations:'disabled'});
    }
    await a.getByRole('button',{name:'Send private reply',exact:true}).click();
    await expect.poll(()=>b.getByRole('button',{name:'Yes',exact:true}).count()).toBe(0);
    await expect.poll(()=>b.getByText(/replied · jonathan/).count()).toBe(1);
    for(const table of ['attention_asks','attention_digests','core_operations','comms_messages']){
      const stored=JSON.stringify(loom.db.prepare(`SELECT * FROM ${table}`).all());
      expect(stored).not.toContain(sealedWords);expect(stored).not.toContain('Sealed typed Inbox answer');
    }
    await p.goto(`${loom.url}/p/inbox-preview/ask/${encodeURIComponent(sealed.ref)}`);
    await p.getByText('This ask is no longer in view',{exact:true}).waitFor();expect(await p.getByText(sealedWords,{exact:true}).count()).toBe(0);
    clock.advance(14*86400_000);
    await b.getByText('Words no longer kept',{exact:true}).waitFor();expect(await b.getByText(sealedWords,{exact:true}).count()).toBe(0);
    await b.getByRole('button',{name:'Open private reply',exact:true}).waitFor();
    await member.close();
  } finally {await browser.close();await loom.close();rmSync(home,{recursive:true,force:true});}
},90_000);
