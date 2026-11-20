import { expect,it,vi } from 'vitest';
import { MachineReadBroker } from './machine-read-broker.js';

it('delivers once, only to the selected worker, and forgets its answer', async()=>{
 const broker=new MachineReadBroker();
 const answer=broker.ask('east','memory',{},()=>true);
 expect(broker.next('west')).toBeNull();
 const work=broker.next('east')!;
 expect(broker.next('east')).toBeNull();
 expect(broker.finish('west',work.id,'private sample')).toBe(false);
 expect(broker.finish('east',work.id,'sample')).toBe(true);
 expect(await answer).toEqual({lines:['sample']});
 expect(broker.finish('east',work.id,'duplicate')).toBe(false);
});
it('expires unanswered reads and refuses late answers',async()=>{
 vi.useFakeTimers();
 try{
  const broker=new MachineReadBroker();
  const answer=broker.ask('east','disk',{},()=>true);
  const work=broker.next('east')!;
  await vi.advanceTimersByTimeAsync(10_001);
  expect(broker.finish('east',work.id,'already expired')).toBe(false);
  expect(await answer).toEqual({refusal:'Machine read timed out'});
  expect(broker.finish('east',work.id,'late')).toBe(false);
 }finally{vi.useRealTimers();}
});
it('rechecks permission before dispatch and before returning a result',async()=>{
 const broker=new MachineReadBroker();let allowed=true;
 const first=broker.ask('east','disk',{},()=>allowed);
 allowed=false;expect(broker.next('east')).toBeNull();expect(await first).toHaveProperty('refusal');
 allowed=true;
 const second=broker.ask('east','disk',{},()=>allowed);
 const work=broker.next('east')!;
 allowed=false;broker.finish('east',work.id,'private sample');expect(await second).toHaveProperty('refusal');
});
it('bounds concurrency and bytes, rejecting oversized output in full',async()=>{
 const broker=new MachineReadBroker();
 const first=broker.ask('east','memory',{},()=>true);
 expect(await broker.ask('east','disk',{},()=>true)).toHaveProperty('refusal');
 const work=broker.next('east')!;
 broker.finish('east',work.id,'é'.repeat(20000));
 expect(await first).toEqual({refusal:'Machine answer too big'});
});

it('ends waiting calls at shutdown',async()=>{
 const broker=new MachineReadBroker();
 const result=broker.ask('east','memory',{},()=>true);
 broker.close();expect(await result).toEqual({refusal:'Machine read interrupted'});
 expect(broker.next('east')).toBeNull();
});

it('drops a cancelled wait before worker delivery, withholding every late reply',async()=>{
 const broker=new MachineReadBroker(),stop=new AbortController();
 const result=broker.ask('east','memory',{},()=>true,stop.signal);
 stop.abort();
 expect(await result).toEqual({refusal:'Machine read cancelled'});
 expect(broker.next('east')).toBeNull();
});

it.each(['authorization: Bearer example', 'xoxb-examplevalue', 'AGE-SECRET-KEY-example'])('also refuses recognizable credentials at the receiving door (%#)',async value=>{
 const broker=new MachineReadBroker();
 const result=broker.ask('east','memory',{},()=>true),work=broker.next('east')!;
 broker.finish('east',work.id,value);
 expect(await result).toEqual({refusal:'Machine answer contains a credential'});
});
