import webpush from 'web-push';
/** One Account browser proof through the actual shared program; CI owns Chrome. */
import {it,expect} from 'vitest';
import Database from 'better-sqlite3';
import {createServer} from 'node:http';
import {sharedSigninLinks} from '../core/signin/shared-links.js';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {FakeClock} from '../core/clock.js';
import {createDataSchema} from '../core/data/database.js';
import {members,tokens,sessions,passkeys,signinLinks} from '../core/data/schema.js';
import {serveShared} from '../shared-serve.js';
const enabled=process.env.LOOM_DESK_EVIDENCE==='1',chrome=process.env.LOOM_TEST_CHROME,webRoot=resolve('dist/web');
if(enabled&&(!chrome||!existsSync(chrome)||!existsSync(join(webRoot,'next.html'))))throw Error('Account evidence needs Chrome and the built app');
it.runIf(enabled)('Account shows personal shared metadata, removes passkeys live and signs another browser out over the one door',async()=>{
 const client=new Database(':memory:'),clock=new FakeClock(),now=()=>new Date(clock.now()).toISOString(),db=createDataSchema(client,now),hash=(value:string)=>createHash('sha256').update(value).digest('hex'),cookie='c'.repeat(64);
 db.insert(members).values({id:'sam',role:'member',joinedAt:now()}).run();
 db.insert(tokens).values({fingerprint:hash('a'.repeat(64)),kind:'owner',member:'sam',label:'Sam',createdAt:now()}).run();
 db.insert(sessions).values([{id:hash(cookie),token:hash('a'.repeat(64)),device:'Current browser',via:'link',isAgent:false,issuedAt:now(),seenAt:now(),provedAt:now()},{id:hash('d'.repeat(64)),token:hash('a'.repeat(64)),device:'Kitchen tablet',via:'link',isAgent:false,issuedAt:now(),seenAt:now(),provedAt:now()}]).run();
 db.insert(passkeys).values({id:'fixture-key',token:hash('a'.repeat(64)),label:'Fixture laptop',publicKey:'unused-public-half',counter:0,createdAt:now()}).run();
 const app=await serveShared({db,clock,webRoot,notifications:{vapid:webpush.generateVAPIDKeys(),send:async()=>{}},originAllowed:()=>true,reportError:error=>{throw error;}}),browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
 try{
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900},userAgent:'Fixture notification browser'});
  await context.addInitScript(()=>{Object.defineProperty(Notification,'requestPermission',{value:async()=> 'granted'});Object.defineProperty(navigator.serviceWorker,'ready',{value:Promise.resolve({pushManager:{getSubscription:async()=>null,subscribe:async()=>({endpoint:'https://fcm.googleapis.com/browser-proof',toJSON:()=>({keys:{p256dh:'p'.repeat(87),auth:'a'.repeat(22)}})})}})});});
  await context.addCookies([{name:'loom_ui',value:cookie,url:app.url}]);
  const a=await context.newPage(),b=await context.newPage(),errors:string[]=[];let legacy=0;
  for(const page of [a,b]){page.on('pageerror',error=>errors.push(error.message));page.on('websocket',socket=>{if(new URL(socket.url()).pathname==='/live')legacy++;});}
  await a.goto(app.url+'/p/account-preview');await b.goto(app.url+'/p/account-preview');
  for(const page of [a,b])await expect.poll(()=>page.getByRole('heading',{name:'Fixture laptop',exact:true}).count()).toBe(1);
  await a.getByRole('button',{name:'Remove passkey',exact:true}).click();
  await expect.poll(()=>b.getByRole('heading',{name:'Fixture laptop',exact:true}).count()).toBe(0);expect(db.select().from(passkeys).all()).toEqual([]);
  const tablet=a.getByRole('heading',{name:'Kitchen tablet',exact:true}).locator('..');
  await tablet.getByRole('button',{name:'Sign out browser',exact:true}).click();
  await expect.poll(()=>b.getByRole('heading',{name:'Kitchen tablet',exact:true}).count()).toBe(0);expect(db.select().from(sessions).all()).toHaveLength(1);
  await a.getByRole('button',{name:'Make sign-in link',exact:true}).click();await expect.poll(()=>a.getByRole('status').last().textContent()).toContain('/login/');
  await a.getByRole('button',{name:'Hide sign-in link',exact:true}).click();await a.locator('[data-signin-link]').waitFor({state:'hidden'});
  await a.getByRole('button',{name:'Enable notifications on this browser',exact:true}).click();
  await expect.poll(()=>b.getByRole('heading',{name:'Fixture notification browser',exact:true}).count()).toBe(1);
  await b.getByRole('button',{name:'Remove notification device',exact:true}).click();
  await expect.poll(()=>a.getByRole('heading',{name:'Fixture notification browser',exact:true}).count()).toBe(0);
  const shots=resolve('artifacts/household-account');mkdirSync(shots,{recursive:true});
  await a.screenshot({path:join(shots,'account-shared.png'),animations:'disabled',mask:[a.locator('[data-signin-link]')]});
  expect(legacy).toBe(0);expect(errors).toEqual([]);
 }catch(error){throw Error(String(error).replace(/\/login\/[a-zA-Z0-9_-]+/g,'/login/[redacted]'));}
 finally{await browser.close();await app.close();client.close();}
});

