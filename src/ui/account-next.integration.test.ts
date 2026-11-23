import webpush from 'web-push';
import {writeAccountProof} from '../../scripts/rebuild-account-proof.mjs';
/** One Account browser proof through the actual shared program; CI owns Chrome. */
vi.mock('../core/signin/push-transport.js',()=>({pushTransport:()=>{throw Error('External push delivery is forbidden in this proof');}}));
import {accountEvidenceError} from '../../scripts/rebuild-account-evidence-errors.mjs';
import {runInNewContext} from 'node:vm';
import {it,expect,vi} from 'vitest';
import Database from 'better-sqlite3';
import {createServer} from 'node:http';
import {sharedSigninLinks} from '../core/signin/shared-links.js';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {FakeClock} from '../core/clock.js';
import {createDataSchema} from '../core/data/database.js';
import {members,tokens,sessions,passkeys,signinLinks} from '../core/data/schema.js';
import {serveShared} from '../shared-serve.js';
const enabled=process.env.LOOM_DESK_EVIDENCE==='1',chrome=process.env.LOOM_TEST_CHROME,webRoot=resolve('dist/web');
if(enabled&&(!chrome||!existsSync(chrome)||!existsSync(join(webRoot,'next.html'))))throw Error('Account evidence needs Chrome and the built app');
it.runIf(enabled)('Account shows personal shared metadata, removes passkeys live and signs other and current browsers out over the one door',async()=>{
 rmSync(resolve('artifacts/household-account/account-session.json'),{force:true});
 const client=new Database(':memory:'),clock=new FakeClock(),now=()=>new Date(clock.now()).toISOString(),db=createDataSchema(client,now),hash=(value:string)=>createHash('sha256').update(value).digest('hex'),cookie='c'.repeat(64);
 db.insert(members).values({id:'sam',role:'member',joinedAt:now()}).run();
 db.insert(tokens).values({fingerprint:hash('a'.repeat(64)),kind:'owner',member:'sam',label:'Sam',createdAt:now()}).run();
 db.insert(sessions).values([{id:hash(cookie),token:hash('a'.repeat(64)),device:'Current browser',via:'link',isAgent:false,issuedAt:now(),seenAt:now(),provedAt:now()},{id:hash('d'.repeat(64)),token:hash('a'.repeat(64)),device:'Kitchen tablet',via:'link',isAgent:false,issuedAt:now(),seenAt:now(),provedAt:now()}]).run();
 db.insert(passkeys).values({id:'fixture-key',token:hash('a'.repeat(64)),label:'Fixture laptop',publicKey:'unused-public-half',counter:0,createdAt:now()}).run();
 const delivered:Array<{title:string;body:string;url:string}>=[],settled:string[][]=[],pushes:Array<{endpoint:string;payload:string}>=[],pushErrors:unknown[]=[];let receive:((payload:string)=>Promise<void>)|undefined;
 const app=await serveShared({db,clock,webRoot,tempo:{notify:(_member,ids)=>{settled.push([...ids]);return true;}},notifications:{vapid:webpush.generateVAPIDKeys(),send:async(sub,payload)=>{pushes.push({endpoint:sub.endpoint,payload:String(payload)});try{if(!receive)throw Error('Notification receiver not ready');await receive(String(payload));}catch(error){pushErrors.push(error);throw error;}}},originAllowed:()=>true,reportError:error=>{throw error;}}),browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
 try{
  const handlers:Record<string,(event:unknown)=>void>={};const worker=await (await fetch(app.url+'/sw.js')).text();
  runInNewContext(worker,{URL,location:{origin:app.url},self:{addEventListener:(name:string,handler:(event:unknown)=>void)=>{handlers[name]=handler;},registration:{showNotification:async(title:string,options:{body:string;data:{url:string}})=>{delivered.push({title,body:options.body,url:options.data.url});}}}});
  receive=async payload=>{let work:Promise<void>|undefined;handlers.push({data:{json:()=>JSON.parse(payload)},waitUntil:(pending:Promise<void>)=>{work=pending;}});if(!work)throw Error('Served worker did not handle push');await work;};
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900},userAgent:'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36'});
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
  await a.getByRole('button',{name:'Make sign-in link',exact:true}).click();await a.locator('[data-signin-link]').waitFor();expect(await a.locator('[data-signin-link]').evaluate(el=>new URL(el.textContent!).pathname.startsWith('/login/'))).toBe(true);
  await a.getByRole('button',{name:'Hide sign-in link',exact:true}).click();await a.locator('[data-signin-link]').waitFor({state:'hidden'});
  await a.getByRole('button',{name:'Enable notifications on this browser',exact:true}).click();
  await expect.poll(()=>b.getByRole('heading',{name:'Chrome on Android',exact:true}).count()).toBe(1);
  app.writes.run(()=>app.services.conversations.send({toKind:'person',to:'sam',member:'sam',source:'notice',fromKind:'unknown',words:'PRIVATE NOTIFICATION PROOF WORDS'}));clock.advance(5000);
  await expect.poll(()=>delivered.length).toBe(1);expect(settled.length).toBe(1);expect(pushErrors).toEqual([]);expect(pushes).toEqual([{endpoint:'https://fcm.googleapis.com/browser-proof',payload:JSON.stringify({title:'loom',body:'',tag:'loom-inbox',url:'/p/inbox-preview'})}]);expect(delivered).toEqual([{title:'loom',body:'',url:app.url+'/p/inbox-preview'}]);
  await b.getByRole('button',{name:'Remove notification device',exact:true}).click();
  await expect.poll(()=>a.getByRole('heading',{name:'Chrome on Android',exact:true}).count()).toBe(0);
  app.writes.run(()=>app.services.conversations.send({toKind:'person',to:'sam',member:'sam',source:'notice',fromKind:'unknown',words:'PRIVATE AFTER DISABLE'}));clock.advance(5000);await app.services.notifications!.publish('sam',[]);expect(settled.length).toBe(2);expect(pushErrors).toEqual([]);expect(pushes).toHaveLength(1);expect(delivered).toHaveLength(1);
  const shots=resolve('artifacts/household-account');mkdirSync(shots,{recursive:true});
  await a.screenshot({path:join(shots,'account-shared.png'),animations:'disabled',mask:[a.locator('[data-signin-link]')]});
  const self=a.getByRole('heading',{name:'Current browser',exact:true}).locator('..');await self.getByRole('button',{name:'Sign out browser',exact:true}).click();
  await a.getByRole('button',{name:'Sign in with a passkey',exact:true}).waitFor();expect(await a.locator('body').innerText()).not.toContain('Could not');expect(db.select().from(sessions).all()).toEqual([]);expect((await context.request.get(app.url+'/auth/session')).ok()).toBe(true);expect(await (await context.request.get(app.url+'/auth/session')).json()).toMatchObject({viewer:null});
  expect(legacy).toBe(0);expect(errors).toEqual([]);
 }catch(error){throw Error(String(error).replace(/\/login\/[a-zA-Z0-9_-]+/g,'/login/[redacted]'));}
 finally{await browser.close();await app.close();client.close();}
 writeAccountProof(resolve('artifacts/household-account/account-session.json'),{completed:true,anotherBrowserRevoked:true,notificationEnabled:true,notificationDispatched:true,servedWorkerDisplayed:true,privateWordsExcluded:true,notificationRemoved:true,noDispatchAfterRemoval:true,currentBrowserRevoked:true,signInScreenRestored:true,identityConfirmedSignedOut:true,oneTimeLinkMadeAndHidden:true});
});

