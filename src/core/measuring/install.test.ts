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
import { measuringSettingsService } from './settings.js';

const exported=vi.hoisted(()=>[] as unknown[]);
vi.mock('@opentelemetry/exporter-trace-otlp-proto',()=>({OTLPTraceExporter:class{
 export(spans:unknown[],done:(result:{code:number})=>void){exported.push(...spans);done({code:0});}
 async shutdown(){}
}}));
it('turns measuring on, out and off on the actual operation dispatcher as its settings change, and fences shutdown', async () => {
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
 // The root changes Measuring's settings (after a proposal is allowed) and then calls refresh().
 const settingsNow = measuringSettingsService(db);
 const meter = await installMeasuring(app,db);
 const set = async (after: typeof DEFAULT_MEASURING) => { settingsNow.write(after); await meter.refresh(); await meter.settled(); };
 expect(operations.has('measuring.answer')).toBe(false); expect(operations.has('measuring.propose')).toBe(false);
 let seq=0;
 const call=(name:string,input:unknown,who='owner',id=String(++seq))=>operations.call('http',{kind:who==='art'?'agent':'member',id:who},name,input,id);
 try {
  expect(meter.enabled()).toBe(false);
  call('example.read',{});
  expect(db.select().from(timingDays).all()).toEqual([]);
  expect(db.select().from(measuringSettings).all()).toEqual([]);
  await set({...DEFAULT_MEASURING,on:true});
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
  await set({...DEFAULT_MEASURING,on:true,keep_days:0,send_outside:true,outside_address:'https://monitor.example/v1/traces'});
  expect(meter.enabled()).toBe(true);
  expect(retention.size).toBe(0);
  const localBefore=db.select().from(timingDays).all();
  meter.run('request','graphql',()=>42);
  await meter.flush();
  expect(exported).toHaveLength(1);
  expect(db.select().from(timingDays).all()).toEqual(localBefore);
  await set({...DEFAULT_MEASURING,on:false});
  expect(meter.enabled()).toBe(false);
  const before=db.select().from(timingDays).all();
  call('example.read',{});
  expect(db.select().from(timingDays).all()).toEqual(before);



 } finally {await meter.close();stops.forEach(stop=>stop());operations.close();client.close();clock.advance(86400000);}
});

it('publishes idle retention deletions to agents watching local daily rows',async()=>{
 const client=new Database(':memory:'),clock=new FakeClock(Date.UTC(2026,10,14));
 const db=createDataSchema(client,()=>new Date(clock.now()).toISOString());
 db.insert(measuringSettings).values({singleton:1,on:true,sendOutside:false,keepDays:1}).run();
 const operations=new Operations(client,clock,()=>{}, {receipts:new OperationResults(db)});
 const changed=vi.fn();
 const meter=await installMeasuring({operations,live:{changed},onClose(){}},db);
 try{
  meter.run('job','changes.read',()=>{});
  expect(db.select().from(timingDays).all()).toHaveLength(1);
  changed.mockClear();clock.advance(86400000);
  expect(db.select().from(timingDays).all()).toEqual([]);
  expect(changed).toHaveBeenCalledWith([{type:'measuring',id:'timing'}]);
 }finally{await meter.close();operations.close();client.close();}
});
