import { expect, it, vi } from 'vitest';
import { notificationController, type NotificationBrowser } from './notifications';
import { createMutationStore } from '../../data/mutation';
import type { Call, CallState, Result } from '../../data';
function fixture(){
  const sub={toJSON:()=>({endpoint:'https://fcm.googleapis.com/private',expirationTime:null,keys:{p256dh:'p'.repeat(87),auth:'a'.repeat(22)}}),unsubscribe:vi.fn(async()=>true)};
  let current:typeof sub|null=null;
  const browser:NotificationBrowser={supported:()=>true,permission:()=> 'granted',ask:vi.fn(async()=> 'granted'),current:vi.fn(async()=>current),create:vi.fn(async()=>{current=sub;return sub;})};
  const requests:Array<{name:string;input:unknown;handle:Call;finish(r:Result):void}>=[];
  const send=vi.fn((name:string,input:unknown)=>{
    let state:CallState={pending:true,status:'pending'};const listeners=new Set<()=>void>();
    const handle:Call={id:`stable-${requests.length}`,result:new Promise(()=>{}),getSnapshot:()=>state,subscribe:fn=>{listeners.add(fn);return()=>{listeners.delete(fn);};},retry:vi.fn(()=>{state={pending:true,status:'pending'};listeners.forEach(fn=>fn());})};
    requests.push({name,input,handle,finish:r=>{state={pending:false,status:'done',result:r};listeners.forEach(fn=>fn());}});return handle;
  });
  const changes=createMutationStore(),controller=notificationController(browser,send as never,changes);
  const ready=async()=>{controller.setEnabled(true);await vi.waitFor(()=>expect(controller.getSnapshot().busy).toBe(false));};
  return {sub,browser,requests,changes,controller,ready,setCurrent:()=>{current=sub;}};
}
it('keeps the original uncertain request and resumes its continuation once after retry',async()=>{
  const f=fixture();await f.ready();const work=f.controller.enable();
  await vi.waitFor(()=>expect(f.requests).toHaveLength(1));expect(f.requests[0].name).toBe('notifications.key');
  f.requests[0].finish({ok:false,code:'unavailable',message:'Uncertain'});expect(f.controller.getSnapshot().busy).toBe(true);
  await f.controller.enable();expect(f.requests).toHaveLength(1);
  f.changes.getSnapshot().request!.retry!();expect(f.changes.getSnapshot().request).toBe(f.requests[0].handle);
  f.requests[0].finish({ok:true,value:{publicKey:'public'}});
  await vi.waitFor(()=>expect(f.requests).toHaveLength(2));expect(f.requests[1].input).toEqual({sub:f.sub.toJSON()});
  f.requests[1].finish({ok:true,value:{status:'added'}});await work;expect(f.controller.getSnapshot().on).toBe(true);
  const off=f.controller.disable();await vi.waitFor(()=>expect(f.requests).toHaveLength(3));expect(f.requests[2].name).toBe('notifications.unsubscribe');
  f.requests[2].finish({ok:false,code:'unavailable',message:'Uncertain'});expect(f.sub.unsubscribe).not.toHaveBeenCalled();
  f.requests[2].handle.retry!();f.requests[2].finish({ok:true,value:{removed:true}});await off;expect(f.sub.unsubscribe).toHaveBeenCalledOnce();expect(f.controller.getSnapshot().on).toBe(false);
});
it('stops late key replies on inactive/offline/navigation and never silently enables later',async()=>{
  const f=fixture();await f.ready();const work=f.controller.enable();await vi.waitFor(()=>expect(f.requests).toHaveLength(1));
  f.controller.setEnabled(false);f.controller.setEnabled(true);f.requests[0].finish({ok:true,value:{publicKey:'public'}});await work;
  expect(f.browser.create).not.toHaveBeenCalled();f.controller.setEnabled(true);expect(f.requests).toHaveLength(1);
});
it('quietly registers an existing subscription once and honors a remote removal',async()=>{
  const f=fixture();f.setCurrent();f.controller.setEnabled(true);await vi.waitFor(()=>expect(f.requests).toHaveLength(1));
  expect(f.requests[0].input).toEqual({sub:f.sub.toJSON(),again:true});f.requests[0].finish({ok:true,value:{status:'removed'}});
  await vi.waitFor(()=>expect(f.controller.getSnapshot().busy).toBe(false));expect(f.sub.unsubscribe).toHaveBeenCalledOnce();
  f.controller.setEnabled(false);f.controller.setEnabled(true);expect(f.requests).toHaveLength(1);
});
it('does not register on permission refusal or discard the browser subscription after server denial',async()=>{
  const f=fixture();await f.ready();vi.mocked(f.browser.ask).mockResolvedValue('denied');await f.controller.enable();expect(f.requests).toHaveLength(0);
  expect(f.controller.getSnapshot().message).toContain('blocked');f.setCurrent();const work=f.controller.disable();await vi.waitFor(()=>expect(f.requests).toHaveLength(1));f.requests[0].finish({ok:false,code:'denied',message:'No'});await work;expect(f.sub.unsubscribe).not.toHaveBeenCalled();
});
