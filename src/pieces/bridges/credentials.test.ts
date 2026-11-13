import { expect, it, vi } from 'vitest';
import { FakeClock } from '../../core/clock.js';
import { bridgeCredentials } from './credentials.js';
const first='00000000-0000-4000-8000-000000000000';
const second='00000000-0000-4000-8000-000000000001';
async function settle(){for(let i=0;i<30;i++)await Promise.resolve();}
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
it('waits for initial public generation and notifies only changes or loss/recovery',async()=>{
  const clock=new FakeClock(),held=deferred<string>();
  const generation=vi.fn(()=>held.promise),changed=vi.fn();
  const monitor=bridgeCredentials({generation},clock);monitor.observe(changed);
  try {
    await settle();expect(monitor.current()).toBeUndefined();expect(changed).not.toHaveBeenCalled();
    held.resolve(first);await settle();expect(monitor.current()).toBe(first);expect(changed).toHaveBeenCalledTimes(1);
    generation.mockResolvedValue(first);clock.advance(5000);await settle();expect(changed).toHaveBeenCalledTimes(1);
    generation.mockResolvedValue(second);clock.advance(5000);await settle();expect(monitor.current()).toBe(second);expect(changed).toHaveBeenCalledTimes(2);
    generation.mockRejectedValue(Error('PRIVATE ERROR'));clock.advance(5000);await settle();expect(monitor.current()).toBeUndefined();expect(changed).toHaveBeenCalledTimes(3);
    generation.mockResolvedValue(second);clock.advance(5000);await settle();expect(monitor.current()).toBe(second);expect(changed).toHaveBeenCalledTimes(4);
  } finally {monitor.close();}
});
it.each(['',first+'\n','not-a-generation','00000000-0000-1000-8000-000000000000'])('refuses malformed generation %j',async value=>{
  const clock=new FakeClock(),generation=vi.fn(()=>first),changed=vi.fn();
  const monitor=bridgeCredentials({generation},clock);monitor.observe(changed);
  await settle();expect(monitor.current()).toBe(first);changed.mockClear();
  generation.mockReturnValue(value);clock.advance(5000);await settle();
  expect(monitor.current()).toBeUndefined();expect(changed).toHaveBeenCalledOnce();monitor.close();
});
it('bounds a stalled poll, ignores its late result and recovers independently',async()=>{
  const clock=new FakeClock(),held=deferred<string>(),generation=vi.fn(async()=>first);
  const monitor=bridgeCredentials({generation},clock);
  try {
    await settle();generation.mockImplementationOnce(()=>held.promise);clock.advance(5000);await settle();
    clock.advance(4999);await settle();expect(monitor.current()).toBe(first);
    clock.advance(1);await settle();expect(monitor.current()).toBeUndefined();
    held.resolve(second);await settle();expect(monitor.current()).toBeUndefined();
    clock.advance(5000);await settle();expect(monitor.current()).toBe(first);
  } finally {monitor.close();}
});
it('contains synchronous provider failure and stops timers/listeners on close during a read',async()=>{
  const clock=new FakeClock(),held=deferred<string>();
  const generation=vi.fn<()=>Promise<string>|string>(()=>{throw Error('PRIVATE');});
  const monitor=bridgeCredentials({generation},clock),changed=vi.fn();const unsubscribe=monitor.observe(changed);
  await settle();expect(monitor.current()).toBeUndefined();generation.mockImplementation(()=>held.promise);
  clock.advance(5000);await settle();unsubscribe();monitor.close();monitor.close();
  held.resolve(first);await settle();clock.advance(60_000);await settle();
  expect(monitor.current()).toBeUndefined();expect(generation).toHaveBeenCalledTimes(2);expect(changed).not.toHaveBeenCalled();
});
