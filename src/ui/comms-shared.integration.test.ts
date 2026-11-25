/** One shipped Comms proof. CI owns Chromium; data and credentials are fictitious. */
import { it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { eq } from 'drizzle-orm';
import { FakeClock } from '../core/clock.js';
import { members, memberAgents, agents, messages, inbox, operationResults, threads, boxes, jobs, tokens, sessions } from '../core/data/schema.js';
import {sharedUiProgram} from '../../test/fixtures/shared-ui-program.js';
const root = resolve(import.meta.dirname, '../../dist/web');
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', chromium.executablePath()].find(p => p && existsSync(p));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
it.runIf(chrome && existsSync(join(root, 'index.html')))('shipped Comms opens, sends and answers messages and Tempo settings inline across windows', async () => {
  const clock = new FakeClock(Date.now()),now=()=>new Date(clock.now()).toISOString();
  const program=await sharedUiProgram({clock,webRoot:root,seed(db){
  db.insert(members).values([{ id: 'alice', role: 'member', joinedAt: now() },{id:'fixture-owner',role:'owner',joinedAt:now()}]).run();
  db.insert(agents).values({ id: 'art', about: '', markBg: '#000', markFg: '#fff', faceShape: 'pebble', faceEyes: 'dot' }).run();
  db.insert(memberAgents).values({ member: 'alice', agent: 'art' }).run();
  const token = 't'.repeat(64), cookie = 'c'.repeat(64);
  db.$client.prepare('INSERT INTO tokens (fingerprint,label,kind,member,created_at,expires_at) VALUES (?,?,?,?,?,?)').run(hash(token), 'Fixture', 'owner', 'alice', now(), new Date(clock.now() + 3600000).toISOString());
  db.$client.prepare('INSERT INTO sessions (id,token,device,via,is_agent,issued_at,seen_at,proved_at) VALUES (?,?,?,?,?,?,?,?)').run(hash(cookie), hash(token), 'Browser', 'token', 0, now(), now(), now());
  }});
  const {client,db,composition,url}=program;
  const token='t'.repeat(64),cookie='c'.repeat(64);
  let browser: import('playwright-core').Browser | undefined;
  try {
    browser = await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
    const context = await browser.newContext({serviceWorkers:'block'}); context.setDefaultTimeout(10_000);
    await context.addCookies([{name:'loom_ui',value:cookie,url}]);
    const a = await context.newPage(), b = await context.newPage();
    for(const page of [a,b]) { page.on('pageerror',error=>console.info('Fixture page error:',error.message)); page.on('console',msg=>{if(msg.type()==='error')console.info('Fixture console:',msg.text());}); }
    await a.goto(`${url}/p/comms-preview`); console.info('Comms: loaded registered screen');
    await a.getByRole('button',{name:/^New conversation with art$/i}).click();
    await expect.poll(() => db.select().from(threads).all().length).toBe(1);
    const thread = db.select().from(threads).get()!;
    expect(thread.title).toBe('New conversation');
    await expect.poll(() => a.getByRole('textbox',{name:'Message Art',exact:true}).count()).toBe(1);
    await b.setViewportSize({width:390,height:844});
    await b.goto(`${url}/p/comms-preview`);
    const search=b.locator('header[aria-label="Comms toolbar"]').getByRole('searchbox',{name:'Search conversations'});
    await search.click();
    await search.fill('no fixture matches this');
    expect(await search.inputValue()).toBe('no fixture matches this');
    await b.getByText('No conversations here',{exact:true}).waitFor();
    await search.fill(thread.title);
    const match=b.locator('[data-split-row]').filter({hasText:thread.title});
    await match.press('Enter');
    await b.getByRole('textbox',{name:'Message Art',exact:true}).waitFor();
    await b.getByRole('button',{name:'Back to conversations'}).click();
    await expect.poll(()=>match.evaluate(row=>row===document.activeElement)).toBe(true);
    await b.keyboard.press('Enter');
    await a.getByRole('textbox',{name:'Message Art',exact:true}).fill('PRIVATE PERSON MESSAGE');
    // A reconnect/remount must retain the unsent device draft without sending it.
    expect(db.select().from(messages).all()).toHaveLength(0);
    await a.reload();
    await expect.poll(() => a.getByRole('textbox',{name:'Message Art',exact:true}).inputValue()).toBe('PRIVATE PERSON MESSAGE');
    expect(db.select().from(messages).all()).toHaveLength(0);
    await a.getByRole('button',{name:'Send',exact:true}).click();
    for (const page of [a,b]) await expect.poll(() => page.getByText('PRIVATE PERSON MESSAGE',{exact:true}).count()).toBe(1);
    await composition.services.comms!.send({thread:thread.id,kind:'reply',sender:'art',words:'PRIVATE AGENT REPLY'}); composition.changed();
    for (const page of [a,b]) await expect.poll(() => page.getByText('PRIVATE AGENT REPLY',{exact:true}).count()).toBe(1);
    await composition.services.comms!.ask(thread.id,'art','question',{words:'PRIVATE PUMP QUESTION',answers:'yes-no'}); composition.changed();
    for (const page of [a,b]) await expect.poll(() => page.getByRole('article',{name:'Question',exact:true}).getByText('PRIVATE PUMP QUESTION',{exact:true}).count()).toBe(1); console.info('Inbox: private question visible');
    await a.getByRole('button',{name:'Yes',exact:true}).click();
    for (const page of [a,b]) {
      await expect.poll(() => page.getByRole('button',{name:'Yes',exact:true}).count()).toBe(0);
      await expect.poll(() => page.getByRole('article',{name:'Question',exact:true}).getByText(/Yes · alice/i).count()).toBe(1);
    }
    await a.getByRole('button',{name:'More for this conversation',exact:true}).click();
    await a.getByRole('button',{name:'Pin',exact:true}).click();
    await expect.poll(() => db.select().from(threads).where(eq(threads.id,thread.id)).get()?.pinned).toBe(true);
    await expect.poll(() => db.select().from(threads).where(eq(threads.id,thread.id)).get()?.readSeq).toBe(4);
    expect(db.select().from(messages).all()).toHaveLength(4);
    const durable = JSON.stringify([db.select().from(inbox).all(),db.select().from(operationResults).all()]);
    for (const words of ['PRIVATE PUMP QUESTION','PRIVATE PERSON MESSAGE','PRIVATE AGENT REPLY']) expect(durable).not.toContain(words);
    if (process.env.LOOM_SHOTS) {
      mkdirSync(process.env.LOOM_SHOTS,{recursive:true});
      await a.screenshot({path:join(process.env.LOOM_SHOTS,'comms-shared-wide.png'),fullPage:true});
      await b.setViewportSize({width:390,height:844});
      await b.screenshot({path:join(process.env.LOOM_SHOTS,'comms-shared-phone.png'),fullPage:true});
    }
    composition.writes.run(() => client.prepare('UPDATE tokens SET revoked_at=? WHERE fingerprint=?').run(now(),hash(token)));
    for (const page of [a,b]) for (const words of ['PRIVATE PUMP QUESTION','PRIVATE PERSON MESSAGE','PRIVATE AGENT REPLY']) await expect.poll(() => page.getByText(words,{exact:true}).count()).toBe(0);
    // Keep the ordinary member proof above, then reuse its tab for the owner
    // chat that can answer the settings proposal, just as on the Tempo page.
    const bodyToken='comms-browser-settings-body-'.repeat(4);
    const ownerToken='comms-settings-owner-token-'.repeat(4),ownerCookie='comms-settings-owner-cookie-'.repeat(4);
    db.insert(members).values({id:'settings-owner',role:'owner',joinedAt:now()}).run();
    db.insert(memberAgents).values({member:'settings-owner',agent:'art'}).run();
    const settingsThread=composition.services.comms!.threads.open({id:'th:tempo-settings',agent:'art',member:'settings-owner',title:'Tempo settings'});
    composition.writes.run(()=>{
      db.insert(tokens).values({fingerprint:hash(ownerToken),label:'Settings owner',kind:'owner',member:'settings-owner',createdAt:now()}).run();
      db.insert(sessions).values({id:hash(ownerCookie),token:hash(ownerToken),device:'Browser',via:'token',isAgent:false,issuedAt:now(),seenAt:now(),provedAt:now()}).run();
      db.insert(boxes).values({id:'browser-box',name:'Fixture box',owner:'settings-owner',sameMachineAsLoom:false,hostsAny:false,reportOnly:false,alwaysOn:false,enrolledAt:now()}).run();
      db.insert(jobs).values({id:'browser-body',box:'browser-box',agent:'art',conversation:settingsThread.conversation,member:'settings-owner',title:'Settings body',state:'running',brief:'',model:'fixture',startedByKind:'agent',startedBy:'art',houseRepository:'repo',houseFile:'Housefile',houseBranch:'next',queuedAt:now()}).run();
      db.insert(tokens).values({fingerprint:hash(bodyToken),label:'Fixture body',kind:'agent',agent:'art',job:'browser-body',createdAt:now()}).run();
    });
    await context.addCookies([{name:'loom_ui',value:ownerCookie,url}]);
    await a.goto(url+'/p/comms-preview/thread/tempo-settings');
    const who={kind:'person' as const,id:'settings-owner'};
    const settingsCards=a.getByRole('article',{name:/Change Tempo’s timings for/i});
    for(const [allow,seconds] of [[true,60],[false,120]] as const){
      const before=composition.services.tempo.volume.timings(who).settleSeconds;
      const proposal=await context.request.post(url+'/api/household/propose',{
        headers:{authorization:'Bearer '+bodyToken},
        data:{id:'timing-'+seconds,input:{change:'tempoTimings',input:{who,settleSeconds:seconds},why:'Requested in this conversation.'}},
      });
      expect(proposal.status()).toBe(200);
      const {value}=await proposal.json();
      const card=settingsCards.filter({has:a.getByRole('button',{name:'Allow',exact:true})});
      await card.getByRole('button',{name:'Details',exact:true}).click();
      await expect.poll(()=>card.getByText(before+' seconds → '+seconds+' seconds',{exact:true}).count()).toBe(1);
      await card.getByRole('button',{name:allow?'Allow':'Deny',exact:true}).click();
      await expect.poll(()=>composition.services.approvals.get(value.id)?.state).toBe(allow?'used':'denied');
      expect(composition.services.tempo.volume.timings(who).settleSeconds).toBe(60);
    }
    await expect.poll(()=>settingsCards.count()).toBe(2);
    composition.writes.run(()=>client.prepare('UPDATE tokens SET revoked_at=? WHERE fingerprint=?').run(now(),hash(ownerToken)));
    await expect.poll(()=>settingsCards.count()).toBe(0);
    expect(program.errors).toEqual([]);
  } finally {
    if(browser) for(const context of browser.contexts()) for(const page of context.pages()) console.info('Fixture visible text:',await page.locator('body').innerText().catch(()=>'')); console.info('Proof: closing browser'); try{await browser?.close();}finally{await program.close();}
  }
});
