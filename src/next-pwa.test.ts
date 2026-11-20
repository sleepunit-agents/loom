import { it, expect, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { nextWorker } from './next-pwa.js';
it('next worker handles only the public build allowlist and deletes legacy caches', async () => {
  const handlers: Record<string, (event:any)=>void> = {};
  const deleted: string[] = [];
  let claimed = false;
  runInNewContext(nextWorker(['/app/assets/main-a.js']), {
    URL, location:{origin:'https://loom.test'},
    self:{ addEventListener:(name:string, fn:any)=>{handlers[name]=fn;}, clients:{claim:()=>{claimed=true;}} },
    caches:{ keys:async()=>['loom-5-views','loom-5-pages'], delete:async(k:string)=>{deleted.push(k);} },
  });
  let work: Promise<unknown> = Promise.resolve();
  handlers.activate({waitUntil:(p:Promise<unknown>)=>{work=p;}}); await work;
  expect(deleted).toEqual(['loom-5-views','loom-5-pages']); expect(claimed).toBe(true);
  for (const [path,method,mode] of [['/api/tasks/list','GET','cors'],['/auth/session','GET','cors'],['/p/tasks-preview','GET','navigate'],['/app/assets/main-a.js?secret=yes','GET','cors'],['/app/assets/main-a.js','POST','cors']]) {
    handlers.fetch({request:{url:'https://loom.test'+path,method,mode},respondWith:()=>{throw new Error('private data intercepted');}});
  }
});

// Run the actual served worker: no browser process or Push service is needed.
// Event/option mocks use any because the Node TS build has no ServiceWorker DOM types.
function notifications(windows: Array<{url:string; navigate?: ReturnType<typeof vi.fn>; focus?: ReturnType<typeof vi.fn>}> = []) {
  const handlers: Record<string, (event:any)=>void> = {};
  const show = vi.fn(async (_title:string, _options:any) => {}), open = vi.fn(async (_url:string) => {});
  const matchAll = vi.fn(async () => windows);
  runInNewContext(nextWorker([]), {
    URL, location: {origin:'https://loom.test'},
    self: {addEventListener:(name:string,fn:any)=>{handlers[name]=fn;}, registration:{showNotification:show}, clients:{matchAll,openWindow:open}},
  });
  async function push(json:()=>unknown) {
    let work:Promise<unknown>|undefined;
    handlers.push({data:{json},waitUntil:(p:Promise<unknown>)=>{work=p;}});
    expect(work).toBeDefined(); await work;
  }
  async function click(url:unknown) {
    let work:Promise<unknown>|undefined;
    const close=vi.fn();
    handlers.notificationclick({notification:{data:{url},close},waitUntil:(p:Promise<unknown>)=>{work=p;}});
    expect(close).toHaveBeenCalledOnce(); expect(work).toBeDefined(); await work;
  }
  return {push,click,show,open,matchAll};
}

it('shows a content-free notification and opens the exact next Comms destination', async () => {
  const f=notifications();
  const url='/p/comms-preview/thread/abc';
  await f.push(()=>({title:'Private thread title',body:'Private reply',tag:'reply-abc',url}));
  expect(f.show).toHaveBeenCalledWith('loom', {body:'',tag:'reply-abc',data:{url:'https://loom.test'+url},icon:'/icons/loom-192.png',badge:'/icons/loom-192.png'});
  expect(JSON.stringify(f.show.mock.calls)).not.toContain('Private');
  await f.click(f.show.mock.calls[0][1].data.url);
  expect(f.open).toHaveBeenCalledWith('https://loom.test'+url);
});

it('malformed payloads still show a safe default and never open an outside or credential-bearing URL', async () => {
  const f=notifications();
  for(const value of [null,[],42,'words',{}, {url:'https://elsewhere.test/private'}, {url:'//elsewhere.test/private'}, {url:'javascript:alert(1)'}, {url:'https://user:pass@loom.test/'}, {url:'https://['}]) {
    await f.push(()=>value);
    expect(f.show.mock.lastCall).toEqual(['loom', {body:'',data:{url:'https://loom.test/'},icon:'/icons/loom-192.png',badge:'/icons/loom-192.png'}]);
  }
  await f.push(()=>{throw new Error('bad JSON');});
  expect(f.show.mock.lastCall?.[0]).toBe('loom');
  await f.click('https://elsewhere.test/private');
  expect(f.open).toHaveBeenLastCalledWith('https://loom.test/');
});

it('navigates then focuses an existing loom window; skips foreign windows and recovers from a closing window', async () => {
  const foreign={url:'https://elsewhere.test/',navigate:vi.fn(),focus:vi.fn()};
  const closing={url:'https://loom.test/',navigate:vi.fn(async()=>{throw new Error('closed');}),focus:vi.fn()};
  const focus=vi.fn(async()=>{}),navigate=vi.fn(async()=>{expect(focus).not.toHaveBeenCalled();});
  const f=notifications([foreign,closing,{url:'https://loom.test/p/tasks-preview',navigate,focus}]);
  await f.click('/inbox?i=ask-key');
  expect(f.matchAll).toHaveBeenCalledWith({type:'window',includeUncontrolled:true});
  expect(foreign.navigate).not.toHaveBeenCalled(); expect(closing.focus).not.toHaveBeenCalled();
  expect(navigate).toHaveBeenCalledWith('https://loom.test/inbox?i=ask-key'); expect(focus).toHaveBeenCalledOnce();
  expect(f.open).not.toHaveBeenCalled();
  const fallback=notifications([closing]);
  await fallback.click('/p/account-preview');
  expect(fallback.open).toHaveBeenCalledWith('https://loom.test/p/account-preview');
});
