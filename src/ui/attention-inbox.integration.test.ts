/** Independent browser proofs; CI owns Chromium and the screenshot artifacts. */
import { it, expect, onTestFailed } from 'vitest';
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
type InboxProof = {
  loom: Awaited<ReturnType<typeof startLoom>>; clock: FakeClock; home: string;
  browser: import('playwright-core').Browser; a: import('playwright-core').Page; b: import('playwright-core').Page;
  owner: {kind: 'member'; id: string}; raise: (input: object) => void;
  signIn: (page: import('playwright-core').Page, member: string) => Promise<void>;
  yes: (page: import('playwright-core').Page) => import('playwright-core').Locator;
  shots: string; privateThread: string; setPhase: (phase: string) => void;
};
// A fresh home and browser per concern keeps retention's clock jump and all
// receipts isolated. No test relies on a predecessor's actions or timeout budget.
function inboxProof(name: string, proof: (fixture: InboxProof) => Promise<void>) {
  it.runIf(chrome && existsSync(join(root,'next.html')))(`Inbox ${name}`,async()=>{
  let phase=name;onTestFailed(()=>console.error(`Inbox browser phase: ${phase}`));
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
    // A missing locator must identify its own failure before the whole proof
    // times out. Match expect.poll's condition budget; keep each proof bounded.
    context.setDefaultTimeout(10_000);
    await context.grantPermissions(['local-network-access'],{origin:loom.url});
    const a=await context.newPage(),b=await context.newPage();
    const yes=(p:typeof a)=>p.getByRole('button',{name:'Yes',exact:true});
    const shots=resolve('artifacts/attention-inbox');mkdirSync(shots,{recursive:true});
    const signIn=async(page:typeof a,member:string)=>{
      const link=loom.operations.call('direct',owner,'signin.link',{member});
      expect(link.ok).toBe(true);if(!link.ok)throw Error('Fixture sign-in failed');
      await page.goto(loom.url+(link.value as {path:string}).path);
      const response=page.waitForResponse(r=>r.request().method()==='POST');
      await page.getByRole('button',{name:'Sign in',exact:true}).click();expect((await response).status()).toBe(303);
    };
    await signIn(a,'jonathan');
    await proof({loom, clock, home, browser, a, b, owner, raise, signIn, yes, shots, privateThread, setPhase: value=>{phase=value;}});
  } finally {await browser.close();await loom.close();rmSync(home,{recursive:true,force:true});}
  },60_000);
}

