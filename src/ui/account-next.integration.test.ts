/** Account's one browser acceptance: actual sign-in, WebAuthn, two windows, six images; CI only. */
import { it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startLoom } from '../foundation.js';
import { fixture } from '../fixture.js';
import { FakeClock } from '../core/clock.js';
import { signin } from '../core/signin/index.js';
const root=resolve(import.meta.dirname,'../../dist/web');
const chrome=[process.env.LOOM_TEST_CHROME,'/usr/bin/google-chrome','/usr/bin/chromium',chromium.executablePath()].find(p=>p&&existsSync(p));
it.runIf(process.env.CI&&chrome&&existsSync(join(root,'next.html')))('Account registers/removes a passkey, signs out a browser and fits both looks across windows',async()=>{
  const home=mkdtempSync(join(tmpdir(),'account-browser-'));fixture(home);
  const clock=new FakeClock(Date.parse('2026-11-12T12:00:00Z'));
  const loom=await startLoom({home,next:true,staging:true,clock,webRoot:root});
  const base=loom.url.replace('127.0.0.1','localhost');vi.stubEnv('LOOM_PUBLIC_URL',base);
  const browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  try{
    const context=await browser.newContext({userAgent:'Mozilla/5.0 Chrome/128.0.0.0 Safari/537.36',viewport:{width:1280,height:1000},serviceWorkers:'block'}),otherContext=await browser.newContext({viewport:{width:1280,height:1000},serviceWorkers:'block'}),a=await context.newPage(),b=await otherContext.newPage();
    await a.addInitScript(()=>{
      let sub:unknown=null;
      const manager={getSubscription:async()=>sub,subscribe:async()=>{sub={toJSON:()=>({endpoint:'https://fcm.googleapis.com/account-browser-proof',expirationTime:null,keys:{p256dh:'p'.repeat(87),auth:'a'.repeat(22)}}),unsubscribe:async()=>{sub=null;return true;}};return sub;}};
      void manager.subscribe(); // Browser already holds a subscription when Account first opens.
      Object.defineProperty(navigator.serviceWorker,'getRegistration',{value:async()=>({pushManager:manager})});
      Object.defineProperty(window,'PushManager',{value:function(){}});
      Object.defineProperty(window,'Notification',{value:{permission:'granted',requestPermission:async()=> 'granted'}});
    });
    const errors:string[]=[];a.on('pageerror',e=>errors.push(e.message));b.on('pageerror',e=>errors.push(e.message));
    const cdp=await context.newCDPSession(a);await cdp.send('WebAuthn.enable');await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
    const link=loom.operations.call('direct',{kind:'member',id:'jonathan'},'signin.link',{member:'jonathan'});if(!link.ok)throw Error('Fixture sign-in failed');
    await a.goto(base+(link.value as {path:string}).path);const signedIn=a.waitForResponse(r=>r.request().method()==='POST');await a.getByRole('button',{name:'Sign in',exact:true}).click();expect((await signedIn).status()).toBe(303);
    const secondLink=loom.operations.call('direct',{kind:'member',id:'jonathan'},'signin.link',{member:'jonathan'});if(!secondLink.ok)throw Error('Second sign-in failed');
    await b.goto(base+(secondLink.value as {path:string}).path);const otherSignedIn=b.waitForResponse(r=>r.request().method()==='POST');await b.getByRole('button',{name:'Sign in',exact:true}).click();expect((await otherSignedIn).status()).toBe(303);
    await a.goto(base+'/p/account-preview');await b.goto(base+'/p/account-preview');
    const registration=a.getByRole('form',{name:'Add a passkey',exact:true});await expect.poll(()=>registration.getByRole('textbox').isEnabled()).toBe(true);
    await registration.getByRole('textbox').fill('Browser passkey');await registration.getByRole('button',{name:'Add a passkey',exact:true}).click();
    await expect.poll(()=>b.getByRole('form',{name:'Remove passkey Browser passkey',exact:true}).count()).toBe(1);
    const s=signin(loom),source=Object.values(s.sessions.read().sessions)[0].secret,temporary=s.createSession(source,{label:'Temporary browser'});
    loom.live.changed([{type:'core.access',id:'credentials'}]);
    const read=loom.operations.call('direct',{kind:'member',id:'jonathan'},'account.read',{});if(!read.ok)throw Error();
    const ref=(read.value as {sessions:Array<{ref:string;label?:string}>}).sessions.find(x=>x.label==='Temporary browser')!.ref;
    const end=a.getByRole('form',{name:`Sign out session ${ref}`,exact:true});await expect.poll(()=>end.count()).toBe(1);await end.getByRole('button').click();expect(s.session(temporary)).toBeDefined();
    await end.getByRole('checkbox').check();await end.getByRole('button').click();await expect.poll(()=>b.getByRole('form',{name:`Sign out session ${ref}`,exact:true}).count()).toBe(0);expect(s.session(temporary)).toBeUndefined();
    const notifications=a.getByRole('region',{name:'Notifications',exact:true});
    await expect.poll(()=>notifications.getByRole('button',{name:'Enable notifications on this browser',exact:true}).isEnabled()).toBe(true);
    await expect.poll(()=>notifications.textContent()).toContain('This browser: Enabled');
    await notifications.getByRole('button',{name:'Enable notifications on this browser',exact:true}).click();
    const deviceRead=()=>loom.operations.call('direct',{kind:'member',id:'jonathan'},'notifications.read',{});
    await expect.poll(()=>{const r=deviceRead();return r.ok?(r.value as {devices:unknown[]}).devices.length:0;}).toBe(1);
    await notifications.getByRole('button',{name:'Turn off notifications on this browser',exact:true}).click();
    await expect.poll(()=>notifications.textContent()).toContain('This browser: Off');
    await expect.poll(()=>notifications.getByRole('button',{name:'Enable notifications on this browser',exact:true}).isEnabled()).toBe(true);
    await notifications.getByRole('button',{name:'Enable notifications on this browser',exact:true}).click();
    await expect.poll(()=>notifications.textContent()).toContain('This browser: Enabled');
    const devices=deviceRead();if(!devices.ok)throw Error();const device=(devices.value as {devices:Array<{ref:string;session:string}>}).devices[0];
    const remote=b.getByRole('form',{name:`Remove notification device ${device.ref}`,exact:true});await expect.poll(()=>remote.count()).toBe(1);
    expect(await remote.textContent()).toContain(device.session);
    const shots=resolve('artifacts/household-account');mkdirSync(shots,{recursive:true});
    for(const look of ['neon','daylight'])for(const width of [390,1280,1920]){
      expect(loom.operations.call('direct',{kind:'member',id:'jonathan'},'household.setPreferences',{look},`account-look-${look}-${width}`).ok).toBe(true);
      await b.setViewportSize({width,height:1000});await b.reload();await expect.poll(()=>b.getByRole('form',{name:'Remove passkey Browser passkey',exact:true}).count()).toBe(1);await expect.poll(()=>b.locator('html').getAttribute('data-look')).toBe(look);
      await b.getByRole('region',{name:'Notifications',exact:true}).scrollIntoViewIfNeeded();expect(await b.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await b.screenshot({path:join(shots,`account-${look}-${width}.png`),fullPage:false,animations:'disabled'});
    }
    await remote.getByRole('button').click();expect(s.sessions.read().push?.subs?.['https://fcm.googleapis.com/account-browser-proof']).toBeDefined();
    await remote.getByRole('checkbox').check();await remote.getByRole('button').click();await expect.poll(()=>a.getByRole('form',{name:`Remove notification device ${device.ref}`,exact:true}).count()).toBe(0);
    await expect.poll(()=>notifications.textContent()).toContain('This browser: Off');
    const remove=a.getByRole('form',{name:'Remove passkey Browser passkey',exact:true});await remove.getByRole('button').click();expect(Object.keys(s.sessions.read().passkeys??{})).toHaveLength(1);
    await remove.getByRole('checkbox').check();await remove.getByRole('button').click();await expect.poll(()=>b.getByRole('form',{name:'Remove passkey Browser passkey',exact:true}).count()).toBe(0);expect(s.sessions.read().passkeys??{}).toEqual({});
    clock.advance(601_000);
    const deviceLink=a.getByRole('region',{name:'Sign in another device',exact:true});await deviceLink.getByRole('button',{name:'Make sign-in link',exact:true}).click();
    const value=deviceLink.locator('[data-signin-link]');await expect.poll(()=>value.count()).toBe(1);const url=(await value.textContent())!;
    await b.goto(url);await b.getByRole('button',{name:'Sign in',exact:true}).click();await b.goto(base+'/p/account-preview');
    const stale=b.getByRole('form',{name:'Add a passkey',exact:true});await expect.poll(()=>stale.getByRole('textbox').isEnabled()).toBe(true);await stale.getByRole('textbox').fill('Must refuse');await stale.getByRole('button',{name:'Add a passkey',exact:true}).click();await expect.poll(()=>stale.getByRole('status').textContent()).toBe('Sign in again before adding a passkey');expect(s.sessions.read().passkeys??{}).toEqual({});
    await deviceLink.getByRole('button',{name:'Hide sign-in link',exact:true}).click();expect(await value.count()).toBe(0);
    await a.getByRole('button',{name:'Sign out this device',exact:true}).click();
    await expect.poll(()=>a.getByRole('button',{name:'Sign in with a passkey',exact:true}).count()).toBe(1);expect((await (await context.request.get(base+'/auth/session')).json()).viewer).toBeNull();expect((await (await otherContext.request.get(base+'/auth/session')).json()).viewer).toEqual({kind:'member',id:'jonathan'});
    expect(errors).toEqual([]);await context.close();await otherContext.close();
  }finally{await browser.close();await loom.close();vi.unstubAllEnvs();rmSync(home,{recursive:true,force:true});}
},90_000);
