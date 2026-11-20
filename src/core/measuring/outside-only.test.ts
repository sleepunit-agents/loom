import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { FakeClock } from '../clock.js';
import { createDataSchema } from '../data/database.js';
import { timingDays } from '../data/schema.js';
import { DEFAULT_MEASURING } from './index.js';
import { measuringSettingsService } from './settings.js';
import { measuringRuntime } from './runtime.js';
import { timingStore } from './store.js';
const exported = vi.hoisted(() => [] as unknown[]);
vi.mock('@opentelemetry/exporter-trace-otlp-proto', () => ({OTLPTraceExporter:class {
 export(spans:unknown[],done:(result:{code:number})=>void){exported.push(...spans);done({code:0});}
 async shutdown(){}
}}));
it('persists outside-only settings and exports without local writes or retention timers', async()=>{
 const client=new Database(':memory:');
 const clock=new FakeClock(Date.UTC(2026,10,14));
 const schedule=vi.spyOn(clock,'at');
 const db=createDataSchema(client,()=>new Date(clock.now()).toISOString());
 const settings=measuringSettingsService(db);
 const runtime=measuringRuntime(settings.read,[{kind:'request',name:'graphql'}],timingStore(db),undefined,clock);
 try {
  const after={...DEFAULT_MEASURING,on:true,keep_days:0,send_outside:true,outside_address:'https://monitor.example/v1/traces'};
  settings.write(after);
  expect(settings.read()).toEqual(after);
  await runtime.reload();
  runtime.run('request','graphql',()=>42);
  await runtime.flush();
  expect(exported).toHaveLength(1);
  expect(db.select().from(timingDays).all()).toEqual([]);
  expect(schedule).not.toHaveBeenCalled();
  expect(()=>settings.write({...after,send_outside:false,outside_address:''})).toThrow();
 } finally {await runtime.close();client.close();}
});
