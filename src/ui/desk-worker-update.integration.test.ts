import {createServer} from 'node:http';
import {it,expect} from 'vitest';
import {chromium} from 'playwright-core';
import {nextWorker} from '../next-pwa.js';

it.runIf(process.env.LOOM_TEST_CHROME)('keeps an open desk’s lazy code across a deploy, then retires its cache',async()=>{
 let version=1;
 const asset=()=>'/app/assets/tasks-'+version+'.js';
 const server=createServer((req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(req.url==='/sw.js'){
   res.setHeader('Content-Type','text/javascript');
   res.end(nextWorker([asset()]));
  }else if(req.url===asset()){
   res.setHeader('Content-Type','text/javascript');
   res.end('export default '+version);
  }else if(req.url==='/'){
   res.setHeader('Content-Type','text/html');
   res.end(`<button>Open Tasks</button><output></output><script type="module">
    navigator.serviceWorker.register('/sw.js');
    document.querySelector('button').onclick=async()=>{
     document.querySelector('output').textContent=(await import('${asset()}')).default;
    };
   </script>`);
  }else{res.writeHead(404).end();}
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();
 if(!address||typeof address==='string')throw Error('Missing fixture port');
 const url='http://127.0.0.1:'+address.port;
 const browser=await chromium.launch({executablePath:process.env.LOOM_TEST_CHROME});
 try{
  const context=await browser.newContext();
  const desk=await context.newPage();
  await desk.goto(url);
  await desk.waitForFunction(()=>!!navigator.serviceWorker.controller);
  version=2;
  await desk.evaluate(async()=>{await (await navigator.serviceWorker.ready).update();});
  await desk.waitForFunction(async()=>!!(await navigator.serviceWorker.ready).waiting);
  expect((await fetch(url+'/app/assets/tasks-1.js')).status).toBe(404);
  await desk.getByRole('button',{name:'Open Tasks'}).click();
  await desk.locator('output').filter({hasText:'1'}).waitFor();
  await desk.close();
  const fresh=await context.newPage();
  await fresh.goto(url);
  await fresh.getByRole('button',{name:'Open Tasks'}).click();
  await fresh.locator('output').filter({hasText:'2'}).waitFor();
  await fresh.waitForFunction(async()=>!!navigator.serviceWorker.controller&&
   !(await navigator.serviceWorker.ready).waiting&&(await caches.keys()).length===1);
  expect(await fresh.evaluate(async()=>!!(await caches.match('/app/assets/tasks-1.js')))).toBe(false);
 }finally{await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
},45_000);
