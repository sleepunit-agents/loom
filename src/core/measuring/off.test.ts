import { expect, it, vi } from 'vitest';
import { createMeasuring, DEFAULT_MEASURING } from './index.js';

const loaded=vi.hoisted(()=>({sdk:0}));
vi.mock('@opentelemetry/sdk-trace',()=>{loaded.sdk++;throw new Error('SDK must not load');});
vi.mock('@opentelemetry/exporter-trace-otlp-proto',()=>{throw new Error('Exporter must not load');});

it('does not even load the SDK when measuring is off',async()=>{
  const m=await createMeasuring(DEFAULT_MEASURING,[],{add(){throw new Error('store touched');},prune(){throw new Error('store touched');}});
  expect(m.run('job','example',()=>123)).toBe(123);
  await m.close();
  expect(loaded.sdk).toBe(0);
  // The mock really would catch an import if the guard moved below SDK setup.
  await expect(createMeasuring({...DEFAULT_MEASURING,on:true},[],{add(){},prune(){}})).rejects.toThrow();
  expect(loaded.sdk).toBe(1);
});
