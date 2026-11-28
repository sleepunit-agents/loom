import Database from 'better-sqlite3';
import { setupCall } from '../test/fixtures/setup-call.js';
import {createHash} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {GraphQLString} from 'graphql/index.js';
import {afterEach,expect,it} from 'vitest';
import {FakeClock} from './core/clock.js';
import {createDataSchema} from './core/data/database.js';
import {members,agents,memberAgents,tokens,sessions,agentAccounts,changes,boxes,jobs} from './core/data/schema.js';
import {sharedRoot} from './shared-root.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const close of clean.splice(0).reverse())await close();});
const visual={about:'Fictional agent',markBg:'#000000',markFg:'#ffffff',faceShape:'pebble' as const,faceEyes:'dot' as const};
function fixture(hold?:()=>Promise<string>,fullOwner=false){
 const statements:string[]=[];const client=new Database(':memory:',{verbose:s=>{if(/^select\b/i.test(s)&&/readHouseholdSetup|at Object\.read \(.*shared-household-access/.test(new Error().stack??''))statements.push(s);}});clean.push(()=>client.close());const clock=new FakeClock(),at=new Date(clock.now()).toISOString(),db=createDataSchema(client,()=>new Date(clock.now()).toISOString()),hash=(value:string)=>createHash('sha256').update(value).digest('hex'),raw={owner:'a'.repeat(64),sam:'b'.repeat(64)};
 db.insert(members).values([{id:'owner',role:'owner',fullOwner,joinedAt:at},{id:'sam',role:'member',joinedAt:at}]).run();db.insert(agents).values([{id:'art',...visual},{id:'mark',...visual}]).run();
 for(const member of ['owner','sam'] as const)db.insert(tokens).values({fingerprint:hash(raw[member]),kind:'owner',member,label:member==='sam'?'PRIVATE TOKEN LABEL':'Owner',createdAt:at}).run();
 db.insert(sessions).values({id:hash('c'.repeat(64)),token:hash(raw.sam),device:'Private other browser',via:'link',isAgent:false,issuedAt:at,seenAt:at,provedAt:at}).run();
 const root=sharedRoot({db,clock,originAllowed:()=>true,reportError:()=>{},fields:hold?{hold:{type:GraphQLString,resolve:hold}}:undefined});clean.push(()=>root.close());
 const read=(query='{ householdSetup { members { id role fullOwner agents } agents { id github } tokens { fingerprint label identity } sessions { ref device member } } }',actor:'owner'|'sam'='owner')=>root.http.request('http://loom/graphql',{method:'POST',headers:{authorization:'Bearer '+raw[actor],'content-type':'application/json'},body:JSON.stringify({query})});
 const call=async(name:string,input:unknown,actor:'owner'|'sam'='owner',id=name)=>setupCall(root,name,input,actor)??root.http.request('http://loom/api/'+name.replace('.','/'),{method:'POST',headers:{authorization:'Bearer '+raw[actor],'content-type':'application/json'},body:JSON.stringify({input,id})});
 return{statements,client,db,root,raw,read,call,at};
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
 
 f.db.insert(changes).values({id:'github:fixture/repo#1',repository:'fixture/repo',number:1,title:'Cached PR',body:'',url:'https://github.com/fixture/repo/pull/1',state:'open',draft:false,authorLogin:'ArT-BoT',project:null,branch:'feature',headCommit:'a'.repeat(40),baseBranch:'next',checks:'passing',review:'approved',mergeable:'yes',waitingOn:'author',openedAt:f.at,updatedAt:f.at}).run();
 expect((await f.call('household.setAgentAccounts',{agent:'art',github:['ART-BOT']})).status).toBe(200);expect(f.db.select().from(changes).get()).toMatchObject({agent:'art',waitingOn:'you'});
 expect((await f.call('household.setAgentAccounts',{agent:'mark',github:['art-bot']},'owner','conflict')).status).toBe(409);
 f.client.exec("CREATE TRIGGER refuse_receipt BEFORE INSERT ON operation_results BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
 expect(f.db.select().from(agentAccounts).all()).toEqual([{agent:'art',service:'github',login:'art-bot'}]);expect(f.db.select().from(changes).get()).toMatchObject({agent:'art',waitingOn:'you'});
});

it('clears derived PR grouping when an account login is removed',async()=>{
 const f=fixture();f.db.insert(changes).values({id:'github:fixture/repo#2',repository:'fixture/repo',number:2,title:'Cached PR',body:'',url:'https://github.com/fixture/repo/pull/2',state:'open',draft:false,authorLogin:'bot',project:null,branch:'feature',headCommit:'a'.repeat(40),baseBranch:'next',checks:'passing',review:'approved',mergeable:'yes',waitingOn:'author',openedAt:f.at,updatedAt:f.at}).run();
 await f.call('household.setAgentAccounts',{agent:'art',github:['bot']});expect(f.db.select().from(changes).get()).toMatchObject({agent:'art',waitingOn:'you'});
 await f.call('household.setAgentAccounts',{agent:'art',github:[]},'owner','remove');expect(f.db.select().from(changes).get()).toMatchObject({agent:null,waitingOn:'author'});
});
it('permits trusted roster/account and browser helpers without an outside owner gate',()=>{
 const f=fixture();f.root.writes.run(()=>f.root.services.householdAccess.setAccounts({agent:'art',github:['bot']}));expect(f.root.services.householdAccess.read().agents.find(agent=>agent.id==='art')?.github).toEqual(['bot']);
 const ref=f.root.services.householdAccess.read().sessions[0].ref;f.root.writes.run(()=>f.root.services.householdAccess.revokeSession(ref));expect(f.db.select().from(sessions).all()).toEqual([]);
});

it('materializes declared full ownership for preexisting rows when the shared program starts',()=>{
 const f=fixture(undefined,true);expect(f.db.select().from(memberAgents).where(eq(memberAgents.member,'owner')).all().map(row=>row.agent).sort()).toEqual(['art','mark']);
 expect(f.root.services.household.members().find(member=>member.id==='owner')).toMatchObject({fullOwner:true,agents:['art','mark']});
});

it('bounds the actual setup query at two and ten members/agents while preserving owned links and account labels',async()=>{
 const f=fixture();f.statements.length=0;const small=await(await f.read()).json();expect(small.errors).toBeUndefined();expect(small.data.householdSetup.members).toHaveLength(2);const count=f.statements.length;
 for(let n=2;n<10;n++){
  const id='fixture-'+n;f.db.insert(members).values({id,role:'member',joinedAt:f.at}).run();f.db.insert(agents).values({id,...visual}).run();
  f.db.insert(memberAgents).values({member:id,agent:id}).run();f.db.insert(agentAccounts).values({agent:id,service:'github',login:'login-'+n}).run();
 }
 f.statements.length=0;const large=await(await f.read()).json();expect(large.errors).toBeUndefined();const result=large.data.householdSetup;
 expect(result.members).toHaveLength(10);expect(result.agents).toHaveLength(10);expect(result.members.find((row:{id:string})=>row.id==='fixture-9').agents).toEqual(['fixture-9']);expect(result.agents.find((row:{id:string})=>row.id==='fixture-9').github).toEqual(['login-9']);
 expect(f.statements.length).toBe(count);expect(count).toBe(7); // the sixth reads the backup keys, the seventh the jobs of job-bound tokens; still the same at two rows and at ten
 // And at forty body tokens, each bound to a job of its own, half of them ended: one join, never a read per token.
 f.db.insert(boxes).values({id:'box-1',name:'box-1',owner:'owner',sameMachineAsLoom:false,hostsAny:false,reportOnly:false,alwaysOn:false,enrolledAt:f.at}).run();
 for(let n=0;n<40;n++){
  f.db.insert(jobs).values({id:'job-'+n,agent:'art',box:'box-1',title:'job',state:n%2?'running':'done',brief:'',model:'fixture',startedByKind:'agent',startedBy:'art',houseRepository:'fixture',houseFile:'HOUSE.md',houseBranch:'next',queuedAt:f.at}).run();
  f.db.insert(tokens).values({fingerprint:createHash('sha256').update('job-'+n).digest('hex'),kind:'agent',agent:'art',job:'job-'+n,label:'Job body [job-'+n+']',createdAt:f.at}).run();
 }
 f.statements.length=0;const bodies=await(await f.read('{ householdSetup { tokens { label forJob state } } }')).json();expect(bodies.errors).toBeUndefined();
 const listed=bodies.data.householdSetup.tokens.filter((row:{forJob:boolean})=>row.forJob);
 expect(listed).toHaveLength(40);expect(listed.filter((row:{state:string})=>row.state==='ended with its job')).toHaveLength(20);expect(listed.filter((row:{state:string})=>row.state==='active')).toHaveLength(20);
 expect(f.statements.length).toBe(count);
});

it('keeps browser validity tied to the exact current token expiry and revocation',async()=>{
 const f=fixture(),sam=f.db.select().from(tokens).where(eq(tokens.member,'sam')).get()!;
 const read=async()=> (await(await f.read('{householdSetup{sessions{ended member tokenLabel}}}')).json()).data.householdSetup.sessions[0];
 f.db.update(tokens).set({expiresAt:new Date(Date.parse(f.at)+60000).toISOString()}).where(eq(tokens.fingerprint,sam.fingerprint)).run();
 expect(await read()).toMatchObject({ended:false,member:'sam',tokenLabel:'PRIVATE TOKEN LABEL'});
 f.db.update(tokens).set({expiresAt:f.at}).where(eq(tokens.fingerprint,sam.fingerprint)).run();expect((await read()).ended).toBe(true);
 f.db.update(tokens).set({expiresAt:null,revokedAt:f.at}).where(eq(tokens.fingerprint,sam.fingerprint)).run();expect((await read()).ended).toBe(true);
});
