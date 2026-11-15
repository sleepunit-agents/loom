import {afterEach,it,expect,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {responseForAction} from './rebuild-response-capture.mjs';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return{promise,resolve};};
const match=(request:{path:string})=>request.path==='/send';
const answer=(request:unknown)=>({request:()=>request});
afterEach(()=>vi.useRealTimers());
it('does not spend response time on actionability, and retains a response received before activation resolves',async()=>{
 vi.useFakeTimers();const page=new EventEmitter(),gate=deferred(),request={path:'/send'},response=answer(request);
 const waiting=responseForAction(page,match,()=>gate.promise);
 await vi.advanceTimersByTimeAsync(8001);expect(vi.getTimerCount()).toBe(0);
 page.emit('request',request);page.emit('response',response);gate.resolve();
 expect(await waiting).toBe(response);expect(page.listenerCount('request')).toBe(0);expect(page.listenerCount('response')).toBe(0);expect(vi.getTimerCount()).toBe(0);
});
it('starts the unchanged response deadline at its request even while activation is pending',async()=>{
 vi.useFakeTimers();const page=new EventEmitter(),gate=deferred();
 const waiting=responseForAction(page,match,()=>gate.promise),failed=expect(waiting).rejects.toThrow('matching HTTP response');
 page.emit('request',{path:'/send'});await vi.advanceTimersByTimeAsync(4000);gate.resolve();await failed;
 expect(page.listenerCount('request')).toBe(0);expect(page.listenerCount('response')).toBe(0);expect(vi.getTimerCount()).toBe(0);
});
it('bounds an activation that emits no request',async()=>{
 vi.useFakeTimers();const page=new EventEmitter(),waiting=responseForAction(page,match,async()=>{}),failed=expect(waiting).rejects.toThrow('did not send');
 await vi.advanceTimersByTimeAsync(4000);await failed;expect(page.eventNames()).toEqual([]);expect(vi.getTimerCount()).toBe(0);
});
it('ignores another request response and keeps unrelated page observers',async()=>{
 vi.useFakeTimers();const page=new EventEmitter(),keeper=vi.fn();page.on('request',keeper);
 const request={path:'/send'},other={path:'/read'},response=answer(request);
 const waiting=responseForAction(page,match,async()=>{page.emit('request',other);page.emit('response',answer(other));page.emit('request',request);page.emit('response',answer(other));page.emit('response',response);});
 expect(await waiting).toBe(response);expect(keeper).toHaveBeenCalledTimes(2);expect(page.listeners('request')).toEqual([keeper]);expect(page.listenerCount('response')).toBe(0);expect(vi.getTimerCount()).toBe(0);
});
it('cleans its listeners and deadline when activation fails after emitting a request',async()=>{
 vi.useFakeTimers();const page=new EventEmitter();
 await expect(responseForAction(page,match,async()=>{page.emit('request',{path:'/send'});throw Error('activation failed');})).rejects.toThrow('activation failed');
 expect(page.eventNames()).toEqual([]);expect(vi.getTimerCount()).toBe(0);
});
it('contains predicate failures and removes both listeners',async()=>{
 vi.useFakeTimers();const page=new EventEmitter();
 await expect(responseForAction(page,()=>{throw Error('predicate failed');},async()=>{page.emit('request',{});})).rejects.toThrow('predicate failed');
 expect(page.eventNames()).toEqual([]);expect(vi.getTimerCount()).toBe(0);
});
