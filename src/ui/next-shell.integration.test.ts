/** The one browser test for the shell: real next listener, fake clock, two windows. */
import { it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startLoom } from '../foundation.js';
import { FakeClock } from '../core/clock.js';
import { fixture, installFixture, fixtureSharing } from '../fixture.js';
const root = resolve(import.meta.dirname,'../../dist/web');
const chrome = [process.env.LOOM_TEST_CHROME,'/usr/bin/google-chrome','/usr/bin/chromium',chromium.executablePath()].find(p=>p&&existsSync(p));
it.runIf(chrome && existsSync(join(root,'next.html')))('next desk restores app paths, phones show one pane, and windows share live records',async()=>{
  const home=mkdtempSync(join(tmpdir(),'loom-next-browser-'));fixture(home);
  const loom=await startLoom({home,next:true,staging:true,clock:new FakeClock(Date.parse('2026-11-12T12:00:00Z')),install:installFixture,sharing:fixtureSharing,webRoot:root,
    authenticate:req=>req.headers.cookie?.includes('fixture=jonathan')?{viewer:{kind:'member',id:'jonathan'},valid:()=>true}:undefined});
  const browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  try {
    const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'});
    await context.addCookies([{name:'fixture',value:'jonathan',url:loom.url}]);
    const a=await context.newPage(); const b=await context.newPage();
    const errors:string[]=[];a.on('pageerror',e=>errors.push(e.message));
    await a.goto(loom.url);
    await expect.poll(()=>a.getByRole('button',{name:'Open Project sharing',exact:true}).count()).toBe(1);
    await a.getByRole('button',{name:'Open Tasks',exact:true}).click();
    await expect.poll(()=>a.locator('[data-split-row]').filter({hasText:'Pond work'}).count()).toBe(1);
    await a.locator('[data-split-row]').filter({hasText:'Pond work'}).click();
    await a.getByRole('button',{name:'Open Live example',exact:true}).click();
    await expect.poll(()=>a.locator('[data-tile]').count()).toBe(2);
    const tasks=await a.locator('[data-tile=tasks]').boundingBox();const example=await a.locator('[data-tile=example]').boundingBox();
    expect(tasks!.x+tasks!.width).toBeLessThan(example!.x);
    await a.reload();
    await expect.poll(()=>a.locator('[data-tile]').count()).toBe(2);
    await expect.poll(()=>a.getByRole('heading',{name:'Pond work',exact:true}).count()).toBe(1);
    await b.goto(a.url());
    await expect.poll(()=>b.getByRole('button',{name:'Add record',exact:true}).isEnabled()).toBe(true);
    await a.getByRole('textbox',{name:'Title',exact:true}).fill('Two windows on the next desk');
    await a.getByRole('button',{name:'Add record',exact:true}).click();
    await expect.poll(()=>b.getByText('Two windows on the next desk',{exact:true}).count()).toBe(1);
    await a.getByRole('textbox',{name:'Title',exact:true}).fill('An unsent draft');
    await a.getByRole('button',{name:'Minimize Live example',exact:true}).click();
    await a.getByRole('button',{name:'Open Live example',exact:true}).click();
    expect(await a.getByRole('textbox',{name:'Title',exact:true}).inputValue()).toBe('An unsent draft');
    await a.getByRole('button',{name:'Make Live example big',exact:true}).focus();
    await a.keyboard.press('Alt+Shift+Enter');
    await expect.poll(()=>a.locator('[data-tile]').first().getAttribute('data-tile')).toBe('example');
    await a.keyboard.press('Alt+h');await expect.poll(()=>a.locator('[data-tile]').count()).toBe(0);
    await a.getByRole('button',{name:'Home',exact:true}).click();await expect.poll(()=>a.locator('[data-tile]').count()).toBe(2);
    expect(await a.getByRole('textbox',{name:'Title',exact:true}).inputValue()).toBe('An unsent draft');
    const shots=process.env.LOOM_TEST_SHOTS??resolve('artifacts/next-shell');mkdirSync(shots,{recursive:true});
    for (const look of ['neon','daylight']) for(const width of [390,1280,1920]) {
      await b.setViewportSize({width,height:900});await b.reload();
      await expect.poll(()=>b.locator('.next-shell').getAttribute('data-shell')).toBe(width<1024?'phone':'desk');
      await expect.poll(()=>b.getByText('Two windows on the next desk',{exact:true}).count()).toBe(1);
      expect(await b.locator('[data-tile]').count()).toBe(width<1024?1:2);
      await b.evaluate(look=>{document.documentElement.dataset.look=look;document.documentElement.dataset.mode=look==='daylight'?'light':'dark';document.documentElement.dataset.motion='reduce';},look);
      await b.screenshot({path:join(shots,`next-${look}-${width}.png`),fullPage:true,animations:'disabled'});
    }
    expect(errors).toEqual([]);
    await context.close();
  } finally {await browser.close();await loom.close();rmSync(home,{recursive:true,force:true});}
},60_000);
