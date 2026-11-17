import Database from 'better-sqlite3';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, expect, it, vi } from 'vitest';
import { FakeClock } from '../clock.js';
import { createDataSchema } from '../data/database.js';
import { members, tokens, sessions, passkeys, notificationDevices } from '../data/schema.js';
import { sharedRoot } from '../../shared-root.js';
const clean:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const origin='https://loom.example';
class Authenticator {
 id=randomBytes(16);keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});counter=0;
 data(attested=false){const b=Buffer.alloc(attested?55+this.id.length:37);createHash('sha256').update('loom.example').digest().copy(b);b[32]=attested?0x45:5;b.writeUInt32BE(this.counter,33);if(attested){b.writeUInt16BE(this.id.length,53);this.id.copy(b,55);const jwk=this.keys.publicKey.export({format:'jwk'}),x=Buffer.from(jwk.x!,'base64url'),y=Buffer.from(jwk.y!,'base64url');return Buffer.concat([b,Buffer.from([0xa5,1,2,3,0x26,0x20,1,0x21,0x58,32]),x,Buffer.from([0x22,0x58,32]),y]);}return b;}
 registration(challenge:string){return {label:'Laptop',id:this.id.toString('base64url'),clientDataJSON:Buffer.from(JSON.stringify({type:'webauthn.create',challenge,origin})).toString('base64url'),authenticatorData:this.data(true).toString('base64url'),publicKey:this.keys.publicKey.export({type:'spki',format:'der'}).toString('base64url'),publicKeyAlgorithm:-7};}
 assertion(challenge:string, forged=false){const cd=Buffer.from(JSON.stringify({type:'webauthn.get',challenge,origin})),ad=this.data();return {id:this.id.toString('base64url'),clientDataJSON:cd.toString('base64url'),authenticatorData:ad.toString('base64url'),signature:sign('sha256',forged?Buffer.from('forged'):Buffer.concat([ad,createHash('sha256').update(cd).digest()]),this.keys.privateKey).toString('base64url')};}
}
function fixture(){
 const client=new Database(':memory:');clean.push(()=>client.close());const clock=new FakeClock(),at=new Date(clock.now()).toISOString(),db=createDataSchema(client,()=>new Date(clock.now()).toISOString());
 const raw={sam:'a'.repeat(64),other:'b'.repeat(64)},cookies={sam:'c'.repeat(64),other:'d'.repeat(64)};
 for(const member of ['sam','other'] as const){db.insert(members).values({id:member,role:'member',joinedAt:at}).run();db.insert(tokens).values({fingerprint:hash(raw[member]),label:member,kind:'owner',member,createdAt:at}).run();db.insert(sessions).values({id:hash(cookies[member]),token:hash(raw[member]),device:member+' laptop',via:'link',isAgent:false,issuedAt:at,seenAt:at,provedAt:at}).run();}
 const root=sharedRoot({db,clock,publicOrigin:origin,originAllowed:()=>true,reportError:()=>{}});clean.push(()=>root.close());
 const post=(path:string,body:unknown={},member:'sam'|'other'='sam',headers={})=>root.http.request(origin+path,{method:'POST',headers:{cookie:'loom_ui='+cookies[member],origin,'content-type':'application/json',...headers},body:JSON.stringify(body)});
 const read=(member:'sam'|'other'='sam')=>post('/graphql',{query:'{ account { member passkeys { ref label createdAt ended } sessions { ref device ended } } }'},member).then(r=>r.json());
 const add=async()=>{const key=new Authenticator(),options=await(await post('/passkeys/options')).json();expect((await post('/passkeys',key.registration(options.challenge))).status).toBe(200);return key;};
 return{client,db,clock,root,raw,cookies,post,read,add};
}
it('registers a passkey on the actual shared door and signs in with verified single-use assertions',async()=>{
 const f=fixture(),key=await f.add();expect(f.db.select().from(passkeys).get()?.label).toBe('Laptop');
 const challenge=async()=> (await(await f.post('/login/passkey/options')).json()).challenge;
 expect((await f.post('/login/passkey',key.assertion(await challenge()))).status).toBe(401);
 key.counter=1;const c=await challenge();const response=await f.post('/login/passkey',key.assertion(c));expect(response.status).toBe(200);expect(response.headers.get('set-cookie')).toContain('HttpOnly');
 const cookie=response.headers.get('set-cookie')!.split(';')[0];
 expect(await(await f.root.http.request(origin+'/auth/session',{headers:{cookie}})).json()).toEqual({viewer:{kind:'member',id:'sam'}});
 key.counter=2;expect((await f.post('/login/passkey',key.assertion(c))).status).toBe(401);key.counter=1;
 expect((await f.post('/login/passkey',key.assertion(await challenge()))).status).toBe(401);
 key.counter=2;expect((await f.post('/login/passkey',key.assertion(await challenge(),true))).status).toBe(401);
 expect((await f.post('/login/passkey',key.assertion(await challenge()))).status).toBe(200);
 expect(f.db.select().from(passkeys).get()?.counter).toBe(2);
 key.counter=1;expect((await f.post('/login/passkey',key.assertion(await challenge()))).status).toBe(401);
 expect(JSON.stringify(f.client.prepare('SELECT * FROM operation_results').all())).not.toContain(cookie.slice(8));
});
it('binds registration challenges to the exact fresh browser and rejects expired, stale, headless and cross-origin ceremonies',async()=>{
 const f=fixture(),key=new Authenticator(),options=await(await f.post('/passkeys/options')).json();
 expect((await f.post('/passkeys',key.registration(options.challenge),'other')).status).toBe(401);
 expect((await f.post('/passkeys',key.registration(options.challenge))).status).toBe(401);
 expect((await f.post('/passkeys/options',{},'sam',{origin:'https://evil.example'})).status).toBe(403);
 const fresh=await(await f.post('/passkeys/options')).json();f.clock.advance(300000);
 expect((await f.post('/passkeys',key.registration(fresh.challenge))).status).toBe(401);
 f.clock.advance(300000);expect((await f.post('/passkeys/options')).status).toBe(401);
 f.db.update(sessions).set({provedAt:new Date(f.clock.now()).toISOString(),isAgent:true}).where(eq(sessions.id,hash(f.cookies.sam))).run();
 expect((await f.post('/passkeys/options')).status).toBe(401);
 expect(f.db.select().from(passkeys).all()).toEqual([]);
});
it('ends the browsers a passkey signed in when that passkey is removed, and no others',async()=>{
 const f=fixture(),key=await f.add();
 key.counter=1;const challenge=(await(await f.post('/login/passkey/options')).json()).challenge;
 expect((await f.post('/login/passkey',key.assertion(challenge))).status).toBe(200);
 const made=f.db.select().from(sessions).where(eq(sessions.via,'passkey')).get()!;expect(made.passkey).toBe(f.db.select().from(passkeys).get()!.id);
 // The browser the link signed in is not the passkey's: it stays, and its notifications with it.
 const linked=f.db.select().from(sessions).all().filter(row=>row.via!=='passkey').map(row=>row.id);expect(linked.length).toBeGreaterThan(0);
 f.db.insert(notificationDevices).values({endpoint:'https://push.example/passkey',member:'sam',session:made.id,keys:'{}',device:'Phone',createdAt:made.issuedAt,seenAt:made.issuedAt}).run();
 const account=(await f.read()).data.account;
 expect((await f.post('/api/account/removePasskey',{input:{ref:account.passkeys[0].ref},id:'remove'})).status).toBe(200);
 expect(f.db.select().from(passkeys).all()).toEqual([]);
 expect(f.db.select().from(sessions).all().map(row=>row.id).sort()).toEqual(linked.sort());
 expect(f.db.select().from(notificationDevices).all()).toEqual([]);
});
it('serves only personal metadata and ends the selected browser and its notifications through shared commands',async()=>{
 const f=fixture(),key=await f.add();
 const sam=(await f.read()).data.account,other=(await f.read('other')).data.account;
 expect(sam.member).toBe('sam');expect(sam.passkeys).toHaveLength(1);expect(sam.sessions).toHaveLength(1);expect(other.passkeys).toEqual([]);expect(other.sessions[0].device).toBe('other laptop');
 expect(JSON.stringify(sam)).not.toContain(hash(f.raw.sam));expect(JSON.stringify(sam)).not.toContain(hash(f.cookies.sam));
 const call=(name:string,input:unknown,member:'sam'|'other'='sam')=>f.post('/api/account/'+name,{input,id:name},member);
 expect((await call('removePasskey',{ref:sam.passkeys[0].ref},'other')).status).toBe(404);
 expect((await call('removePasskey',{ref:sam.passkeys[0].ref})).status).toBe(200);
 key.counter=1;const challenge=(await(await f.post('/login/passkey/options')).json()).challenge,before=f.db.select().from(sessions).all();
 expect((await f.post('/login/passkey',key.assertion(challenge))).status).toBe(401);expect(f.db.select().from(sessions).all()).toEqual(before);
 f.db.insert(notificationDevices).values({endpoint:'https://push.example/device',member:'sam',session:hash(f.cookies.sam),keys:'{}',device:'Laptop',createdAt:new Date(f.clock.now()).toISOString(),seenAt:new Date(f.clock.now()).toISOString()}).run();
 expect((await call('revokeSession',{ref:sam.sessions[0].ref},'other')).status).toBe(404);
 // Ending the calling browser commits successfully, then the response is denied
 // because that exact authenticated credential is no longer current.
 expect((await call('revokeSession',{ref:sam.sessions[0].ref})).status).toBe(403);
 expect(f.db.select().from(notificationDevices).all()).toEqual([]);expect(f.db.select().from(sessions).all()).toHaveLength(1);
});
it('makes one-time links from a current member browser without caller-selected identity',async()=>{
 const f=fixture(),response=await f.post('/api/signin/link',{member:'other'});expect(response.status).toBe(200);
 const {value}=await response.json(),redeemed=await f.post(value.path),cookie=redeemed.headers.get('set-cookie')!.split(';')[0];expect(redeemed.status).toBe(303);
 expect(await(await f.root.http.request(origin+'/auth/session',{headers:{cookie}})).json()).toEqual({viewer:{kind:'member',id:'sam'}});
});

