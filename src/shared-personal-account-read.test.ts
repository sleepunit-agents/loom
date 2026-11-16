import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { members, tokens, sessions, passkeys, notificationDevices } from './core/data/schema.js';
import { sharedRoot } from './shared-root.js';
const clean: (()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const source=readFileSync(new URL('../web/src/pieces/account/index.tsx',import.meta.url),'utf8');
const query=source.match(/const query=`([^`]+)`/)![1];
it('keeps the shipped personal account read bounded and private as credentials grow',async()=>{
 const counts:number[]=[];
 for(const size of [2,10]){
  const statements:string[]=[],client=new Database(':memory:',{verbose:value=>statements.push(String(value))});clean.push(()=>client.close());
  const clock=new FakeClock(),now=()=>new Date(clock.now()).toISOString(),db=createDataSchema(client,now),cookie='c'.repeat(64);
  for(const member of ['sam','other']){
   db.insert(members).values({id:member,role:'member',joinedAt:now()}).run();
   for(let n=0;n<size;n++){
    const token=hash(`${member}:token:${n}`),session=member==='sam'&&n===0?hash(cookie):hash(`${member}:session:${n}`);
    db.insert(tokens).values({fingerprint:token,kind:'owner',member,label:`${member} token ${n}`,createdAt:now(),expiresAt:n===1?new Date(clock.now()+3600000).toISOString():null}).run();
    db.insert(sessions).values({id:session,token,device:`${member} browser ${n}`,via:'link',isAgent:n===1,issuedAt:now(),seenAt:now(),provedAt:now()}).run();
    db.insert(passkeys).values({id:`${member}:passkey:${n}`,token,label:`${member} passkey ${n}`,publicKey:'Fictional metadata fixture',counter:0,createdAt:now()}).run();
    db.insert(notificationDevices).values({endpoint:`https://fcm.googleapis.com/${member}/${n}`,member,session,keys:'{}',device:`${member} push ${n}`,createdAt:now(),seenAt:now()}).run();
   }
  }
  const root=sharedRoot({db,clock,originAllowed:()=>true,reportError:()=>{}});clean.push(()=>root.close());
  const read=()=>root.http.request('/graphql',{method:'POST',headers:{cookie:`loom_ui=${cookie}`,'content-type':'application/json'},body:JSON.stringify({query})});
  statements.length=0;const response=await read(),result=await response.json();
  expect(response.status).toBe(200);expect(result.errors).toBeUndefined();
  const account=result.data.account;expect(account.member).toBe('sam');expect(account.passkeys).toHaveLength(size);expect(account.sessions).toHaveLength(size);expect(account.notifications.devices).toHaveLength(size);
  expect(JSON.stringify(account)).not.toMatch(/other|Fictional metadata fixture|https:\/\/fcm|sam:passkey:/);
  expect(account.passkeys[0].ref).toMatch(/^[0-9a-f]{64}$/);expect(account.sessions[0].ref).toMatch(/^[0-9a-f]{64}$/);
  counts.push(statements.filter(statement=>/^select\b/i.test(statement)).length);
  clock.advance(7*3600000);const expired=(await(await read()).json()).data.account;
  expect(expired.passkeys.find((row:{label:string})=>row.label==='sam passkey 1').ended).toBe(true);
  expect(expired.sessions.find((row:{device:string})=>row.device==='sam browser 1').ended).toBe(true);
  expect(expired.sessions.find((row:{device:string})=>row.device==='sam browser 0').ended).toBe(false);
 }
 expect(counts).toEqual([counts[0],counts[0]]);
});
