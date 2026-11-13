import { it, expect } from 'vitest';
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