inboxProof('asks and answers once across windows, with both looks',async({loom, browser, a, b, owner, signIn, yes, shots})=>{
    await Promise.all([a.goto(`${loom.url}/p/inbox-preview/ask/public`),b.goto(`${loom.url}/p/inbox-preview/ask/public`)]);
    const readingRow=b.locator('[data-split-row]').filter({hasText:'Read this without answering it?'});
    await expect.poll(()=>readingRow.getAttribute('data-unread')).toBe('true');
    await a.goto(`${loom.url}/p/inbox-preview/ask/reading`);
    await expect.poll(()=>readingRow.getAttribute('data-unread')).toBe(null);
    expect(loom.operations.call('direct',owner,'attention.get',{id:'reading'})).toMatchObject({ok:true,value:{state:'open'}});
    await a.goto(`${loom.url}/p/inbox-preview/ask/public`);
    await a.getByRole('button',{name:'Check again',exact:true}).click();
    await b.getByRole('button',{name:'Check again',exact:true}).click();
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

    for(const look of ['neon','daylight'])for(const width of [390,1280,1920]) {
      await a.setViewportSize({width,height:900});
      await a.evaluate(look=>{document.documentElement.dataset.look=look;document.documentElement.dataset.mode=look==='daylight'?'light':'dark';document.documentElement.dataset.motion='reduce';},look);
      await expect.poll(()=>a.locator('.loom-split').getAttribute('data-mode')).toBe(width<640?'one':'three');
      await a.getByText(/Saved does not mean read/).scrollIntoViewIfNeeded();
      expect(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await a.screenshot({path:join(shots,`inbox-answer-acceptance-${look}-${width}.png`),fullPage:true,animations:'disabled'});
    }
    await a.setViewportSize({width:1280,height:900});
    await a.getByRole('button',{name:'Record answer',exact:true}).click();
    await expect.poll(()=>yes(b).count()).toBe(0);
    await expect.poll(()=>b.getByText(/words · jonathan/).count()).toBe(1);
    await expect.poll(()=>b.getByText('Continue after the small fix.',{exact:true}).count()).toBe(1);
    await expect.poll(()=>a.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('loom:inbox:draft:') && localStorage.getItem(key)==='Continue after the small fix.').length)).toBe(0);
    expect(loom.operations.call('direct',owner,'attention.get',{id:'public'})).toMatchObject({ok:true,value:{answer:{kind:'words',text:'Continue after the small fix.',by:owner}}});
    await b.setViewportSize({width:1280,height:900});
    await b.getByRole('button',{name:/Answered/}).click();
    await expect.poll(()=>b.locator('[data-split-row]').filter({hasText:'Continue the Attention rebuild?'}).count()).toBe(1);
    // A meaningful public action persists once in this member's FYI across windows/reloads.
    await b.getByRole('button',{name:/^FYI/}).click();
    const outcomeRow=b.locator('[data-split-row]').filter({hasText:'Record answer: saved.'});
    await expect.poll(()=>outcomeRow.count()).toBe(1);
    await outcomeRow.click();
    await b.getByRole('heading',{name:'Record answer: saved.',exact:true}).waitFor();
    await b.reload();
    await b.getByRole('heading',{name:'Record answer: saved.',exact:true}).waitFor();
    // A refused ordinary window write creates a safe error summary, never its input/error words.
    const rejected=await b.evaluate(()=>new Promise(resolve=>{
      const ws=new WebSocket(`${location.origin.replace('http','ws')}/live`);
      ws.onopen=()=>ws.send(JSON.stringify({kind:'call',request:'outcome-proof',name:'attention.answer',id:'outcome-rejected',input:{id:'absent-private-source',answer:{kind:'words',text:'Never copy these private input words'}}}));
      ws.onmessage=event=>{const message=JSON.parse(event.data);if(message.kind==='result'&&message.request==='outcome-proof'){ws.close();resolve(message.result);}};
    }));
    expect(rejected).toMatchObject({ok:false});
    await b.setViewportSize({width:1280,height:900});
    await b.getByRole('button',{name:/^Errors/}).click();
    await b.locator('[data-split-row]').filter({hasText:'Record answer: could not be saved.'}).click();
    await b.getByRole('heading',{name:'Record answer: could not be saved.',exact:true}).waitFor();
    expect(await b.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(JSON.stringify(loom.db.prepare('SELECT * FROM attention_outcomes').all())).not.toContain('Never copy these private input words');
    await b.setViewportSize({width:1280,height:900});
    await b.goto(`${loom.url}/p/inbox-preview/ask/private`);
    await expect.poll(()=>b.getByText('Answer this in its private conversation. Private replies stay there.').count()).toBe(1);
    expect(await yes(b).count()).toBe(0);
    // A different member cannot read the owner's successful or refused outcomes.
    const other=await browser.newContext({serviceWorkers:'block'});
    const otherPage=await other.newPage();await signIn(otherPage,'pollock');
    expect(loom.operations.call('direct',{kind:'member',id:'pollock'},'attention.outcomes',{})).toEqual({ok:true,value:[]});
    await other.close();
});

inboxProof('owning Tasks and completed waits',async({loom, a, b, owner, raise, yes})=>{
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
});

