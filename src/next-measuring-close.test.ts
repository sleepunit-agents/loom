import {expect,it,vi} from 'vitest';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {FakeClock} from './core/clock.js';
const f=vi.hoisted(()=>({shutdown:vi.fn(async()=>{throw new Error('exporter shutdown failed');})}));
vi.mock('@opentelemetry/exporter-trace-otlp-proto',()=>({OTLPTraceExporter:class{
 export(_spans:unknown[],done:(result:{code:number})=>void){done({code:0});}
 shutdown(){return f.shutdown();}
}}));
import {startLoom} from './foundation.js';
it('drains the remaining next lifecycles even when exporter shutdown rejects',async()=>{
 const home=mkdtempSync(join(tmpdir(),'next-measuring-close-')),clock=new FakeClock();
 const loom=await startLoom({home,next:true,clock,stdout(){},install(app){
  app.db.function('loom_now',()=>new Date(clock.now()).toISOString());
  app.db.exec(readFileSync(new URL('../assets/data/schema.sql',import.meta.url),'utf8'));
  app.db.prepare('INSERT INTO measuring_settings(singleton,"on",send_outside,outside_address,keep_days) VALUES (1,1,1,?,0)').run('https://monitor.example/v1/traces');
 }});
 try{
  await expect(loom.close()).rejects.toThrow('exporter shutdown failed');
  expect(f.shutdown).toHaveBeenCalledOnce();
  expect(loom.db.open).toBe(false);
  expect(()=>clock.advance(86400000)).not.toThrow();
 }finally{rmSync(home,{recursive:true,force:true});}
});
