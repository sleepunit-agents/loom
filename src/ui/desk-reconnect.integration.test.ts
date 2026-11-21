import {endBrowser} from '../core/signin/shared-browser.js';
import {credentialFingerprint} from '../core/data/authentication.js';
import {it,expect} from 'vitest';
import {chromium} from 'playwright-core';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {exampleHome} from '../example-home.js';
import {startSharedHome} from '../shared-startup.js';

it.runIf(process.env.LOOM_TEST_CHROME)('an open desk gets current data after the server restarts and several upgrades fail',async()=>{
  const temp=await mkdtemp(join(tmpdir(),'loom-desk-reconnect-')),home=join(temp,'home');
  const start=(port:number)=>startSharedHome({home,port,webRoot:resolve('dist/web'),stdout:()=>{}});
  let server:Awaited<ReturnType<typeof start>>|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  try{
    await exampleHome(home);server=await start(0);
    const port=Number(new URL(server.url).port);
    browser=await chromium.launch({executablePath:process.env.LOOM_TEST_CHROME});
    const context=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce'});
    await context.addInitScript(()=>{
      const native=window.WebSocket;
      window.WebSocket=class extends native {
        constructor(url:string|URL,protocols?:string|string[]){
          super(url,protocols);
          this.addEventListener('message',event=>{
            if(sessionStorage.getItem('fixture-drop-pong')&&typeof event.data==='string'&&JSON.parse(event.data).type==='pong')
              event.stopImmediatePropagation();
          });
        }
      };
    });
    const page=await context.newPage();
    await page.clock.install();
    const sockets:string[]=[];page.on('websocket',ws=>sockets.push(ws.url()));
    await page.goto(server.signinLink());await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await page.locator('.next-shell').waitFor();
    await page.goto(server.url+'/p/setup-preview');
    const description=page.getByRole('form',{name:'Save appearance for fern'}).getByLabel('Description');
    await description.waitFor();
    const documentStart=await page.evaluate(()=>performance.timeOrigin);
    const before=sockets.length;
    await server.close();server=undefined;
    await expect.poll(()=>sockets.length,{timeout:30_000}).toBeGreaterThanOrEqual(before+3);
    // Advance through several capped backoffs while the listener is still gone.
    for(let attempt=0;attempt<8;attempt++){
      const count=sockets.length;
      await page.clock.fastForward(16_000);
      await expect.poll(()=>sockets.length,{timeout:3_000}).toBeGreaterThan(count);
    }
    expect(await description.count()).toBe(0);
    server=await start(port);
    server.writes.run(()=>server!.services.comms!.db.$client.prepare('update agents set about=? where id=?').run('Live after the restart','fern'));
    await expect.poll(()=>description.inputValue({timeout:500}).catch(()=>''),{timeout:30_000}).toBe('Live after the restart');
    expect(await page.evaluate(()=>performance.timeOrigin)).toBe(documentStart);
    server.writes.run(()=>server!.services.comms!.db.$client.prepare('update agents set about=? where id=?').run('Still subscribed','fern'));
    await expect.poll(()=>description.inputValue()).toBe('Still subscribed');
    const beforeSilence=sockets.length;
    await page.evaluate(()=>sessionStorage.setItem('fixture-drop-pong','yes'));
    await expect.poll(()=>sockets.length,{timeout:45_000}).toBeGreaterThan(beforeSilence);
    await page.evaluate(()=>sessionStorage.removeItem('fixture-drop-pong'));
    server.writes.run(()=>server!.services.comms!.db.$client.prepare('update agents set about=? where id=?').run('Live after silence','fern'));
    await expect.poll(()=>description.inputValue({timeout:500}).catch(()=>'')).toBe('Live after silence');
    expect(await page.evaluate(()=>performance.timeOrigin)).toBe(documentStart);
    const cookie=(await context.cookies()).find(c=>c.name==='loom_ui')!;
    server.writes.run(()=>endBrowser(server!.services.comms!.db,credentialFingerprint(cookie.value)));
    await page.getByRole('button',{name:'Sign in with a passkey'}).waitFor({timeout:20_000});
    expect(await description.count()).toBe(0);
  }finally{await browser?.close();await server?.close();await rm(temp,{recursive:true,force:true});}
},90_000);
