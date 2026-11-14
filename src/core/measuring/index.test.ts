import { describe, expect, it, vi } from 'vitest';
import { createMeasuring, DEFAULT_MEASURING, type Measuring, type TimingDay, type TimingStore } from './index.js';
import { FakeClock } from '../clock.js';

const sent = vi.hoisted(() => ({ spans: [] as unknown[], options: [] as unknown[] }));
vi.mock('@opentelemetry/exporter-trace-otlp-proto', () => ({
  OTLPTraceExporter: class {
    constructor(options: unknown) { sent.options.push(options); }
    export(spans: unknown[], done: (result: {code:number}) => void) { sent.spans.push(...spans); done({code:0}); }
    async shutdown() {}
  },
}));
const targets = [{kind:'request',name:'tasks'}, {kind:'operation',name:'tasks.create'}, {kind:'job',name:'github.read'}] as const;
const enabled = { ...DEFAULT_MEASURING, on:true };
function storage() {
  const rows: TimingDay[] = [];
  const prune = vi.fn();
  const store: TimingStore = { add: row => { rows.push(row); }, prune };
  return {store,rows,prune};
}

describe('optional OpenTelemetry measuring', () => {
  it('off does not inspect destinations or touch storage, and preserves values and errors', async () => {
    const {store,rows,prune} = storage();
    const m = await createMeasuring({...DEFAULT_MEASURING, outside_address:'invalid', send_outside:true}, targets, store);
    const value = {};
    expect(m.run('request','tasks',()=>value)).toBe(value);
    const promise = Promise.resolve(value);
    expect(m.runAsync('request','tasks',()=>promise)).toBe(promise);
    const error = new Error('private failure');
    expect(()=>m.run('request','tasks',()=>{throw error;})).toThrow(error);
    await m.flush(); await m.close();
    expect(rows).toEqual([]); expect(prune).not.toHaveBeenCalled();
    expect(sent.options).toEqual([]);
  });

  it('records request, operation and job completion once, including thrown/rejected work', async () => {
    const {store,rows,prune} = storage();
    const m = await createMeasuring(enabled,targets,store);
    const error = new Error('private failure');
    expect(m.run('request','tasks',()=>42)).toBe(42);
    expect(()=>m.run('operation','tasks.create',()=>{throw error;})).toThrow(error);
    await expect(m.runAsync('job','github.read',async()=>{throw error;})).rejects.toBe(error);
    expect(rows.map(r=>[r.kind,r.name,r.count])).toEqual(targets.map(t=>[t.kind,t.name,1]));
    for (const row of rows) {
      expect(row.total_ms).toBeGreaterThanOrEqual(0);
      expect(row.slowest_ms).toBe(row.total_ms); expect(row.typical_ms).toBe(row.total_ms);
      expect(prune).toHaveBeenCalledWith(new Date(Date.parse(row.day)-89*86400_000).toISOString().slice(0,10));
    }
    expect(JSON.stringify(rows)).not.toContain('private');
    await m.close();
  });

  it('does not count an unfinished promise and fences it when disabled', async () => {
    const {store,rows} = storage();
    const m = await createMeasuring(enabled,targets,store);
    let finish!: (n:number)=>void;
    const result=m.runAsync('job','github.read',()=>new Promise<number>(resolve=>{finish=resolve;}));
    expect(rows).toEqual([]);
    const closing=m.close(); expect(m.close()).toBe(closing); await closing;
    finish(7); expect(await result).toBe(7);
    expect(m.run('request','tasks',()=>8)).toBe(8);
    expect(rows).toEqual([]);
  });

  it('does not retain unregistered names or recursively measure the measuring store', async () => {
    let m: Measuring;
    const add=vi.fn(()=>{m.run('request','tasks',()=>true);});
    m=await createMeasuring(enabled,targets,{add,prune(){}});
    expect(m.run('request','secret-user-query',()=>1)).toBe(1);
    expect(add).not.toHaveBeenCalled();
    m.run('request','tasks',()=>2);
    expect(add).toHaveBeenCalledTimes(1);
    await m.close();
  });

  it('storage and diagnostic failures never change application results', async () => {
    const report=vi.fn(()=>{throw new Error('report failed');});
    const m=await createMeasuring(enabled,targets,{prune(){throw new Error('disk full');},add(){throw new Error('unreachable');}},report);
    expect(m.run('request','tasks',()=>9)).toBe(9);
    await expect(m.runAsync('job','github.read',async()=>10)).resolves.toBe(10);
    expect(report).toHaveBeenCalledTimes(3); // startup retention and both completions
    await m.close();
  });

  it('expires an idle local store on startup and each UTC midnight, and stops on close', async () => {
    const clock = new FakeClock(Date.UTC(2026, 10, 14, 23));
    const {store, rows, prune} = storage();
    const m = await createMeasuring({...enabled, keep_days: 2}, targets, store, undefined, clock);
    expect(prune.mock.calls).toEqual([['2026-11-13']]);
    clock.advance(3600_000);
    expect(prune.mock.calls).toEqual([['2026-11-13'], ['2026-11-14']]);
    clock.advance(86400_000);
    expect(prune.mock.calls.at(-1)).toEqual(['2026-11-15']);
    expect(rows).toEqual([]);
    await m.close();
    clock.advance(3 * 86400_000);
    expect(prune).toHaveBeenCalledTimes(3);
  });

  it('retries idle retention after a storage failure without breaking the timer', async () => {
    const clock = new FakeClock(Date.UTC(2026, 10, 14));
    const report = vi.fn();
    const prune = vi.fn().mockImplementationOnce(() => { throw new Error('busy'); });
    const m = await createMeasuring(enabled, targets, {add(){}, prune}, report, clock);
    expect(report).toHaveBeenCalledTimes(1);
    clock.advance(86400_000);
    expect(prune).toHaveBeenCalledTimes(2);
    await m.close();
  });

  it('does not access a clock when off or when using only the outside destination', async () => {
    const clock = {now: vi.fn(() => {throw new Error('clock touched');}), at: vi.fn(() => {throw new Error('timer touched');})};
    const m = await createMeasuring(DEFAULT_MEASURING, targets, undefined, undefined, clock);
    await m.close();
    const outside = await createMeasuring({...enabled, send_outside:true, outside_address:'http://localhost:4318/v1/traces'}, targets, undefined, undefined, clock);
    await outside.close();
    expect(clock.now).not.toHaveBeenCalled();
    expect(clock.at).not.toHaveBeenCalled();
  });

  it('does not rearm retention when diagnostics close measuring during expiry', async () => {
    const clock = new FakeClock(Date.UTC(2026, 10, 14));
    const schedule = vi.spyOn(clock, 'at');
    let closing: Promise<void> | undefined;
    const prune = vi.fn().mockImplementationOnce(() => {}).mockImplementation(() => {throw new Error('busy');});
    const m = await createMeasuring(enabled, targets, {add(){}, prune}, () => {closing = m.close();}, clock);
    clock.advance(86400_000);
    await closing;
    expect(schedule).toHaveBeenCalledTimes(1);
    clock.advance(86400_000);
    expect(prune).toHaveBeenCalledTimes(2);
  });

  it('uses one span for local and OTLP destinations, with bounded batches and no application payload', async () => {
    sent.options.length=0; sent.spans.length=0;
    const {store,rows}=storage();
    const m=await createMeasuring({...enabled,send_outside:true,outside_address:'https://monitor.example/v1/traces'},targets,store);
    m.run('request','tasks',()=>({private:'result'}));
    await m.flush();
    expect(rows).toHaveLength(1); expect(sent.spans).toHaveLength(1);
    expect(sent.spans[0]).toMatchObject({name:'tasks',attributes:{'loom.kind':'request'}});
    const span=sent.spans[0] as {attributes:unknown;events:unknown;status:unknown};
    expect(JSON.stringify([span.attributes,span.events,span.status])).not.toContain('private');
    expect(sent.options).toEqual([{url:'https://monitor.example/v1/traces',timeoutMillis:3000,headers:{}}]);
    await m.close();
  });

  it('supports outside-only mode and rejects missing destinations and unbounded configuration', async () => {
    const m=await createMeasuring({...enabled,send_outside:true,outside_address:'http://localhost:4318/v1/traces'},targets);
    await m.close();
    await expect(createMeasuring(enabled,targets)).rejects.toThrow('destination');
    for (const keep_days of [0,Infinity,1.5,3651])
      await expect(createMeasuring({...enabled,keep_days},targets)).rejects.toThrow('keep_days');
    await expect(createMeasuring(enabled,[{kind:'request',name:'/private/query'}])).rejects.toThrow('inventory');
    await expect(createMeasuring(enabled,Array(2049).fill(targets[0]))).rejects.toThrow('inventory');
    for (const outside_address of ['file:///tmp/out','https://name:password@example.com/v1/traces','https://example.com/?secret=yes'])
      await expect(createMeasuring({...enabled,send_outside:true,outside_address},targets)).rejects.toThrow('Outside address');
  });
});
