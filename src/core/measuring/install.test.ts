import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Foundation } from '../app.js';
import { FakeClock } from '../clock.js';
import { createDataSchema } from '../data/database.js';
import { OperationResults } from '../data/operation-results.js';
import { agents, members, timingDays, measuringSettings } from '../data/schema.js';
import { Operations } from '../operations/index.js';
import { DEFAULT_MEASURING } from './index.js';
import { installMeasuring } from './install.js';

const exported=vi.hoisted(()=>[] as unknown[]);
vi.mock('@opentelemetry/exporter-trace-otlp-proto',()=>({OTLPTraceExporter:class{
 export(spans:unknown[],done:(result:{code:number})=>void){exported.push(...spans);done({code:0});}
 async shutdown(){}
}}));
it('installs owner-approved measuring on the actual operation dispatcher and fences shutdown', async () => {
 const client = new Database(':memory:');
 const clock = new FakeClock(Date.UTC(2026,10,14));
 const retention = new Set<symbol>();
 const at = clock.at.bind(clock), midnight=clock.now()+86400000;
 clock.at=(time,fn)=>{
  const key=Symbol();if(time===midnight)retention.add(key);
  const cancel=at(time,()=>{retention.delete(key);fn();});
  return ()=>{retention.delete(key);cancel();};
 };
 const db = createDataSchema(client, () => new Date(clock.now()).toISOString());
 db.insert(members).values([{id:'owner',role:'owner',joinedAt:new Date(clock.now()).toISOString()},{id:'guest',role:'member',joinedAt:new Date(clock.now()).toISOString()}]).run();
 db.insert(agents).values(['art','mark'].map(id=>({id,about:'',markBg:'#fff',markFg:'#000',faceShape:'pebble' as const,faceEyes:'dot' as const}))).run();
 const receipts = new OperationResults(db);
 let failReceipt = false;
 const insert = receipts.insert.bind(receipts);
 receipts.insert = row => {insert(row);if(failReceipt)throw new Error('receipt failed');};
 const operations = new Operations(client, clock, () => {}, {receipts});
 operations.register({name:'example.read',input:z.object({}),output:z.number(),may:()=>true,run:()=>42});
 const stops: (()=>void)[]=[];
 const app = {db:client,operations,live:{changed(){}},onClose:(stop:()=>void)=>stops.push(stop)} as Foundation;
 const meter = await installMeasuring(app,db);
 let seq=0;
 const call=(name:string,input:unknown,who='owner',id=String(++seq))=>operations.call('http',{kind:who==='art'?'agent':'member',id:who},name,input,id);
 try {
  expect(meter.enabled()).toBe(false);
  call('example.read',{});
  expect(db.select().from(timingDays).all()).toEqual([]);
  const proposal={after:{...DEFAULT_MEASURING,on:true},agent:'art',why:'Find slow work'};
  for(const door of ['mcp','socket'] as const) {
   expect(operations.call(door,{kind:'member',id:'owner'},'measuring.propose',proposal,'door-'+door)).toMatchObject({ok:false,code:'denied'});
   expect(operations.call(door,{kind:'member',id:'owner'},'measuring.answer',{id:'missing',allow:true},'answer-'+door)).toMatchObject({ok:false,code:'denied'});
  }
  expect(call('measuring.propose',proposal,'guest')).toMatchObject({ok:false,code:'denied'});
  expect(call('measuring.propose',{...proposal,agent:'mark'},'art')).toMatchObject({ok:false,code:'denied'});
  expect(operations.call('http',{kind:'agent',id:'missing'},'measuring.propose',{...proposal,agent:'missing'},'missing')).toMatchObject({ok:false,code:'denied'});
  const card=call('measuring.propose',proposal,'art');
  expect(card.ok).toBe(true);if(!card.ok)throw new Error('proposal failed');
  const id=(card.value as {id:string}).id;
  expect(call('measuring.answer',{id,allow:true},'art')).toMatchObject({ok:false,code:'denied'});
  expect(call('measuring.answer',{id,allow:true},'guest')).toMatchObject({ok:false,code:'denied'});
  client.prepare("UPDATE members SET role='member' WHERE id='owner'").run();
  expect(call('measuring.answer',{id,allow:true})).toMatchObject({ok:false,code:'denied'});
  client.prepare("UPDATE members SET role='owner' WHERE id='owner'").run();
  expect(db.select().from(measuringSettings).all()).toEqual([]);
  failReceipt = true;
  expect(call('measuring.answer',{id,allow:true})).toMatchObject({ok:false,code:'unavailable'});
  await Promise.resolve();
  expect(db.select().from(measuringSettings).all()).toEqual([]);
  expect(meter.enabled()).toBe(false);
  failReceipt = false;
  expect(call('measuring.answer',{id,allow:true})).toMatchObject({ok:true});
  await meter.settled();
  expect(meter.enabled()).toBe(true);
  expect(retention.size).toBe(1);
  expect(call('example.read',{})).toEqual({ok:true,value:42});
  await meter.runAsync('job','changes.read',async()=>1);
  meter.run('request','graphql',()=>1);
  expect(db.select().from(timingDays).all()).toEqual(expect.arrayContaining([
   expect.objectContaining({kind:'operation',name:'example.read',count:1}),
   expect.objectContaining({kind:'job',name:'changes.read',count:1}),
   expect.objectContaining({kind:'request',name:'graphql',count:1}),
  ]));
  const outside={...proposal,after:{...DEFAULT_MEASURING,on:true,keep_days:0,send_outside:true,outside_address:'https://monitor.example/v1/traces'}};
  const direct=operations.call('direct',{kind:'member',id:'owner'},'measuring.propose',outside,'outside');
  if(!direct.ok)throw new Error('direct proposal failed');
  expect(call('measuring.answer',{id:(direct.value as {id:string}).id,allow:true})).toMatchObject({ok:true});
  await meter.settled();
  expect(meter.enabled()).toBe(true);
  expect(retention.size).toBe(0);
  const localBefore=db.select().from(timingDays).all();
  meter.run('request','graphql',()=>42);
  await meter.flush();
  expect(exported).toHaveLength(1);
  expect(db.select().from(timingDays).all()).toEqual(localBefore);
  const disabling = call('measuring.propose',{...proposal,after:{...DEFAULT_MEASURING,on:false}},'art');
  if(!disabling.ok)throw new Error('disable proposal failed');
  expect(call('measuring.answer',{id:(disabling.value as {id:string}).id,allow:true})).toMatchObject({ok:true});
  await meter.settled();
  expect(meter.enabled()).toBe(false);
  const before=db.select().from(timingDays).all();
  call('example.read',{});
  expect(db.select().from(timingDays).all()).toEqual(before);



 } finally {await meter.close();stops.forEach(stop=>stop());operations.close();client.close();clock.advance(86400000);}
});