it.runIf(enabled)('registers and uses a real browser passkey against the shared sign-in door',async()=>{
 rmSync(resolve('artifacts/household-account/passkey.json'),{force:true});
 // Reserve a disposable loopback port so the RP origin is known before Root.
 const reservation=createServer();await new Promise<void>(resolve=>reservation.listen(0,'127.0.0.1',resolve));
 const address=reservation.address();if(!address||typeof address==='string')throw Error('No fixture port');
 const port=address.port;await new Promise<void>(resolve=>reservation.close(()=>resolve()));
 const origin=`http://localhost:${port}`,client=new Database(':memory:'),clock=new FakeClock(),at=new Date(clock.now()).toISOString(),db=createDataSchema(client,()=>new Date(clock.now()).toISOString()),raw='f'.repeat(64),hash=(value:string)=>createHash('sha256').update(value).digest('hex');
 db.insert(members).values({id:'sam',role:'member',joinedAt:at}).run();db.insert(tokens).values({fingerprint:hash(raw),kind:'owner',member:'sam',label:'Sam browser fixture',createdAt:at}).run();
 db.insert(members).values({id:'other',role:'member',joinedAt:at}).run();db.insert(tokens).values({fingerprint:hash('g'.repeat(64)),kind:'owner',member:'other',label:'Other member fixture',createdAt:at}).run();
 const app=await serveShared({db,clock,port,publicOrigin:origin,webRoot,originAllowed:()=>true,reportError:error=>{throw error;}});
 let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined,trap:ReturnType<typeof createServer>|undefined;let privateCredentialKey='',failed=false;
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
  // A blocked navigation can still be committing Chrome's error document.
  // Retire that probe page before starting the independent socket/passkey proof.
  const trapPage=await context.newPage();
  try{await trapPage.goto(trapOrigin).catch(()=>{});expect(blockedHttp).toBe(1);}
  finally{await trapPage.close();}
  const page=await context.newPage(),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.evaluate(url=>new Promise<void>(resolve=>{const socket=new WebSocket(url);socket.onclose=()=>resolve();socket.onerror=()=>resolve();}),trapOrigin.replace(/^http/,'ws'));
  expect(blockedSocket).toBe(1);expect(trapped).toBe(0);
  const cdp=await context.newCDPSession(page);await cdp.send('WebAuthn.enable');
  const {authenticatorId}=await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
  // Genuine one-time link redemption; no browser cookie is seeded.
  const link=app.writes.run(()=>sharedSigninLinks(db,clock).makeLink(hash(raw))).value;
  await page.goto(origin+link.path);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.locator('.next-shell').waitFor();
  expect(db.select().from(signinLinks).all()).toEqual([]);expect(db.select().from(sessions).all()).toMatchObject([{token:hash(raw),via:'link',isAgent:false}]);
  expect((await context.request.post(origin+link.path)).status()).toBe(401);
  await page.goto(origin+'/p/account-preview');
  await page.locator('.loom-desk-boot').waitFor({state:'hidden'});
  const form=page.getByRole('form',{name:'Add a passkey',exact:true});await form.getByLabel('Passkey name',{exact:true}).fill('Virtual laptop');await form.getByRole('button',{name:'Add a passkey',exact:true}).click();
  await page.getByRole('heading',{name:'Virtual laptop',exact:true}).waitFor();
  expect(db.select().from(passkeys).all()).toMatchObject([{label:'Virtual laptop',token:hash(raw)}]);
  const registeredCounter=db.select().from(passkeys).get()!.counter;expect(registeredCounter).toBeGreaterThanOrEqual(0);
  await page.getByRole('button',{name:'Sign out this device',exact:true}).click();await page.getByRole('button',{name:'Sign in with a passkey',exact:true}).waitFor();
  expect(db.select().from(sessions).all()).toEqual([]);
  await page.getByRole('button',{name:'Sign in with a passkey',exact:true}).click();await page.locator('.next-shell').waitFor();
  await page.goto(origin+'/p/account-preview');await page.getByRole('heading',{name:'Virtual laptop',exact:true}).waitFor();
  expect(db.select().from(sessions).all()).toMatchObject([{token:hash(raw),via:'passkey',isAgent:false}]);expect(db.select().from(passkeys).get()!.counter).toBeGreaterThan(registeredCounter);
  const rememberedCounter=db.select().from(passkeys).get()!.counter;
  const {credentials}=await cdp.send('WebAuthn.getCredentials',{authenticatorId});expect(credentials.length).toBe(1);const credential=credentials[0];privateCredentialKey=credential.privateKey;
  const setCounter=async(signCount:number)=>{await cdp.send('WebAuthn.removeCredential',{authenticatorId,credentialId:credential.credentialId});await cdp.send('WebAuthn.addCredential',{authenticatorId,credential:{...credential,signCount}});};
  await page.getByRole('button',{name:'Sign out this device',exact:true}).click();await page.getByRole('button',{name:'Sign in with a passkey',exact:true}).waitFor();
  await setCounter(0);const rejected=page.waitForResponse(response=>new URL(response.url()).pathname==='/login/passkey');void rejected.catch(()=>{});await page.getByRole('button',{name:'Sign in with a passkey',exact:true}).click();expect((await rejected).status()).toBe(401);
  expect(db.select().from(sessions).all()).toEqual([]);expect(db.select().from(passkeys).get()!.counter).toBe(rememberedCounter);await page.getByRole('button',{name:'Sign in with a passkey',exact:true}).waitFor();
  await setCounter(rememberedCounter);await page.getByRole('button',{name:'Sign in with a passkey',exact:true}).click();await page.locator('.next-shell').waitFor();await page.goto(origin+'/p/account-preview');await page.getByRole('heading',{name:'Virtual laptop',exact:true}).waitFor();expect(db.select().from(sessions).all()).toMatchObject([{via:'passkey',token:hash(raw)}]);expect(db.select().from(passkeys).get()!.counter).toBeGreaterThan(rememberedCounter);
  const body=await page.locator('body').innerText();expect(body.includes(raw)).toBe(false);expect(body.includes(link.path)).toBe(false);
  const shots=resolve('artifacts/household-account');mkdirSync(shots,{recursive:true});await page.screenshot({path:join(shots,'passkey-shared.png'),animations:'disabled',mask:[page.locator('[data-signin-link]')]});
  await page.getByRole('button',{name:'Remove passkey',exact:true}).click();await expect.poll(()=>db.select().from(passkeys).all().length).toBe(0);await page.getByRole('heading',{name:'Virtual laptop',exact:true}).waitFor({state:'hidden'});
  expect(errors).toEqual([]);
 }catch(error){failed=true;throw accountEvidenceError(error,privateCredentialKey);}
 finally{let cleanupError:unknown;for(const close of [()=>browser?.close(),()=>app.close(),()=>trap?new Promise<void>(resolve=>trap!.close(()=>resolve())):undefined,()=>client.close()]){try{await close();}catch(error){cleanupError??=error;}}if(cleanupError&&!failed)throw accountEvidenceError(cleanupError,privateCredentialKey);}
 writeAccountProof(resolve('artifacts/household-account/passkey.json'),{completed:true,realPasskeyRegistered:true,realPasskeySignin:true,counterIncreased:true,copiedCounterRejected:true,noSessionAfterCopiedCounter:true,restoredCounterSignin:true,passkeyRemoved:true,oneTimeLinkRedeemedOnce:true,deviceLogout:true});
});
