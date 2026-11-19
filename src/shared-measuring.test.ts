import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { expect, it, vi } from 'vitest';
import { FakeClock } from './core/clock.js';
import { createDataSchema } from './core/data/database.js';
import { agents, members, tokens, timingDays, measuringSettings } from './core/data/schema.js';
import { DEFAULT_MEASURING } from './core/measuring/index.js';
import { sharedRoot } from './shared-root.js';
import { serveShared } from './shared-serve.js';

const exporter=vi.hoisted(()=>({stop:undefined as undefined|(()=>Promise<void>)}));
vi.mock('@opentelemetry/exporter-trace-otlp-proto',()=>({OTLPTraceExporter:class {export(_spans:unknown[],done:(result:{code:number})=>void){done({code:0});}async shutdown(){await exporter.stop?.();}}}));
it('runs Measuring through the fresh shared listener and refreshes generic approvals only after their outer commit', async()=>{
 const client=new Database(':memory:');
 const clock=new FakeClock(Date.UTC(2026,10,14));
 const at=new Date(clock.now()).toISOString();
 const db=createDataSchema(client,()=>new Date(clock.now()).toISOString());
 db.insert(members).values([{id:'owner',role:'owner',joinedAt:at},{id:'guest',role:'member',joinedAt:at}]).run();
 db.insert(agents).values({id:'art',about:'',markBg:'#fff',markFg:'#000',faceShape:'pebble',faceEyes:'dot'}).run();
 const ownerToken='o'.repeat(64), agentToken='a'.repeat(64), guestToken='g'.repeat(64);
 for(const [token,who] of [[ownerToken,'owner'],[agentToken,'art'],[guestToken,'guest']] as const)
  db.insert(tokens).values({fingerprint:createHash('sha256').update(token).digest('hex'),label:who,kind:who==='art'?'agent':'owner',agent:who==='art'?who:null,member:who==='art'?null:who,createdAt:at}).run();
 const errors:unknown[]=[];
 const root=await serveShared({db,clock,originAllowed:()=>true,reportError:e=>errors.push(e)});
 const meter=await root.measuring;
 let seq=0, ws:WebSocket|undefined;
 const call=async(verb:string,input:unknown,token=ownerToken)=>{
  const response=await fetch(root.url+'/api/household/'+verb,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({input,id:String(++seq)})});
  return {status:response.status,result:await response.json() as {ok:boolean;value:{id:string}}};
 };
 try {
  expect(meter.enabled()).toBe(false);
  const settings={...DEFAULT_MEASURING,on:true};
  // Measuring is changed like any other setting: the agent proposes, an owner allows.
  const propose=(after:typeof settings,why:string)=>call('propose',{change:'measuring',input:after,why},agentToken);
  const proposed=await propose(settings,'Find slow work');
  expect(proposed.status).toBe(200);
  expect(root.operations.has('measuring.propose')).toBe(false);expect(root.operations.has('measuring.answer')).toBe(false);
  const answer=async(token:string)=>{
   const response=await fetch(root.url+'/api/approvals/answer',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({input:{id:proposed.result.value.id,answer:'allow'},id:String(++seq)})});
   return {status:response.status,result:await response.json() as {ok:boolean}};
  };
  expect((await answer(guestToken)).status).toBe(403);
  expect((await answer(agentToken)).status).toBe(403);
  expect(meter.enabled()).toBe(false);
  expect((await answer(ownerToken)).result.ok).toBe(true);
  await meter.settled();expect(meter.enabled()).toBe(true);
  await (await fetch(root.url+'/graphql',{method:'POST',headers:{authorization:'Bearer '+ownerToken,'content-type':'application/json'},body:JSON.stringify({query:'{ timingDays { name } }'})})).json();
  expect(db.select().from(timingDays).all()).toContainEqual(expect.objectContaining({kind:'request',name:'graphql',count:1}));
  ws=new WebSocket(root.url.replace('http:','ws:')+'/graphql','graphql-transport-ws',{headers:{authorization:'Bearer '+agentToken}});
  await once(ws,'open');const ack=once(ws,'message');ws.send(JSON.stringify({type:'connection_init'}));await ack;
  const next=(id:string, query:string)=>new Promise<void>((resolve,reject)=>{
   const receive=(data:unknown)=>{const frame=JSON.parse(String(data));if(frame.id!==id)return;if(frame.type==='next'){ws!.off('message',receive);resolve();}else if(frame.type==='error'){ws!.off('message',receive);reject(new Error('Query failed'));}};
   ws!.on('message',receive);ws!.send(JSON.stringify({type:'subscribe',id,payload:{query}}));
  });
  await next('direct','{ timingDays { kind name } }');
  await next('timings','subscription{observe(query:"{ timingDays { kind name } }"){revision patches{path value}}}');
  expect(db.select().from(timingDays).all()).toContainEqual(expect.objectContaining({kind:'request',name:'graphql.socket',count:2}));
  const off=(await propose({...settings,on:false},'Stop measuring')).result.value.id;
  expect(()=>root.writes.run(()=>{root.services.approvals.allow(off,'owner');throw new Error('receipt failed');})).toThrow('receipt failed');
  await meter.settled();expect(meter.enabled()).toBe(true);
  root.writes.run(()=>root.services.approvals.allow(off,'owner'));
  await meter.settled();expect(meter.enabled()).toBe(false);
  const on=(await propose(settings,'Measure again')).result.value.id;
  root.writes.run(()=>root.services.approvals.allow(on,'owner'));
  await meter.settled();expect(meter.enabled()).toBe(true);
  expect(errors).toEqual([]);
 } finally {ws?.terminate();await root.close();client.close();clock.advance(86400000);}
});