it('refuses registration with missing or mismatched embedded credential public keys',async()=>{
 const f=fixture(),key=new Authenticator(),other=new Authenticator();
 for(const mutate of [(body:Record<string,string|number>)=>({...body,authenticatorData:Buffer.from(String(body.authenticatorData),'base64url').subarray(0,55+key.id.length).toString('base64url')}),(body:Record<string,string|number>)=>({...body,publicKey:other.keys.publicKey.export({type:'spki',format:'der'}).toString('base64url')})]){
  const options=await(await f.post('/passkeys/options')).json();expect((await f.post('/passkeys',mutate(key.registration(options.challenge)))).status).toBe(401);
 }
 expect(f.db.select().from(passkeys).all()).toEqual([]);
});
it.each(['revoked','expired','missing-member'] as const)('refuses passkey login when its member token is %s',async reason=>{
 const f=fixture(),key=await f.add(),challenge=(await(await f.post('/login/passkey/options')).json()).challenge;key.counter=1;
 if(reason==='revoked')f.db.update(tokens).set({revokedAt:new Date(f.clock.now()).toISOString()}).where(eq(tokens.member,'sam')).run();
 else if(reason==='expired')f.db.update(tokens).set({expiresAt:new Date(f.clock.now()).toISOString()}).where(eq(tokens.member,'sam')).run();
 else{f.client.pragma('foreign_keys = OFF');f.db.delete(members).where(eq(members.id,'sam')).run();f.client.pragma('foreign_keys = ON');}
 const before=f.db.select().from(sessions).all();expect((await f.post('/login/passkey',key.assertion(challenge))).status).toBe(401);expect(f.db.select().from(sessions).all()).toEqual(before);
});
it('refuses expired outside authority at the account effect transaction',async()=>{
 const f=fixture();await f.add();const account=(await f.read()).data.account,run=f.root.writes.run.bind(f.root.writes);
 vi.spyOn(f.root.writes,'run').mockImplementationOnce(action=>{f.db.update(tokens).set({revokedAt:new Date(f.clock.now()).toISOString()}).where(eq(tokens.member,'sam')).run();return run(action);});
 expect((await f.post('/api/account/removePasskey',{input:{ref:account.passkeys[0].ref},id:'boundary'})).status).toBe(403);expect(f.db.select().from(passkeys).all()).toHaveLength(1);
});
it('refuses sign-in effects if shutdown starts after request admission but before its transaction',async()=>{
 const f=fixture(),run=f.root.writes.run.bind(f.root.writes);let closed:Promise<void>|undefined;
 vi.spyOn(f.root.writes,'run').mockImplementationOnce(action=>{closed=f.root.close();return run(action);});
 expect((await f.post('/api/signin/link')).status).toBe(401);await closed;
 expect(f.client.prepare('SELECT * FROM signin_links').all()).toEqual([]);
});

