import {expect,it,vi} from 'vitest';
import {FakeClock} from '../core/clock.js';
import {installMemorySignals} from './memory-signals.js';
it('owns one timer and ignores already-queued metadata and commit callbacks after close',()=>{
 const clock=new FakeClock(0),changed=vi.fn(),stop=vi.fn(),timer=vi.spyOn(clock,'at');let notify=()=>{},at:number|undefined=1000;
 const signals=installMemorySignals(clock,{nextDeadline:()=>at,observeDeadlines(fn){notify=fn;return stop;}},changed);
 // A closer deadline discovered by an initial query replaces the old timer.
 at=500;notify();at=undefined;clock.advance(499);expect(changed).not.toHaveBeenCalled();clock.advance(1);expect(changed).toHaveBeenCalledTimes(1);
 // A committed change notifies the shared data service and recomputes metadata.
 at=1000;signals.changed();expect(changed).toHaveBeenCalledTimes(2);
 const scheduled=timer.mock.calls.length;signals.close();signals.close();expect(stop).toHaveBeenCalledTimes(1);
 at=600;notify();signals.changed();clock.advance(86400000);expect(changed).toHaveBeenCalledTimes(2);expect(timer).toHaveBeenCalledTimes(scheduled);
});
it('unregisters the metadata observer if initial deadline discovery fails',()=>{
 const stop=vi.fn();
 expect(()=>installMemorySignals(new FakeClock(),{observeDeadlines:()=>stop,nextDeadline(){throw Error('Fictional metadata failure');}},()=>{})).toThrow('Fictional metadata failure');
 expect(stop).toHaveBeenCalledTimes(1);
});
