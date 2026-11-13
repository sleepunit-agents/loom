/** One browser proof: fixture-only holder, two windows, live operations and six screenshots. */
import { it,expect } from 'vitest';
import { existsSync,mkdtempSync,rmSync,mkdirSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve,extname } from 'node:path';
import { chromium } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import { startLoom } from '../foundation.js';
import { fixture,fixtureSharing } from '../fixture.js';
import { FakeClock } from '../core/index.js';
import { installSecrets,grantsRole } from '../pieces/secrets/index.js';
import { installSecretValues } from '../pieces/secrets/values.js';
const root=resolve(import.meta.dirname,'../../dist/web');
const chrome=[process.env.LOOM_TEST_CHROME,'/usr/bin/google-chrome','/usr/bin/chromium',chromium.executablePath()].find(p=>p&&existsSync(p));
it.runIf(chrome&&existsSync(join(root,'index.html')))('Settings keeps values write-only and shares names, answers and grants across two windows',async()=>{
 const home=mkdtempSync(join(tmpdir(),'loom-settings-browser-'));fixture(home);const clock=new FakeClock(Date.parse('2026-11-13T12:00:00Z'));
 let writes=0;const modes:string[]=[];const values=new Map<string,Buffer>();
 const app=await startLoom({home,next:true,staging:true,clock,sharing:fixtureSharing,install:a=>{
  installSecrets(a.db,a.operations,a.live,fixtureSharing,{raise:()=>({raised:true})});
  installSecretValues(a.db,a.operations,fixtureSharing,{names:()=>[...values.keys()],set(name,value,mode){modes.push(mode);values.set(name,Buffer.from(value));writes++;},remove(name){values.delete(name);},handTo(){},rotate(){}});
 },authenticate:req=>({viewer:{kind:'member',id:req.headers.cookie?.includes('fixture=pollock')?'pollock':'jonathan'},valid:()=>true})});
 const browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
 try{
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}});await context.grantPermissions(['local-network-access'],{origin:app.url});
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.pathname==='/live'||url.pathname.startsWith('/api/'))return route.continue();
   const path=url.pathname.startsWith('/app/')?resolve(root,url.pathname.slice(5)):join(root,'index.html');
   if(!path.startsWith(`${root}/`)||!existsSync(path))return route.fulfill({status:404,body:''});
   return route.fulfill({body:readFileSync(path),contentType:({'.js':'text/javascript','.css':'text/css','.html':'text/html','.woff2':'font/woff2'} as Record<string,string>)[extname(path)]??'application/octet-stream'});
  });
  const a=await context.newPage(),b=await context.newPage();await Promise.all([a.goto(`${app.url}/p/settings-preview`),b.goto(`${app.url}/p/settings-preview`)]);
  const row=(p:typeof a,text:string)=>p.locator('[data-split-row]').filter({hasText:text});
  await expect.poll(()=>a.getByRole('button',{name:'Add a secret',exact:true}).count()).toBe(1);
  await a.getByRole('button',{name:'Add a secret',exact:true}).click();
  await a.getByRole('textbox',{name:'Name',exact:true}).fill('API');
  const sentinel='fixture-only-value-NEVER-DISPLAY';
  await a.locator('input[name=value]').fill(sentinel);await a.getByRole('button',{name:'Save secret',exact:true}).click();
  await expect.poll(()=>row(b,'API').count()).toBe(1);expect(writes).toBe(1);expect(await a.locator('input[name=value]').inputValue()).toBe('');
  await row(b,'API').click();expect(await b.locator('input[name=value]').inputValue()).toBe('');
  await b.locator('input[name=value]').fill(sentinel+'-replacement');
  await b.getByRole('button',{name:'Save replacement',exact:true}).click();
  await expect.poll(()=>writes).toBe(2);expect(modes).toEqual(['add','replace']);expect(await b.locator('input[name=value]').inputValue()).toBe('');
  await b.getByRole('checkbox',{name:'Always allow art when asked',exact:true}).click();
  await expect.poll(()=>b.getByRole('checkbox',{name:'Always allow art when asked',exact:true}).isChecked()).toBe(true);
  await expect.poll(()=>app.db.prepare("SELECT value FROM secrets_meta WHERE key='policy'").get()).toMatchObject({value:expect.stringContaining('art')});
  const result=app.operations.call('direct',{kind:'agent',id:'mark'},'secrets.requestHouse',{agent:'mark',target:'API',scope:{house:'h-22'},why:'Fixture deployment',minutes:30},randomUUID());expect(result.ok).toBe(true);
  await a.goto(`${app.url}/p/settings-preview/requests`);await expect.poll(()=>row(a,'mark: API').count()).toBe(1);await row(a,'mark: API').click();
  await a.getByRole('button',{name:'Allow once',exact:true}).click();
  await b.goto(`${app.url}/p/settings-preview/grants/mark`);await expect.poll(()=>b.getByRole('button',{name:'Revoke API',exact:true}).count()).toBe(1);
  expect(await b.getByText('h-22 · No service',{exact:true}).count()).toBe(1);
  expect(app.operations.call('direct',{kind:'member',id:'jonathan'},'secrets.grant',{agent:'mark',kind:'secret',target:'API',scope:{house:'h-23',service:'slack'},expiresAt:clock.now()+60*60_000},randomUUID()).ok).toBe(true);
  // Put the historical boundary 31 minutes ahead rather than advancing every
  // unrelated next-mode job through a year of fake time.
  const history=app.db.prepare('SELECT id,record FROM secrets_changes').all() as {id:string;record:string}[];
  for(const row of history)app.db.prepare('UPDATE secrets_changes SET record=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.record),at:clock.now()-365*86400_000+31*60_000}),row.id);
  app.live.changed(history.map(row=>({type:'secret.change',id:row.id})));
  const shots=process.env.LOOM_TEST_SHOTS??resolve('artifacts/settings-app');mkdirSync(shots,{recursive:true});
  await b.goto(`${app.url}/p/settings-preview/secrets/API`);await expect.poll(()=>b.getByRole('heading',{name:'Who may use it',exact:true}).count()).toBe(1);
  for(const look of ['neon','daylight'])for(const width of [390,1280,1920]){
   await b.setViewportSize({width,height:900});await b.reload();
   await expect.poll(()=>b.getByRole('heading',{name:'Who may use it',exact:true}).count()).toBe(1);
   await b.evaluate(look=>{document.documentElement.dataset.look=look;document.documentElement.dataset.mode=look==='daylight'?'light':'dark';document.documentElement.dataset.motion='reduce';},look);
   await expect.poll(()=>b.locator('.loom-split').getAttribute('data-mode')).toBe(width<640?'one':'three');
   await expect.poll(()=>b.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
   await b.screenshot({path:join(shots,`settings-${look}-${width}.png`),fullPage:true,animations:'disabled'});
  }
  expect(app.operations.call('direct',{kind:'member',id:'jonathan'},'secrets.policy',{default:'ask',secrets:{API:{grant:'never',houses:['art']}}},randomUUID()).ok).toBe(true);
  await expect.poll(()=>b.locator('body').textContent()).toContain('Blocked by Never policy');
  expect(app.operations.call('direct',{kind:'member',id:'jonathan'},'secrets.policy',{default:'ask',secrets:{}},randomUUID()).ok).toBe(true);
  clock.advance(30*60_000);
  await expect.poll(()=>b.locator('body').textContent()).toContain('Expired');
  clock.advance(60_000);
  await expect.poll(()=>row(b,'API').textContent()).toContain('Not changed in a year');
  expect(await b.locator('body').textContent()).not.toContain(sentinel);
  expect(await b.locator('body').innerHTML()).not.toContain(sentinel);
  for(const table of (app.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]))expect(JSON.stringify(app.db.prepare(`SELECT * FROM "${table.name}"`).all())).not.toContain(sentinel);
  await b.goto(`${app.url}/p/settings-preview/grants/mark`);await b.getByText('h-22 · No service',{exact:true}).locator('..').getByRole('button',{name:'Revoke API',exact:true}).click();
  await expect.poll(()=>b.getByRole('button',{name:'Revoke API',exact:true}).count()).toBe(1);
  expect(grantsRole(app.db).mayUse('mark',{kind:'secret',target:'API'},clock.now(),{house:'h-23',service:'slack'})).toBe(true);
  await context.addCookies([{name:'fixture',value:'pollock',url:app.url}]);await b.reload();
  await expect.poll(()=>b.getByText('Household owners manage Settings',{exact:true}).count()).toBe(1);
  expect(await row(b,'API').count()).toBe(0);expect(await b.getByRole('button',{name:'Save secret',exact:true}).count()).toBe(0);
 }finally{for(const value of values.values())value.fill(0);await browser.close();await app.close();rmSync(home,{recursive:true,force:true});}
},60_000);
