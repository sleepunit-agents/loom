/** One shipped Inbox proof. CI owns Chromium; data and credentials are fictitious. */
import { it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { eq } from 'drizzle-orm';
import { FakeClock } from '../core/clock.js';
import { members, memberAgents, agents, messages, inbox, operationResults, threads } from '../core/data/schema.js';
import {sharedUiProgram} from '../../test/fixtures/shared-ui-program.js';
const root = resolve(import.meta.dirname, '../../dist/web');
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', chromium.executablePath()].find(p => p && existsSync(p));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
it.runIf(chrome && existsSync(join(root, 'index.html')))('shipped Inbox reads, sets recipient volume and answers across windows, then withdraws revoked words', async () => {
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
  const thread = composition.services.comms!.threads.open({member:'alice',agent:'art',title:'Pump'});
  const question = await composition.services.comms!.ask(thread.id,'art','question',{words:'PRIVATE PUMP QUESTION',answers:'yes-no'});
    browser = await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
    const context = await browser.newContext({serviceWorkers:'block'}); context.setDefaultTimeout(10_000);
    await context.addCookies([{name:'loom_ui',value:cookie,url}]);
    const a = await context.newPage(), b = await context.newPage();
    for(const page of [a,b]) { page.on('pageerror',error=>console.info('Fixture page error:',error.message)); page.on('console',msg=>{if(msg.type()==='error')console.info('Fixture console:',msg.text());}); }
    await Promise.all([a,b].map(page => page.goto(`${url}/p/inbox-preview/ask/${encodeURIComponent(question.inboxItem!)}`)));
    for (const page of [a,b]) await expect.poll(() => page.getByRole('heading',{name:'PRIVATE PUMP QUESTION',exact:true}).count()).toBe(1); console.info('Inbox: private question visible');
    await expect.poll(() => client.prepare('SELECT count(*) AS n FROM inbox_reads').get()).toEqual({n:1});
    // The toolbar stays reachable above the one-pane list and its reader.
    await b.setViewportSize({width:390,height:844});
    await b.getByRole('button',{name:'Back to Inbox'}).click();
    const search=b.locator('header[aria-label="Inbox toolbar"]').getByRole('searchbox',{name:'Search asks'});
    await search.fill('PRIVATE PUMP');
    const pump=b.getByRole('button',{name:/PRIVATE PUMP QUESTION/});
    await pump.focus();await pump.press('Enter');
    await b.getByRole('heading',{name:'PRIVATE PUMP QUESTION',exact:true}).waitFor();
    // Recipient volume uses this already-open Inbox item, before answering it.
    const notify=a.getByRole('combobox',{name:'Notify',exact:true});
    await notify.selectOption('dim');
    await expect.poll(()=>client.prepare('SELECT volume FROM inbox WHERE id=?').get(question.inboxItem!)).toEqual({volume:'dim'});
    await expect.poll(()=>notify.inputValue()).toBe('dim');
    await notify.selectOption('mute');
    await expect.poll(()=>client.prepare('SELECT volume FROM inbox WHERE id=?').get(question.inboxItem!)).toEqual({volume:'mute'});
    await expect.poll(()=>notify.inputValue()).toBe('mute');
    expect(client.prepare('SELECT quiet_until AS until FROM inbox WHERE id=?').get(question.inboxItem!)).toEqual({until:new Date(clock.now()+7*86400000).toISOString()});
    await expect.poll(()=>a.getByText(/back to normal/).count()).toBe(1);
    await notify.selectOption('full');
    await expect.poll(()=>client.prepare('SELECT volume,quiet_until AS quietUntil FROM inbox WHERE id=?').get(question.inboxItem!)).toEqual({volume:'full',quietUntil:null});
    await a.getByRole('button',{name:'Yes',exact:true}).click();
    for (const page of [a,b]) {
      await expect.poll(() => page.getByRole('button',{name:'Yes',exact:true}).count()).toBe(0);
      await expect.poll(() => page.getByRole('heading',{name:'Answer',exact:true}).count()).toBe(1);
    }
    expect(db.select().from(messages).all()).toHaveLength(2);
    const durable = JSON.stringify([db.select().from(inbox).all(),db.select().from(operationResults).all()]);
    expect(durable).not.toContain('PRIVATE PUMP QUESTION');
    if (process.env.LOOM_SHOTS) {
      mkdirSync(process.env.LOOM_SHOTS,{recursive:true});
      await a.screenshot({path:join(process.env.LOOM_SHOTS,'inbox-shared-wide.png'),fullPage:true});
      await b.setViewportSize({width:390,height:844});
      await b.screenshot({path:join(process.env.LOOM_SHOTS,'inbox-shared-phone.png'),fullPage:true});
    }
    composition.writes.run(() => client.prepare('UPDATE tokens SET revoked_at=? WHERE fingerprint=?').run(now(),hash(token)));
    for (const page of [a,b]) for (const words of ['PRIVATE PUMP QUESTION']) await expect.poll(() => page.getByText(words,{exact:true}).count()).toBe(0);
    expect(program.errors).toEqual([]);
  } finally {
    if(browser) for(const context of browser.contexts()) for(const page of context.pages()) console.info('Fixture visible text:',await page.locator('body').innerText().catch(()=>'')); console.info('Proof: closing browser'); try{await browser?.close();}finally{await program.close();}
  }
});
