/** One browser proof, against a disposable in-process fixture and fake clock. */
import { it, expect } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {createDataSchema} from '../core/data/database.js';
import {members,agents,tokens,sessions} from '../core/data/schema.js';
import {serveShared} from '../shared-serve.js';
import { FakeClock } from '../core/clock.js';
const root = resolve(import.meta.dirname, '../../dist/web');
const chrome = [process.env.LOOM_TEST_CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', chromium.executablePath()].find(p => p && existsSync(p));
it.runIf(chrome && existsSync(join(root, 'index.html')))('Project sharing creates projects and changes members and agents across two windows', async () => {
  const client=new Database(':memory:'),clock=new FakeClock(),now=()=>new Date(clock.now()).toISOString(),db=createDataSchema(client,now);
  const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
  db.insert(members).values([{id:'jonathan',role:'owner',joinedAt:now()},{id:'pollock',role:'member',joinedAt:now()}]).run();
  db.insert(agents).values(['art','mark'].map(id=>({id,about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble' as const,faceEyes:'dot' as const}))).run();
  const cookies={jonathan:'j'.repeat(64),pollock:'p'.repeat(64)};
  for(const [member,cookie] of Object.entries(cookies)){
    const fingerprint=hash(member.repeat(64));
    db.insert(tokens).values({fingerprint,label:member,kind:'owner',member,createdAt:now()}).run();
    db.insert(sessions).values({id:hash(cookie),token:fingerprint,device:'Fixture',via:'token',isAgent:false,issuedAt:now(),seenAt:now(),provedAt:now()}).run();
  }
  const loom=await serveShared({db,clock,webRoot:root,originAllowed:req=>!req.headers.origin||req.headers.origin===`http://${req.headers.host}`,reportError:error=>{throw error;}});
  const browser = await chromium.launch({ executablePath:chrome,args:['--no-sandbox'] });
  try {
    const context = await browser.newContext({ serviceWorkers:'block',viewport:{width:1280,height:900} });
    await context.grantPermissions(['local-network-access'],{origin:loom.url});
    await context.addCookies([{name:'loom_ui',value:cookies.jonathan,url:loom.url}]);
    const a=await context.newPage(),b=await context.newPage();
    await Promise.all([a.goto(`${loom.url}/p/sharing-preview`),b.goto(`${loom.url}/p/sharing-preview`)]);
    await expect.poll(()=>a.getByRole('textbox',{name:'Name',exact:true}).count()).toBe(1);
    await a.getByRole('textbox',{name:'Name',exact:true}).fill('Garden');
    await a.getByRole('textbox',{name:'Slug',exact:true}).fill('garden');
    await a.getByRole('button',{name:'Create project',exact:true}).click();
    const row=(page:typeof a,title:string)=>page.locator('[data-split-row]').filter({hasText:title});
    await expect.poll(()=>row(b,'Garden').count()).toBe(1);
    await a.getByRole('button',{name:'Create project',exact:true}).click();
    await expect.poll(()=>a.getByRole('alert').textContent()).toContain('Could not confirm this change');
    expect(await a.getByRole('textbox',{name:'Name',exact:true}).inputValue()).toBe('Garden');
    await row(a,'Garden').click(); await row(b,'Garden').click();
    await a.getByRole('checkbox',{name:'pollock',exact:true}).check();
    await a.getByRole('button',{name:'Save members',exact:true}).click();
    await expect.poll(()=>b.getByRole('checkbox',{name:'pollock',exact:true}).isChecked()).toBe(true);
    await a.getByRole('checkbox',{name:'mark',exact:true}).check();
    await a.getByRole('button',{name:'Save agents',exact:true}).click();
    await expect.poll(()=>b.getByRole('checkbox',{name:'mark',exact:true}).isChecked()).toBe(true);
    await b.reload();
    await expect.poll(()=>row(b,'Garden').count()).toBe(1); await row(b,'Garden').click();
    await expect.poll(()=>b.getByRole('checkbox',{name:'mark',exact:true}).isChecked()).toBe(true);
    const shots=process.env.LOOM_TEST_SHOTS??resolve('artifacts/sharing-app');mkdirSync(shots,{recursive:true});
    for(const look of ['neon','daylight']) for(const width of [390,1280,1920]) {
      await b.setViewportSize({width,height:900});
      await b.evaluate(look=>{document.documentElement.dataset.look=look;document.documentElement.dataset.mode=look==='daylight'?'light':'dark';document.documentElement.dataset.motion='reduce';},look);
      await b.screenshot({path:join(shots,`sharing-${look}-${width}.png`),fullPage:true,animations:'disabled'});
    }
    await a.getByRole('checkbox',{name:'pollock',exact:true}).uncheck();
    await a.getByRole('button',{name:'Save members',exact:true}).click();
    await expect.poll(()=>b.getByRole('checkbox',{name:'pollock',exact:true}).isChecked()).toBe(false);
    const pollock=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});
    await pollock.grantPermissions(['local-network-access'],{origin:loom.url});
    await pollock.addCookies([{name:'loom_ui',value:cookies.pollock,url:loom.url}]);
    const p=await pollock.newPage();await p.goto(`${loom.url}/p/sharing-preview`);
    await expect.poll(()=>p.getByText('Household owners manage sharing',{exact:true}).count()).toBe(1);
    expect(await p.getByRole('button',{name:'Create project',exact:true}).count()).toBe(0);
    await pollock.close();
  } finally { await browser.close();await loom.close();client.close(); }
},60_000);