it('drains an enabled startup when the fresh root closes before readiness', async()=>{
 const client=new Database(':memory:');
 const clock=new FakeClock(Date.UTC(2026,10,14));
 const db=createDataSchema(client,()=>new Date(clock.now()).toISOString());
 db.insert(measuringSettings).values({singleton:1,on:true,sendOutside:false,keepDays:90}).run();
 const root=sharedRoot({db,clock,originAllowed:()=>true,reportError(){}});
 const closing=root.close();expect(root.close()).toBe(closing);
 await closing;
 expect((await root.measuring).enabled()).toBe(false);
 client.close();clock.advance(2*86400000);
 expect((await root.http.request('http://loom/graphql')).status).toBe(503);
});

it('awaits the real exporter shutdown before root close permits SQLite close', async()=>{
 const client=new Database(':memory:');const clock=new FakeClock(Date.UTC(2026,10,14));
 const db=createDataSchema(client,()=>new Date(clock.now()).toISOString());
 db.insert(measuringSettings).values({singleton:1,on:true,sendOutside:true,outsideAddress:'https://monitor.example/v1/traces',keepDays:0}).run();
 let began!:()=>void, release!:()=>void;
 const started=new Promise<void>(resolve=>{began=resolve;});const held=new Promise<void>(resolve=>{release=resolve;});
 exporter.stop=async()=>{began();await held;};
 const root=sharedRoot({db,clock,originAllowed:()=>true,reportError(){}});await root.ready;
 let closed=false;const stopping=root.close().then(()=>{closed=true;client.close();});
 try {await started;await new Promise<void>(resolve=>setImmediate(resolve));expect(closed).toBe(false);expect(client.open).toBe(true);}
 finally {release();await stopping;exporter.stop=undefined;}
});

it('times shared Secrets recovery without passing values into telemetry',async()=>{
 const client=new Database(':memory:');const clock=new FakeClock(Date.UTC(2026,10,14));
 const db=createDataSchema(client,()=>new Date(clock.now()).toISOString());
 db.insert(measuringSettings).values({singleton:1,on:true,sendOutside:false,keepDays:90}).run();
 const holder={hasReceipt:vi.fn(async()=>false),set:vi.fn(async()=>{}),remove:vi.fn(async()=>{}),recover:vi.fn(async()=>'undone' as const)};
 const root=sharedRoot({db,clock,originAllowed:()=>true,reportError(){},secretWrites:{holder,fingerprintKey:Buffer.alloc(32)}});
 try{await root.ready;await root.services.secrets.reconcile();expect(db.select().from(timingDays).all()).toContainEqual(expect.objectContaining({kind:'job',name:'secrets.reconcile',count:1}));expect(holder.hasReceipt).not.toHaveBeenCalled();}
 finally{await root.close();client.close();clock.advance(86400000);}
});

it('records the shared runtime scheduled sweep with a fixed job name',async()=>{
 const client=new Database(':memory:'),clock=new FakeClock();
 const db=createDataSchema(client,()=>new Date(clock.now()).toISOString());
 db.insert(measuringSettings).values({singleton:1,on:true,sendOutside:false,keepDays:90}).run();
 const root=sharedRoot({db,clock,originAllowed:()=>true,reportError(){}});
 try{await root.ready;clock.advance(30000);
  expect(db.select().from(timingDays).all()).toContainEqual(expect.objectContaining({kind:'job',name:'runtime.tick',count:1}));
 }finally{await root.close();client.close();clock.advance(60000);}
});

it('records the owned Comms expiry sweep without inspecting private words',async()=>{
 const {generateX25519Identity}=await import('age-encryption');
 const {wordsKey}=await import('./pieces/comms/crypto.js');
 const client=new Database(':memory:'),clock=new FakeClock(Date.UTC(2026,10,14,23,59,59,999));
 const db=createDataSchema(client,()=>new Date(clock.now()).toISOString());
 db.insert(measuringSettings).values({singleton:1,on:true,sendOutside:false,keepDays:90}).run();
 const root=sharedRoot({db,clock,originAllowed:()=>true,commsKey:wordsKey(await generateX25519Identity()),reportError(){}});
 try{await root.ready;clock.advance(1);
  expect(db.select().from(timingDays).all()).toContainEqual(expect.objectContaining({kind:'job',name:'conversations.expire',count:1}));
 }finally{await root.close();client.close();clock.advance(30000);}
});
