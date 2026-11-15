import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { FakeClock } from '../../src/core/clock.js';
import { createDataSchema } from '../../src/core/data/database.js';
import * as s from '../../src/core/data/schema.js';
import { sharedRoot } from '../../src/shared-root.js';
import { wordsKey } from '../../src/pieces/comms/crypto.js';
// Public, fictitious fixture identity; never a household key.
const FIXTURE_IDENTITY="AGE-SECRET-KEY-10SC5M7Q03WKNXKZHXZKY6JWHDV8MP7DS8USNSE64C674RN6TDGDSEKQNMR";
export const credentialHash=(s:string)=>createHash('sha256').update(s).digest('hex');export const bodyCredentials={body:'b'.repeat(64),member:'m'.repeat(64),agent:'a'.repeat(64),runner:'r'.repeat(64),memberCookie:'c'.repeat(64)};
export async function bodyFixture(clean:(()=>void|Promise<void>)[],options:{modelRoles?:Parameters<typeof sharedRoot>[0]['modelRoles'];initialTime?:number}={}){
 const client=new Database(':memory:');clean.push(()=>{if(client.open)client.close();});const clock=new FakeClock(options.initialTime??Date.parse('2026-11-14T18:00:00Z')),now=()=>new Date(clock.now()).toISOString(),db=createDataSchema(client,now);
 db.insert(s.members).values({id:'alice',role:'member',joinedAt:now()}).run();db.insert(s.agents).values({id:'art',about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble',faceEyes:'dot'}).run();db.insert(s.memberAgents).values({member:'alice',agent:'art'}).run();
 db.insert(s.members).values({id:'bob',role:'member',joinedAt:now()}).run();db.insert(s.agents).values({id:'mark',about:'',markBg:'#000',markFg:'#fff',faceShape:'pebble',faceEyes:'dot'}).run();
 db.insert(s.projects).values([{id:'pond',name:'Pond'},{id:'other',name:'Other'}]).run();db.insert(s.projectMembers).values({project:'pond',member:'alice'}).run();db.insert(s.projectAgents).values({project:'pond',agent:'art'}).run();
 db.insert(s.boxes).values({id:'box',name:'Box',owner:'alice',sameMachineAsLoom:false,hostsAny:false,reportOnly:false,alwaysOn:false,enrolledAt:now()}).run();
 let gate:(()=>Promise<void>)|undefined,openGate:(()=>Promise<void>)|undefined;const key=wordsKey(FIXTURE_IDENTITY);
 const root=sharedRoot({db,clock,modelRoles:options.modelRoles,originAllowed:()=>true,commsKey:{...key,async seal(words){await gate?.();return key.seal(words);},async open(blob){await openGate?.();return key.open(blob);}},reportError:()=>{}});clean.push(()=>root.close());
 const thread=root.services.comms!.threads.open({member:'alice',agent:'art',project:'pond',title:'Private'});
 db.insert(s.jobs).values({id:'job',agent:'art',box:'box',member:'alice',project:'pond',conversation:thread.conversation,title:'Body',state:'running',brief:'',model:'REQUESTED MODEL',startedByKind:'member',startedBy:'alice',houseRepository:'fixture',houseFile:'HOUSE.md',houseBranch:'next',queuedAt:now()}).run();db.update(s.conversations).set({job:'job'}).where(eq(s.conversations.id,thread.conversation)).run();
 db.insert(s.tokens).values([{fingerprint:credentialHash(bodyCredentials.body),label:'Body',kind:'agent',agent:'art',job:'job',createdAt:now()},{fingerprint:credentialHash(bodyCredentials.agent),label:'Agent',kind:'agent',agent:'art',createdAt:now()},{fingerprint:credentialHash(bodyCredentials.member),label:'Owner',kind:'owner',member:'alice',createdAt:now()},{fingerprint:credentialHash(bodyCredentials.runner),label:'Runner',kind:'runner',box:'box',createdAt:now()}]).run();
 db.insert(s.sessions).values({id:credentialHash(bodyCredentials.memberCookie),token:credentialHash(bodyCredentials.member),device:'Browser',via:'link',isAgent:false,issuedAt:now(),seenAt:now(),provedAt:now()}).run();
 const send=(words:string,clientId:string)=>root.http.request('/api/comms/send',{method:'POST',headers:{'content-type':'application/json',cookie:'loom_ui='+bodyCredentials.memberCookie},body:JSON.stringify({input:{thread:thread.id,words,clientId},id:'send-'+clientId})});
 const call=(name:string,input:unknown,id:string,token=bodyCredentials.body)=>root.http.request('/api/conversation/'+name,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({input,id})});
 return {db,clock,root,thread,call,send,key,gate:(fn:()=>Promise<void>)=>{gate=fn;},openGate:(fn:()=>Promise<void>)=>{openGate=fn;}};
}