inboxProof('reported Approvals FYI across windows, with both looks',async({loom, a, b, owner, shots, setPhase})=>{
    setPhase('reported-step FYI');
    await b.goto(`${loom.url}/p/inbox-preview`);
    // A real tell event files a stable FYI across both windows and opens its owner.
    expect(loom.operations.call('direct',owner,'approvals.set-rule',{kind:'merge',scope:'github:notice-fixture/*',tier:'tell'},'inbox-notice-rule').ok).toBe(true);
    await a.goto(`${loom.url}/p/approvals-preview/notices`);
    await expect.poll(()=>a.getByRole('group',{name:'Approval notices'}).count()).toBe(1);
    await b.getByRole('button',{name:/^FYI/}).click();
    expect(loom.operations.call('direct',{kind:'agent',id:'art'},'approvals.tell',{kind:'merge',target:`github:notice-fixture/app#12@${'a'.repeat(40)}`,what:'Reported fixture page fix'},'inbox-approval-notice').ok).toBe(true);
    await expect.poll(()=>a.locator('[data-split-row]').filter({hasText:'Reported fixture page fix'}).count()).toBe(1);
    await a.goto(`${loom.url}/p/inbox-preview`);
    await a.getByRole('button',{name:/^FYI/}).click();
    const noticeRow=(page:typeof a)=>page.locator('[data-split-row]').filter({hasText:'Merge reported in Approvals'});
    await expect.poll(()=>noticeRow(b).getAttribute('data-unread')).toBe('true');
    await noticeRow(a).click();
    await expect.poll(()=>noticeRow(b).getAttribute('data-unread')).toBe(null);
    await a.getByRole('region',{name:'Inbox tile',exact:true}).getByRole('button',{name:'Open Approvals',exact:true}).click();
    await expect.poll(()=>a.locator('[data-split-row]').filter({hasText:'Reported fixture page fix'}).count()).toBe(1);
    expect(new URL(a.url()).pathname).toBe('/p/approvals-preview/notices');
    // Capture the owning app alone after proving cross-app navigation above.
    await a.goto(`${loom.url}/p/approvals-preview/notices`);
    await expect.poll(()=>a.getByRole('group',{name:'Approval notices'}).count()).toBe(1);
    await noticeRow(b).click();
    for(const look of ['neon','daylight'])for(const width of [390,1280,1920]) {
      await b.setViewportSize({width,height:900});
      await b.evaluate(look=>{document.documentElement.dataset.look=look;document.documentElement.dataset.mode=look==='daylight'?'light':'dark';document.documentElement.dataset.motion='reduce';},look);
      await expect.poll(()=>b.locator('.loom-split').getAttribute('data-mode')).toBe(width<640?'one':'three');
      expect(await b.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await b.screenshot({path:join(shots,`inbox-approval-notice-${look}-${width}.png`),fullPage:true,animations:'disabled'});
      await a.setViewportSize({width,height:900});
      await a.evaluate(look=>{document.documentElement.dataset.look=look;document.documentElement.dataset.mode=look==='daylight'?'light':'dark';document.documentElement.dataset.motion='reduce';},look);
      await expect.poll(()=>a.locator('.loom-split').getAttribute('data-mode')).toBe(width<640?'one':'three');
      expect(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await a.screenshot({path:join(shots,`approvals-reported-${look}-${width}.png`),fullPage:true,animations:'disabled'});
    }
    await b.setViewportSize({width:1280,height:900});
    await b.goto(`${loom.url}/p/inbox-preview`);
});

inboxProof('Clock acknowledgements and owning approval resolution',async({loom, clock, a, b, owner, raise, yes, setPhase})=>{
    setPhase('Clock acknowledgement');
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
    setPhase('owning approval');
    // One actual central approval, with the owning page's action and two-window withdrawal.
    const requested=loom.operations.call('direct',{kind:'agent',id:'art'},'approvals.request',{kind:'merge',target:`github:acme/app#12@${'a'.repeat(40)}`,ask:'Merge the Inbox source fix?',why:'The source card keeps the exact decision and receipt.',if_yes:'I merge the fix.',if_no:'I hold it.'},'inbox-request-approval');
    expect(requested.ok).toBe(true);if(!requested.ok)throw Error(requested.message);
    const approvalId=(requested.value as {id:string}).id;
    for(const page of [a,b]){
      setPhase(`owning approval: open ${page===a?'first':'second'} window`);
      await page.goto(`${loom.url}/p/inbox-preview/ask/${approvalAskId(approvalId)}`);
      await page.getByRole('button',{name:'Open approval',exact:true}).waitFor();
      expect(await yes(page).count()).toBe(0);
    }

    raise({id:'approval-wait',source:{kind:'conversation',id:'cv-approval-wait'},project:'pond',ask:'Please decide the Inbox fix?',waits_on:{approval:approvalId}});
    raise({id:'approval-wait-2',source:{kind:'conversation',id:'cv-approval-wait-2'},project:'pond',ask:'Another conversation about the fix?',waits_on:{approval:approvalId}});
    setPhase('owning approval: deduplicated wait rows');
    for(const page of [a,b]){
      await expect.poll(()=>page.locator('[data-split-row]').filter({hasText:'Please decide the Inbox fix?'}).count()).toBe(1);
      await expect.poll(()=>page.locator('[data-split-row]').filter({hasText:'Merge the Inbox source fix?'}).count()).toBe(0);
      expect(await page.locator('[data-split-row]').filter({hasText:'Another conversation about the fix?'}).count()).toBe(0);
    }
    setPhase('owning approval: navigate to source');
    await a.getByRole('button',{name:'Open approval',exact:true}).click();
    await expect.poll(()=>new URL(a.url()).pathname).toBe(`/p/approvals-preview/approval/${approvalId}`);
    expect(loom.operations.call('direct',owner,'approvals.answer',{id:approvalId,action:'deny'},'inbox-deny-approval').ok).toBe(true);
    setPhase('owning approval: source resolution');
    await b.getByRole('heading',{name:'Approval no longer needs you',exact:true}).waitFor();
});

inboxProof('private scope, sealed replies and retained wordless history',async({loom, clock, home, browser, a, b, owner, signIn, yes, privateThread, setPhase})=>{
    const member=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});
    member.setDefaultTimeout(10_000);
    await member.grantPermissions(['local-network-access'],{origin:loom.url});
    const p=await member.newPage();await signIn(p,'pollock');
    expect(loom.operations.call('direct',{kind:'member',id:'pollock'},'attention.outcomes',{})).toEqual({ok:true,value:[]});await p.goto(`${loom.url}/p/inbox-preview`);
    await expect.poll(()=>p.locator('[data-split-row]').filter({hasText:'Review the shared Pond plan?'}).count()).toBe(1);
    expect(await p.getByText('Private conversation needs you').count()).toBe(0);
    expect(await p.getByText('Continue the Attention rebuild?').count()).toBe(0);
    // An actual owning private conversation: typed words never enter Attention or device storage.
    for(const page of [a,b]){
      setPhase(`private reply: check ${page===a?'first':'second'} window`);
      await page.goto(`${loom.url}/p/inbox-preview/ask/private-reply`);
      await page.getByRole('button',{name:'Check again',exact:true}).click();
      await page.getByRole('textbox',{name:'Your private reply',exact:true}).waitFor();
      expect(await yes(page).count()).toBe(0);
    }
    setPhase('private reply: send');
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
    setPhase('sealed private reply');
    const key=await loadKey(home);
    const askPrivate=privateQuestionCreator({...loom,clock,key,sharing:fixtureSharing,attention:attentionRole(loom.operations),runtime:{deliver:async()=>{},end:async()=>{}},hold:async f=>f(),closed:()=>false,changed:(t,seq,ref)=>loom.live.changed([{type:'thread',id:t.id},{type:'message',id:`${t.id}:${seq}`},{type:'attention.ask',id:ref}])});
    const sealedWords='Keep the sealed Inbox plan private?';
    const sealed=await askPrivate('art',privateThread,{id:'inbox-sealed',question:{ask:sealedWords,why:'Only this member sees the full question.',if_yes:'Continue the private plan.',if_no:'Hold the private plan.',answers:'yes-no'}});
    for(const page of [a,b]){
      setPhase(`sealed private reply: check ${page===a?'first':'second'} window`);
      await page.goto(`${loom.url}/p/inbox-preview/ask/${encodeURIComponent(sealed.ref)}`);
      await page.getByRole('heading',{name:sealedWords,exact:true}).waitFor();
      await page.getByRole('button',{name:'Check private question',exact:true}).click();
      await page.getByRole('textbox',{name:'Your private reply',exact:true}).waitFor();
    }
    setPhase('sealed private reply: send');
    await a.getByRole('textbox',{name:'Your private reply',exact:true}).fill('Sealed typed Inbox answer');
    expect(await b.getByRole('textbox',{name:'Your private reply',exact:true}).inputValue()).toBe('');
    expect(await a.evaluate(()=>JSON.stringify(localStorage).includes('Sealed typed Inbox answer'))).toBe(false);
    await a.setViewportSize({width:390,height:900});
    await expect.poll(()=>a.locator('.loom-split').getAttribute('data-mode')).toBe('one');
    expect(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await a.getByRole('button',{name:'Send private reply',exact:true}).click();
    await expect.poll(()=>b.getByRole('button',{name:'Yes',exact:true}).count()).toBe(0);
    await expect.poll(()=>b.getByText(/replied · jonathan/).count()).toBe(1);
    for(const table of ['attention_asks','attention_digests','core_operations','comms_messages']){
      const stored=JSON.stringify(loom.db.prepare(`SELECT * FROM ${table}`).all());
      expect(stored).not.toContain(sealedWords);expect(stored).not.toContain('Sealed typed Inbox answer');
    }
    setPhase('sealed private reply: other member');
    await p.goto(`${loom.url}/p/inbox-preview/ask/${encodeURIComponent(sealed.ref)}`);
    await p.getByText('This ask is no longer in view',{exact:true}).waitFor();expect(await p.getByText(sealedWords,{exact:true}).count()).toBe(0);
    setPhase('sealed private reply: retention');
    clock.advance(14*86400_000);
    // Retention also ages the real sign-in session. Reauthenticate before reading its wordless history.
    await expect.poll(()=>b.getByText(sealedWords,{exact:true}).count()).toBe(0);
    await signIn(b,'jonathan');
    await b.goto(`${loom.url}/p/inbox-preview/ask/${encodeURIComponent(sealed.ref)}`);
    await b.getByText('Words no longer kept',{exact:true}).waitFor();expect(await b.getByText(sealedWords,{exact:true}).count()).toBe(0);
    await b.getByRole('button',{name:'Open private reply',exact:true}).click();
    await expect.poll(()=>new URL(b.url()).pathname).toBe(`/p/comms-preview/thread/${privateThread.replace(/^th:/,'')}`);
    await member.close();
});
