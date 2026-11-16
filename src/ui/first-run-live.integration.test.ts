/** Execute the CLI startup and printed first-run link, rather than seeding a
 * credential or hosting a second test-only app. CI owns the real browser. */
import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { chromium } from 'playwright-core';

import {serve as run} from '../index.js';
import { FakeClock,clock as normalClock } from '../core/clock.js';
// In-process private holder fixture; no real child or fake frontend.
vi.mock('../shared-holder-process.js',async()=>({startSharedHolder:(await import('../../test/fixtures/shared-holder.js')).inProcessSharedHolder}));

beforeEach(()=>{vi.stubEnv('LOOM_PUBLIC_URL',undefined);vi.stubEnv('LOOM_WORKER_SOCKET',undefined);});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
const root=resolve(import.meta.dirname,'../../dist/web');
const chrome=[process.env.LOOM_TEST_CHROME,'/usr/bin/google-chrome','/usr/bin/chromium',chromium.executablePath()].find(path=>path&&existsSync(path));
it.runIf(process.env.CI==='true'&&chrome&&existsSync(join(root,'next.html')))('first-run CLI sign-in opens one GraphQL socket, receives task deltas and loses access when the browser ends',async()=>{
 const home=mkdtempSync(join(tmpdir(),'loom-first-browser-')),clock=new FakeClock();
 vi.spyOn(normalClock,'now').mockImplementation(clock.now.bind(clock));
 vi.spyOn(normalClock,'at').mockImplementation(clock.at.bind(clock));
 let printed='',ready!:(url:string)=>void;const listening=new Promise<string>(ok=>{ready=ok;});
 const running=run(['--http','--home',home,'--port','0'],{stdin:Readable.from([]),stdinIsTTY:false,env:{},stdout:text=>{printed+=text;},stderr:text=>{const url=/shared app on (http:\/\/\S+)/.exec(text)?.[1];if(url)ready(url);}});
 let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
 try {
  const url=await Promise.race([listening,running.then(code=>{throw Error('Normal startup stopped: '+code);})]);
  browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1280,height:900}}),page=await context.newPage();
  const paths:string[]=[],frames:string[]=[],errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('websocket',socket=>{paths.push(new URL(socket.url()).pathname);socket.on('framereceived',frame=>{if(new URL(socket.url()).pathname==='/graphql')frames.push(String(frame.payload));});});
  await page.goto(printed.trim());
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect.poll(()=>frames.some(frame=>frame.includes('connection_ack'))).toBe(true);
  await expect.poll(()=>frames.some(frame=>frame.includes('"next"')&&frame.includes('"revision":1'))).toBe(true);
  expect(paths).toEqual(['/graphql']);
  await page.goto(url+'/p/tasks-preview');
  await expect.poll(()=>frames.some(frame=>frame.includes('"tasks":[]'))).toBe(true);
  // Commit after the real tile has subscribed; it must draw the change without
  // navigation, a second read or a legacy feed waking it.
  const created=await context.request.post(url+'/api/tasks/command',{headers:{origin:url},data:{id:'first-run-create',input:{action:'create',input:{title:'First-run live pump',goal:'Water flows',why:'Test the actual live selection',owner:{kind:'household'}}}}});
  expect(created.status()).toBe(200);const made=await created.json();expect(made.ok).toBe(true);const task=made.value;
  await expect.poll(()=>page.getByText('First-run live pump',{exact:true}).count()).toBeGreaterThan(0);
  const before=frames.length;
  const edited=await context.request.post(url+'/api/tasks/command',{headers:{origin:url},data:{id:'first-run-edit',input:{action:'edit',id:task.id,input:{title:'Pump changed live'}}}});expect(edited.status()).toBe(200);
  await expect.poll(()=>page.getByText('Pump changed live',{exact:true}).count()).toBeGreaterThan(0);
  expect(frames.slice(before).some(frame=>frame.includes('Pump changed live'))).toBe(true);
  expect(paths.every(path=>path==='/graphql')).toBe(true);
  expect(paths.length).toBe(2); // one connection in each loaded document
  expect(errors).toEqual([]);
  console.info('First-run browser evidence: cookie-only GraphQL upgrade; ack, initial rows and changed task frames received; no /live', {connections:paths.length,frames:frames.length});
  expect((await context.request.post(url+'/logout')).status()).toBe(200);
  await expect.poll(()=>page.getByText('Pump changed live',{exact:true}).count()).toBe(0);
  expect((await context.request.post(url+'/graphql',{data:{query:'{ tasks { id } }'}})).status()).toBe(401);
 } finally {
  await browser?.close();process.emit('SIGTERM');await running;rmSync(home,{recursive:true,force:true});
 }
});