it('independently binds registration to both the browser and its token',async()=>{
 const f=fixture(),key=new Authenticator();
 const c1=(await(await f.post('/passkeys/options')).json()).challenge;
 const sameToken='e'.repeat(64),at=new Date(f.clock.now()).toISOString();
 f.db.insert(sessions).values({id:hash(sameToken),token:hash(f.raw.sam),device:'Second browser',via:'link',isAgent:false,issuedAt:at,seenAt:at,provedAt:at}).run();
 expect((await f.post('/passkeys',key.registration(c1),'sam',{cookie:'loom_ui='+sameToken})).status).toBe(401);
 const c2=(await(await f.post('/passkeys/options')).json()).challenge;
 f.db.update(sessions).set({token:hash(f.raw.other)}).where(eq(sessions.id,hash(f.cookies.sam))).run();
 expect((await f.post('/passkeys',key.registration(c2))).status).toBe(401);expect(f.db.select().from(passkeys).all()).toEqual([]);
});
it('keeps stale logout authority from changing browser rows at transaction entry',async()=>{
 const f=fixture(),run=f.root.writes.run.bind(f.root.writes),before=f.db.select().from(sessions).all();
 vi.spyOn(f.root.writes,'run').mockImplementationOnce(action=>{f.db.update(tokens).set({revokedAt:new Date(f.clock.now()).toISOString()}).where(eq(tokens.member,'sam')).run();return run(action);});
 expect((await f.post('/logout')).status).toBe(200);expect(f.db.select().from(sessions).all()).toEqual(before);
});
it('expires an otherwise valid passkey login challenge before any session is created',async()=>{
 const f=fixture(),key=await f.add(),challenge=(await(await f.post('/login/passkey/options')).json()).challenge;key.counter=1;const before=f.db.select().from(sessions).all();f.clock.advance(300000);
 expect((await f.post('/login/passkey',key.assertion(challenge))).status).toBe(401);expect(f.db.select().from(sessions).all()).toEqual(before);
});
