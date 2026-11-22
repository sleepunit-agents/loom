import {randomBytes, randomUUID} from 'node:crypto';
import {existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {workerProgram} from '../../runtime/worker-program.js';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {expect,it} from 'vitest';
import {createDataSchema,dataDatabase} from '../data/database.js';
import {FakeClock} from '../clock.js';
import {serveShared} from '../../shared-serve.js';
import {requestWorkerJoin} from '../../runtime/worker-join.js';
import {boxes,inbox,members,tokens} from '../data/schema.js';
import {credentialFingerprint,currentToken} from '../data/authentication.js';
import {sharedTokens} from './shared-tokens.js';
import {startBrowser} from './shared-browser.js';
import {decideWorkerAdmission,requestWorkerAdmission,workerJoinSource} from './worker-join.js';

const fresh = () => ({request:randomUUID(),name:'wunder',fingerprint:randomBytes(32).toString('hex')});

it('retains the worker’s matching code across coordinator restarts until expiry', () => {
  const directory=mkdtempSync(join(tmpdir(),'loom-worker-join-'));
  const path=join(directory,'home.db');
  const clock=new FakeClock();
  const worker=fresh();
  let client=new Database(path);
  try {
    const result=requestWorkerAdmission(createDataSchema(client),clock,'local',worker);
    expect(result).toEqual({state:'pending',code:expect.stringMatching(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)});
    client.close();
    client=new Database(path);
    const db=dataDatabase(client);
    expect(requestWorkerAdmission(db,clock,'new-address',worker)).toEqual(result);
    clock.advance(15*60_000);
    expect(requestWorkerAdmission(db,clock,'local',worker)).toEqual({state:'expired'});
  } finally { if (client.open) client.close(); rmSync(directory,{recursive:true,force:true}); }
});

it('bounds new requests per source and household while accepting an existing worker poll', () => {
  const client=new Database(':memory:');
  try {
    const db=createDataSchema(client), clock=new FakeClock();
    const worker=fresh(), first=requestWorkerAdmission(db,clock,'one',worker);
    requestWorkerAdmission(db,clock,'one',fresh());
    expect(()=>requestWorkerAdmission(db,clock,'one',fresh())).toThrow(/too many/i);
    for(let i=0;i<18;i++) requestWorkerAdmission(db,clock,String(i),fresh());
    expect(()=>requestWorkerAdmission(db,clock,'another',fresh())).toThrow(/too many/i);
    expect(requestWorkerAdmission(db,clock,'one',worker)).toEqual(first);
    expect(()=>requestWorkerAdmission(db,clock,'one',{...worker,name:'renamed'})).toThrow(/different machine/);
  } finally { client.close(); }
});

it('commits the owner decision, report-only machine and runner credential together, including on retry', () => {
  const client=new Database(':memory:');
  try {
    const db=createDataSchema(client), clock=new FakeClock(), at=new Date(clock.now()).toISOString();
    db.insert(members).values({id:'owner',role:'owner',joinedAt:at}).run();
    sharedTokens(db,clock).issue({kind:'owner',member:'owner',label:'owner'});
    const token=db.select().from(tokens).get()!;
    const signIn=(agent:boolean)=>credentialFingerprint(startBrowser(db,clock.now(),{token,userAgent:'Fixture browser',via:'link',agent}).cookie);
    const session=signIn(false), automated=signIn(true);
    const worker=fresh(), result=requestWorkerAdmission(db,clock,'local',worker);
    if (result.state!=='pending') throw Error('Expected pending request');
    const allow=(id:string)=>decideWorkerAdmission(db,clock,id,worker.request,result.code,'allow');
    expect(()=>allow(automated)).toThrow(/household owner/);
    expect(currentToken(db,worker.fingerprint,clock.now())).toBeUndefined();
    const decision=allow(session);
    expect(allow(session)).toEqual(decision);
    expect(requestWorkerAdmission(db,clock,'local',worker)).toEqual(decision);
    expect(db.select().from(boxes).all()).toMatchObject([{id:decision.box,owner:'owner',reportOnly:true,hostsAny:false}]);
    expect(currentToken(db,worker.fingerprint,clock.now())?.viewer).toEqual({kind:'runner',id:decision.box});
    const another=fresh(), pending=requestWorkerAdmission(db,clock,'local',another);
    if (pending.state!=='pending') throw Error('Expected second pending request');
    const decide=(answer:'allow'|'block')=>decideWorkerAdmission(db,clock,session,another.request,pending.code,answer);
    expect(()=>decide('allow')).toThrow(/name is already in use/);
    expect(decide('block')).toEqual({state:'blocked',box:null});
    expect(requestWorkerAdmission(db,clock,'local',another)).toEqual({state:'blocked'});
    expect(currentToken(db,another.fingerprint,clock.now())).toBeUndefined();
    expect(db.select().from(boxes).all()).toHaveLength(1);
  } finally { client.close(); }
});

it('lets the signed-in owner see and answer the matching request through the desktop command door',async () => {
  const client=new Database(':memory:'), db=createDataSchema(client), clock=new FakeClock();
  const directory=mkdtempSync(join(tmpdir(),'loom-worker-join-'));
  const root=await serveShared({db,clock,originAllowed:()=>true,reportError:error=>{throw error;}});
  try {
    db.insert(members).values({id:'owner',role:'owner',joinedAt:new Date(clock.now()).toISOString()}).run();
    sharedTokens(db,clock).issue({kind:'owner',member:'owner',label:'Fixture owner'});
    const token=db.select().from(tokens).get()!;
    const {cookie}=startBrowser(db,clock.now(),{token,userAgent:'Fixture Browser',via:'link'});
    const template=join(directory,'worker.enrollment.json'),configPath=join(directory,'worker.json'),tokenPath=join(directory,'runner.token');
    writeFileSync(template,JSON.stringify({url:root.url,box:null,tokenFile:tokenPath,slots:1}));
    const joinWorker=()=>requestWorkerJoin(root.url,'wunder',directory,template);
    const result=await joinWorker();
    expect([existsSync(configPath),existsSync(tokenPath)]).toEqual([false,false]);
    if(result.state!=='pending') throw Error('Expected pending request');
    const call=async(name:string,input:unknown)=> {
      const response=await fetch(root.url+'/api/runtime/'+name,{method:'POST',
        headers:{cookie:'loom_ui='+cookie,origin:root.url,'content-type':'application/json'},
        body:JSON.stringify({id:randomUUID(),input})});
      return response.json();
    };
    expect(db.select().from(inbox).all()).toMatchObject([{to:'owner',state:'waiting',answers:'yes-no',why:expect.stringContaining(result.code)}]);
    const pending=await call('workerJoinPending',{});
    expect(pending).toMatchObject({ok:true,value:{requests:[{name:'wunder',code:result.code}]}});
    expect(await call('workerJoinDecide',{request:pending.value.requests[0].request,code:result.code,decision:'allow'})).toMatchObject({ok:true,value:{state:'allowed'}});
    expect(await call('workerJoinPending',{})).toMatchObject({ok:true,value:{requests:[]}});
    expect(db.select().from(inbox).all()).toMatchObject([{state:'resolved',resolution:'Machine admitted'}]);
    const admitted=await joinWorker();
    if(admitted.state!=='allowed') throw Error('Expected owner-approved machine');
    const saved=JSON.parse(readFileSync(join(directory,'worker-join.json'),'utf8'));
    const auth=root.credentials.authenticate(new Request(root.url,{headers:{authorization:'Bearer '+saved.token}}));
    expect(auth?.viewer).toEqual({kind:'runner',id:admitted.box});
    expect(await joinWorker()).toEqual(admitted);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(configPath,'utf8'))).toMatchObject({reportOnly:true,box:admitted.box,tokenFile:tokenPath});
    let stop=()=>{};
    const exit=await workerProgram({args:[configPath],read:async path=>readFileSync(path,'utf8'),
      on:(_,fn)=>{stop=fn;},off:()=>{},error:()=>{},pause:async()=>stop()});
    expect(exit).toBe(0);
    expect(db.select().from(boxes).get()).toMatchObject({id:admitted.box,lastSeenAt:new Date(clock.now()).toISOString(),slots:0});
    writeFileSync(configPath,'{"local":"edited"}');
    await expect(joinWorker()).rejects.toThrow(/already exists/);
    expect(readFileSync(configPath,'utf8')).toBe('{"local":"edited"}');
    await requestWorkerJoin(root.url,'second',join(directory,'second'));
    clock.advance(15*60_000);
    expect(db.select().from(inbox).all()).toContainEqual(expect.objectContaining({state:'resolved',resolution:'Join request expired'}));
  } finally {await root.close();client.close();rmSync(directory,{recursive:true,force:true});}
});

it('groups socket peers by network including IPv4-mapped IPv6 peers',()=>{
  expect(workerJoinSource('::ffff:192.0.2.19')).toBe(workerJoinSource('192.0.2.241'));
  expect(workerJoinSource('2001:db8::1')).toBe(workerJoinSource('2001:db8:0:0:ffff::2'));
  expect(workerJoinSource('2001:db8:0:1::1')).not.toBe(workerJoinSource('2001:db8::1'));
});