it.runIf(enabled)('registers and uses a real browser passkey against the shared sign-in door',async()=>{
 // Reserve a disposable loopback port so the RP origin is known before Root.
 const reservation=createServer();await new Promise<void>(resolve=>reservation.listen(0,'127.0.0.1',resolve));
 const address=reservation.address();if(!address||typeof address==='string')throw Error('No fixture port');
 const port=address.port;await new Promise<void>(resolve=>reservation.close(()=>resolve()));
 const origin=`http://localhost:${port}`,client=new Database(':memory:'),clock=new FakeClock(),at=new Date(clock.now()).toISOString(),db=createDataSchema(client,()=>new Date(clock.now()).toISOString()),raw='f'.repeat(64),hash=(value:string)=>createHash('sha256').update(value).digest('hex');
 db.insert(members).values({id:'sam',role:'member',joinedAt:at}).run();db.insert(tokens).values({fingerprint:hash(raw),kind:'owner',member:'sam',label:'Sam browser fixture',createdAt:at}).run();
 db.insert(members).values({id:'other',role:'member',joinedAt:at}).run();db.insert(tokens).values({fingerprint:hash('g'.repeat(64)),kind:'owner',member:'other',label:'Other member fixture',createdAt:at}).run();
 const app=await serveShared({db,clock,port,publicOrigin:origin,webRoot,originAllowed:()=>true,reportError:error=>{throw error;}});
 let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined,trap:ReturnType<typeof createServer>|undefined;
 try{
  browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  // This proof represents a person; separate route tests exercise headless six-hour sessions.
  const context=await browser.newContext({serviceWorkers:'block',userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'});
  let blockedHttp=0,blockedSocket=0,trapped=0;
  trap=createServer((_request,response)=>{trapped++;response.end('Disposable isolation trap');});trap.on('upgrade',(_request,socket)=>{trapped++;socket.destroy();});
  await new Promise<void>(resolve=>trap!.listen(0,'127.0.0.1',resolve));const trapAddress=trap.address();if(!trapAddress||typeof trapAddress==='string')throw Error('No trap port');
  const trapOrigin=`http://127.0.0.1:${trapAddress.port}`;
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();blockedHttp++;return route.abort('blockedbyclient');});
  await context.routeWebSocket(url=>new URL(url).origin!==origin.replace(/^http/,'ws'),socket=>{blockedSocket++;socket.close();});
  // A blocked navigation starts Chrome's error page asynchronously. Keep it
  // on a disposable probe page, separate from the real credential ceremony.
  const probe=await context.newPage();
  await probe.evaluate(url=>new Promise<void>(resolve=>{const socket=new WebSocket(url);socket.onclose=()=>resolve();socket.onerror=()=>resolve();}),trapOrigin.replace(/^http/,'ws'));
  expect(blockedSocket).toBe(1);
  await probe.goto(trapOrigin).catch(()=>{});expect(blockedHttp).toBe(1);expect(trapped).toBe(0);await probe.close();
  const page=await context.newPage(),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const cdp=await context.newCDPSession(page);await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
  // Genuine one-time link redemption; no browser cookie is seeded.
  const link=app.writes.run(()=>sharedSigninLinks(db,clock).makeLink(hash(raw))).value;
  await page.goto(origin+link.path);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.locator('.next-shell').waitFor();
  expect(db.select().from(signinLinks).all()).toEqual([]);expect(db.select().from(sessions).all()).toMatchObject([{token:hash(raw),via:'link',isAgent:false}]);
  expect((await context.request.post(origin+link.path)).status()).toBe(401);
  await page.goto(origin+'/p/account-preview');
  const form=page.getByRole('form',{name:'Add a passkey',exact:true});await form.getByLabel('Passkey name',{exact:true}).fill('Virtual laptop');await form.getByRole('button',{name:'Add a passkey',exact:true}).click();
  await page.getByRole('heading',{name:'Virtual laptop',exact:true}).waitFor();
  expect(db.select().from(passkeys).all()).toMatchObject([{label:'Virtual laptop',token:hash(raw)}]);
  const registeredCounter=db.select().from(passkeys).get()!.counter;expect(registeredCounter).toBeGreaterThanOrEqual(0);
  await page.getByRole('button',{name:'Sign out this device',exact:true}).click();await page.getByRole('button',{name:'Sign in with a passkey',exact:true}).waitFor();
  expect(db.select().from(sessions).all()).toEqual([]);
  await page.getByRole('button',{name:'Sign in with a passkey',exact:true}).click();await page.locator('.next-shell').waitFor();
  await page.goto(origin+'/p/account-preview');await page.getByRole('heading',{name:'Virtual laptop',exact:true}).waitFor();
  expect(db.select().from(sessions).all()).toMatchObject([{token:hash(raw),via:'passkey',isAgent:false}]);expect(db.select().from(passkeys).get()!.counter).toBeGreaterThan(registeredCounter);
  const body=await page.locator('body').innerText();expect(body.includes(raw)).toBe(false);expect(body.includes(link.path)).toBe(false);
  const shots=resolve('artifacts/household-account');mkdirSync(shots,{recursive:true});await page.screenshot({path:join(shots,'passkey-shared.png'),animations:'disabled',mask:[page.locator('[data-signin-link]')]});
  await page.getByRole('button',{name:'Remove passkey',exact:true}).click();await expect.poll(()=>db.select().from(passkeys).all().length).toBe(0);await page.getByRole('heading',{name:'Virtual laptop',exact:true}).waitFor({state:'hidden'});
  expect(errors).toEqual([]);
 }catch(error){throw Error(String(error).replace(/\/login\/[a-zA-Z0-9_-]+/g,'/login/[redacted]'));}
 finally{await browser?.close();await app.close();if(trap)await new Promise<void>(resolve=>trap!.close(()=>resolve()));client.close();}
});
