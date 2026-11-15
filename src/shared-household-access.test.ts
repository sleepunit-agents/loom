import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {GraphQLString} from 'graphql/index.js';
import {afterEach,expect,it} from 'vitest';
import {FakeClock} from './core/clock.js';
import {createDataSchema} from './core/data/database.js';
import {members,agents,memberAgents,tokens,sessions,agentAccounts,changes} from './core/data/schema.js';
import {sharedRoot} from './shared-root.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
const visual={about:'Fictional agent',markBg:'#000000',markFg:'#ffffff',faceShape:'pebble' as const,faceEyes:'dot' as const};
function fixture(hold?:()=>Promise<string>){
 const client=new Database(':memory:');clean.push(()=>client.close());const clock=new FakeClock(),at=new Date(clock.now()).toISOString(),db=createDataSchema(client,()=>new Date(clock.now()).toISOString()),hash=(value:string)=>createHash('sha256').update(value).digest('hex'),raw={owner:'a'.repeat(64),sam:'b'.repeat(64)};
 db.insert(members).values([{id:'owner',role:'owner',joinedAt:at},{id:'sam',role:'member',joinedAt:at}]).run();db.insert(agents).values([{id:'art',...visual},{id:'mark',...visual}]).run();
 for(const member of ['owner','sam'] as const)db.insert(tokens).values({fingerprint:hash(raw[member]),kind:'owner',member,label:member==='sam'?'PRIVATE TOKEN LABEL':'Owner',createdAt:at}).run();
 db.insert(sessions).values({id:hash('c'.repeat(64)),token:hash(raw.sam),device:'Private other browser',via:'link',isAgent:false,issuedAt:at,seenAt:at,provedAt:at}).run();
 const root=sharedRoot({db,clock,originAllowed:()=>true,reportError:()=>{},fields:hold?{hold:{type:GraphQLString,resolve:hold}}:undefined});clean.push(()=>root.close());
 const read=(query='{ householdSetup { members { id role fullOwner agents } agents { id github } tokens { fingerprint label identity } sessions { ref device member } } }',actor:'owner'|'sam'='owner')=>root.http.request('http://loom/graphql',{method:'POST',headers:{authorization:'Bearer '+raw[actor],'content-type':'application/json'},body:JSON.stringify({query})});
 const call=(name:string,input:unknown,actor:'owner'|'sam'='owner',id=name)=>root.http.request('http://loom/api/'+name.replace('.','/'),{method:'POST',headers:{authorization:'Bearer '+raw[actor],'content-type':'application/json'},body:JSON.stringify({input,id})});
 return{client,db,root,raw,read,call,at};
}
it('shows household credential and roster metadata only to owners and revokes another member browser through the outside door',async()=>{
 const f=fixture(),data=(await(await f.read()).json()).data.householdSetup;
 expect(data.tokens).toHaveLength(2);expect(data.sessions).toMatchObject([{device:'Private other browser',member:'sam',ref:expect.any(String)}]);expect(JSON.stringify(data)).not.toContain(f.raw.sam);
 expect((await(await f.read(undefined,'sam')).json()).data.householdSetup).toBeNull();
 expect((await f.call('sessions.revoke',{ref:data.sessions[0].ref},'sam')).status).toBe(403);
 expect((await f.call('sessions.revoke',{ref:data.sessions[0].ref})).status).toBe(200);expect(f.db.select().from(sessions).all()).toEqual([]);
 f.root.writes.run(()=>f.db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run());expect((await f.call('sessions.revoke',{ref:data.sessions[0].ref})).status).toBe(403);
});
it('withdraws retained private setup metadata after demotion while a sibling field awaits',async()=>{
 let began!:()=>void,release!:(value:string)=>void;const ready=new Promise<void>(resolve=>{began=resolve;}),held=new Promise<string>(resolve=>{release=resolve;}),f=fixture(()=>{began();return held;});
 const pending=f.read('{ householdSetup { tokens { label } } hold }');await ready;
 f.db.update(members).set({role:'member'}).where(eq(members.id,'owner')).run();release('done');const response=await pending;expect(await response.text()).not.toContain('PRIVATE TOKEN LABEL');
});
it('full owners own existing and future agents while scoped members retain selected ownership',async()=>{
 const f=fixture();expect((await f.call('household.setMember',{id:'owner',role:'owner',fullOwner:true,agents:[]})).status).toBe(200);expect(f.db.select().from(memberAgents).all()).toHaveLength(2);
 expect((await f.call('household.setMember',{id:'sam',role:'member',agents:['art']},'owner','scoped')).status).toBe(200);
 expect((await f.call('household.setAgent',{id:'new-agent',...visual})).status).toBe(200);
 expect(f.db.select().from(memberAgents).where(eq(memberAgents.member,'owner')).all().map(row=>row.agent).sort()).toEqual(['art','mark','new-agent']);
 expect(f.db.select().from(memberAgents).where(eq(memberAgents.member,'sam')).all()).toEqual([{member:'sam',agent:'art'}]);
});
it('normalizes account ownership, updates cached PR attribution, and rolls grants back with failed receipts',async()=>{
 const f=fixture();
 f.db.insert(changes).values({id:'github:fixture/repo#1',repository:'fixture/repo',number:1,title:'Cached PR',body:'',url:'https://github.com/fixture/repo/pull/1',state:'open',draft:false,authorLogin:'ArT-BoT',project:null,branch:'feature',headCommit:'a'.repeat(40),baseBranch:'next',checks:'passing',review:'approved',mergeable:'yes',waitingOn:'you',openedAt:f.at,updatedAt:f.at}).run();
 expect((await f.call('household.setAgentAccounts',{agent:'art',github:['ART-BOT']})).status).toBe(200);expect(f.db.select().from(changes).get()?.agent).toBe('art');
 expect((await f.call('household.setAgentAccounts',{agent:'mark',github:['art-bot']},'owner','conflict')).status).toBe(409);
 f.client.exec("CREATE TRIGGER refuse_receipt BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
 expect((await f.call('household.setAgentAccounts',{agent:'art',github:[]},'owner','rollback')).status).toBe(503);expect(f.db.select().from(agentAccounts).all()).toEqual([{agent:'art',service:'github',login:'art-bot'}]);expect(f.db.select().from(changes).get()?.agent).toBe('art');
});
