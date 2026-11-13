import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { startLoom } from './foundation.js';
import { FakeClock } from './core/clock.js';
import { HouseholdDatabase } from './core/household/document.js';
import { TokenDatabase } from './core/household/tokens.js';
import { SessionStore, SESSION_MAX_AGE_S } from './ui/sessions.js';
import { SessionDatabase } from './ui/session-db.js';
import { nextCredentials } from './next-auth.js';
import type { IncomingMessage } from 'node:http';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'next-signin-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const clock = new FakeClock();
  const options = { home, next: true, clock, publicUrl: 'https://loom.test' };
  let loom = await startLoom(options);
  cleanup.push(() => loom.close());
  loom.db.transaction(() => {
    new HouseholdDatabase(loom.db).replace(home, { v: 1, agents: ['art'], default: 'art', owner: 'jonathan', members: [{ person: 'jonathan', role: 'owner', agents: '*' }] });
    new TokenDatabase(loom.db).replace({ v: 1, tokens: [
      { label: 'owner', role: 'owner', sha256: hash('owner-token'), created: '2026-11-12T00:00:00Z' },
      { label: 'agent', role: 'agent:art', sha256: hash('agent-token'), created: '2026-11-12T00:00:00Z' },
    ] }, {});
  })();
  const call = (path: string, body?: unknown, headers: Record<string,string> = {}) => fetch(loom.url + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { home, clock, call, get loom() { return loom; }, store: () => new SessionStore(home, new SessionDatabase(loom.db)),
    async restart() { await loom.close(); loom = await startLoom(options); } };
}
it('row-backed token sign-in survives restart, enforces CSRF and ends on logout or token revoke', async () => {
  const f = await setup();
  for (const name of ['household.json','tokens.json','ui-sessions.json']) writeFileSync(join(f.home,name), 'poison');
  expect((await f.call('/auth/token', { token: 'agent-token' })).status).toBe(401);
  expect((await f.call('/auth/token', { token: 'owner-token' }, { origin: 'https://evil.test' })).status).toBe(403);
  expect((await f.call('/auth/token', { token: 'owner-token' }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
  const login = await f.call('/auth/token', { token: 'owner-token' }, { origin: 'https://loom.test' });
  expect(login.status).toBe(200); expect(login.headers.get('set-cookie')).toContain('Secure');
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  for (const site of ['same-site','cross-site']) expect((await f.call('/auth/session', undefined, { cookie, 'sec-fetch-site': site })).status).toBe(403);
  expect((await f.call('/auth/session', undefined, { cookie, 'sec-fetch-site': 'same-origin' })).status).toBe(200);
  const state = await (await f.call('/auth/session', undefined, { cookie })).json();
  expect(state.member).toBe('jonathan');
  await f.restart();
  expect(await (await f.call('/auth/session', undefined, { cookie })).json()).toEqual(state);
  const api = '/api/tasks/list';
  expect((await f.call(api, { input: {} }, { cookie })).status).toBe(401);
  expect((await f.call(api, { input: {} }, { cookie, 'x-loom-csrf': state.csrf })).status).toBe(200);
  expect((await f.call(api, { input: {} }, { authorization: 'Bearer owner-token' })).status).toBe(200);
  expect((await f.call('/auth/logout', {}, { cookie })).status).toBe(403);
  expect((await f.call('/auth/logout', {}, { cookie, 'x-loom-csrf': state.csrf })).status).toBe(200);
  expect((await f.call('/auth/session', undefined, { cookie })).status).toBe(401);
  const revokedCookie = 'loom_ui=' + f.store().create(Buffer.from(hash('owner-token'),'hex'), f.clock.now()/1000);
  new TokenDatabase(f.loom.db).change(ts => { ts[0].revoked = new Date(f.clock.now()).toISOString(); });
  expect((await f.call('/auth/session', undefined, { cookie: revokedCookie })).status).toBe(401);
  expect((await f.call('/auth/token', { token: 'owner-token' })).status).toBe(401);
  expect((await f.call(api, { input: {} }, { authorization: 'Bearer owner-token' })).status).toBe(401);
});
it('one-time links cannot replay or extend sign-in age, and expired sessions fail closed', async () => {
  const f = await setup(); const now = f.clock.now() / 1000;
  const code = f.store().createLink(Buffer.from(hash('owner-token'), 'hex'), 60, now, 'phone', now - 700);
  const login = await f.call('/auth/link', { code }); expect(login.status).toBe(200);
  expect((await f.call('/auth/link', { code })).status).toBe(401);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  expect(f.store().get(cookie.slice(8))?.signedInAt).toBe(now - 700);
  const expired = f.store().createLink(Buffer.from(hash('owner-token'), 'hex'), 1, now);
  f.clock.advance(2000); expect((await f.call('/auth/link', { code: expired })).status).toBe(401);
  f.clock.advance(SESSION_MAX_AGE_S * 1000);
  expect((await f.call('/auth/session', undefined, { cookie })).status).toBe(401);
  expect(existsSync(join(f.home, 'ui-sessions.json'))).toBe(false);
});
it('passkey assertions require the stored key, origin, fresh challenge and increasing counter', async () => {
  const f = await setup();
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  f.store().addPasskey({ id: 'Y3JlZA', publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'), alg: -7, counter: 0, label: 'phone', created: f.clock.now()/1000, secret: hash('owner-token') });
  const challenge = async () => (await (await f.call('/auth/passkey/options', {})).json()).challenge;
  const assertion = (challenge: string, counter: number, origin = 'https://loom.test') => {
    const cd = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin }));
    const ad = Buffer.alloc(37); createHash('sha256').update('loom.test').digest().copy(ad); ad[32] = 5; ad.writeUInt32BE(counter,33);
    return { id: 'Y3JlZA', clientDataJSON: cd.toString('base64url'), authenticatorData: ad.toString('base64url'), signature: sign('sha256', Buffer.concat([ad,createHash('sha256').update(cd).digest()]), keys.privateKey).toString('base64url') };
  };
  expect((await f.call('/auth/passkey', assertion(await challenge(), 1, 'https://evil.test'))).status).toBe(400);
  const good = assertion(await challenge(), 1); const login = await f.call('/auth/passkey', good); expect(login.status).toBe(200);
  expect((await f.call('/auth/passkey', good)).status).toBe(401);
  expect((await f.call('/auth/passkey', assertion(await challenge(), 1))).status).toBe(401);
  const stale = await challenge(); f.clock.advance(301000);
  expect((await f.call('/auth/passkey', assertion(stale, 2))).status).toBe(401);
});
it('held authentication rechecks membership and tokens; only browser sessions assert window', async () => {
  const f = await setup(); const credentials = nextCredentials(f.loom, f.home, f.clock);
  const req = (headers: Record<string,string>) => ({ headers, method: 'GET' }) as IncomingMessage;
  const bearer = credentials.authenticate(req({ authorization: 'Bearer owner-token' }))!;
  expect(bearer.viewer).toEqual({ kind: 'member', id: 'jonathan' }); expect(bearer.window).not.toBe(true);
  const agent = credentials.authenticate(req({ authorization: 'Bearer agent-token' }))!;
  expect(agent.viewer).toEqual({ kind: 'agent', id: 'art' }); expect(agent.window).not.toBe(true);
  const id = f.store().create(Buffer.from(hash('owner-token'),'hex'),f.clock.now()/1000);
  const browser = credentials.authenticate(req({ cookie: 'loom_ui='+id }))!; expect(browser.window).toBe(true);
  new HouseholdDatabase(f.loom.db).change(f.home, h => { h.members = [{ person: 'other', role: 'owner', agents: '*' }]; h.owner = 'other'; });
  // Unnamed legacy owner tokens belong to the first owner now; old authentication must never switch caller.
  expect(bearer.valid()).toBe(false); expect(browser.valid()).toBe(false);
  expect((await f.call('/auth/session', undefined, { cookie: 'loom_ui='+id })).status).toBe(401);
  expect((await f.call('/auth/token', { token: 'owner-token' })).status).toBe(401);
  await f.restart();
  expect((await f.call('/auth/session', undefined, { cookie: 'loom_ui='+id })).status).toBe(401);
});
it('an offline imported browser cookie, CSRF key and old token work in next mode after source removal', async () => {
  const { importHousehold } = await import('./cli/household-importer.js');
  const { createFoundation } = await import('./foundation.js');
  const { migrateHouseholdTables } = await import('./core/household/schema.js');
  const { mkdirSync, readFileSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(),'next-import-signin-'));
  cleanup.push(() => rmSync(root,{recursive:true,force:true}));
  const home=join(root,'new'), from=join(root,'old'); mkdirSync(from);
  const clock=new FakeClock();
  writeFileSync(join(from,'household.json'),JSON.stringify({v:1,agents:['art'],default:'art',owner:'jonathan'}));
  writeFileSync(join(from,'tokens.json'),JSON.stringify({v:1,tokens:[{label:'old',role:'owner',sha256:hash('old-token'),created:'2026-11-12T00:00:00Z'}]}));
  const old=new SessionStore(from); const id=old.create(Buffer.from(hash('old-token'),'hex'),clock.now()/1000);
  const { createHmac } = await import('node:crypto');
  const csrf=createHmac('sha256',old.key).update(`loom-ui-csrf|${id}`).digest('hex');
  const app=createFoundation({home,clock}); migrateHouseholdTables(app.db);
  try{importHousehold(app.db,home,from,clock.now()/1000);}finally{app.close();}
  expect(readFileSync(join(home,'ui-cookie.key'))).toEqual(old.key);
  rmSync(from,{recursive:true,force:true});
  const loom=await startLoom({home,next:true,clock}); cleanup.push(()=>loom.close());
  const request=(headers:Record<string,string>)=>fetch(loom.url+'/api/tasks/list',{method:'POST',headers:{'content-type':'application/json',...headers},body:'{"input":{}}'});
  expect((await request({cookie:'loom_ui='+id,'x-loom-csrf':csrf})).status).toBe(200);
  expect((await request({authorization:'Bearer old-token'})).status).toBe(200);
  expect((await request({cookie:'loom_ui='+id,'x-loom-csrf':'wrong'})).status).toBe(401);
});
it('live cookie calls require CSRF and expired bearer subscriptions receive no updates', async () => {
  const { WebSocket }=await import('ws'); const { once }=await import('node:events');
  const f=await setup(); const sockets:InstanceType<typeof WebSocket>[]=[]; cleanup.push(()=>{sockets.forEach(s=>s.terminate());});
  const connect=async(headers:Record<string,string>)=>{
    const ws=new WebSocket(f.loom.url.replace('http:','ws:')+'/live',{headers}); sockets.push(ws);
    const queue:unknown[]=[]; const waiters:((v:unknown)=>void)[]=[];
    ws.on('message',raw=>{const v=JSON.parse(raw.toString());const next=waiters.shift();if(next)next(v);else queue.push(v);});
    await once(ws,'open');return {ws,next:()=>queue.length?Promise.resolve(queue.shift()):new Promise<unknown>(ok=>waiters.push(ok))};
  };
  const id=f.store().create(Buffer.from(hash('owner-token'),'hex'),f.clock.now()/1000);
  const session=await(await f.call('/auth/session',undefined,{cookie:'loom_ui='+id})).json();
  const refused=new WebSocket(f.loom.url.replace('http:','ws:')+'/live',{headers:{cookie:'loom_ui='+id,'sec-fetch-site':'same-site'}});sockets.push(refused);refused.on('error',()=>{});
  const denied=new Promise<number>(ok=>refused.once('unexpected-response',(_req,res)=>{res.resume();refused.terminate();ok(res.statusCode!);}));expect(await denied).toBe(401);
  const browser=await connect({cookie:'loom_ui='+id,origin:'https://loom.test'});
  browser.ws.send(JSON.stringify({kind:'call',request:'no-csrf',name:'tasks.list',input:{}}));
  expect(await browser.next()).toMatchObject({kind:'result',result:{ok:false,code:'denied'}});
  browser.ws.send(JSON.stringify({kind:'call',request:'csrf',name:'tasks.list',input:{},csrf:session.csrf}));
  expect(await browser.next()).toMatchObject({kind:'pending'});expect(await browser.next()).toMatchObject({kind:'result',result:{ok:true}});
  new TokenDatabase(f.loom.db).change(ts=>{ts[0].expires=new Date(f.clock.now()+1000).toISOString();});
  const token=await connect({authorization:'Bearer owner-token'});
  token.ws.send(JSON.stringify({kind:'subscribe',type:'task'}));
  // Use a dedicated record to prove outbound validity independently of policy.
  f.loom.live.register({name:'expiry-proof',ids:()=>['one'],read:()=>({id:'one'}),inScope:()=>true});
  token.ws.send(JSON.stringify({kind:'subscribe',type:'expiry-proof'})); expect(await token.next()).toMatchObject({kind:'set'});
  const closed=once(token.ws,'close'); let leaked=false;token.ws.on('message',()=>{leaked=true;});
  f.clock.advance(1001);f.loom.live.changed([{type:'expiry-proof',id:'one'}]);
  expect((await closed)[0]).toBe(1008);expect(leaked).toBe(false);
  expect((await f.call('/auth/token',{token:'owner-token'})).status).toBe(401);
  expect((await f.call('/auth/session',undefined,{cookie:'loom_ui='+id})).status).toBe(401);
});
it('removed named members cannot sign in using their token, links or passkeys',async()=>{
  const f=await setup();new TokenDatabase(f.loom.db).change(ts=>{ts[0].member='removed';});
  const code=f.store().createLink(Buffer.from(hash('owner-token'),'hex'),60,f.clock.now()/1000);
  expect((await f.call('/auth/token',{token:'owner-token'})).status).toBe(401);
  expect((await f.call('/auth/link',{code})).status).toBe(401);
  f.store().addPasskey({id:'gone',publicKey:'unused',alg:-7,counter:0,label:'gone',created:f.clock.now()/1000,secret:hash('owner-token')});
  expect((await f.call('/auth/passkey',{id:'gone'})).status).toBe(401);
  const id=f.store().create(Buffer.from(hash('owner-token'),'hex'),f.clock.now()/1000);
  expect((await f.call('/auth/session',undefined,{cookie:'loom_ui='+id})).status).toBe(401);
  expect((await f.call('/auth/logout',{}, {cookie:'loom_ui='+id})).status).toBe(403);
});

it('cookie-bearing sign-in requests require the existing session CSRF proof',async()=>{
  const f=await setup();const login=await f.call('/auth/token',{token:'owner-token'});
  const cookie=login.headers.get('set-cookie')!.split(';')[0];
  for(const path of ['/auth/token','/auth/link','/auth/passkey/options','/auth/passkey']) expect((await f.call(path,{}, {cookie})).status).toBe(403);
  const state=await(await f.call('/auth/session',undefined,{cookie})).json();
  expect((await f.call('/auth/passkey/options',{}, {cookie,'x-loom-csrf':state.csrf})).status).toBe(200);
});
it('MCP tools recheck authentication after admission',async()=>{
  const home=mkdtempSync(join(tmpdir(),'next-mcp-recheck-'));cleanup.push(()=>rmSync(home,{recursive:true,force:true}));
  let checks=0;const loom=await startLoom({home,next:true,authenticate:()=>({viewer:{kind:'member',id:'jonathan'},valid:()=>++checks===1})});cleanup.push(()=>loom.close());
  const response=await fetch(loom.url+'/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'tasks.list',arguments:{input:{}}}})});
  const answer=await response.json();expect(JSON.parse(answer.result.content[0].text)).toMatchObject({ok:false,code:'denied'});expect(checks).toBeGreaterThan(1);
});
