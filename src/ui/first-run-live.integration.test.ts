/** Execute the CLI startup and printed first-run link, rather than seeding a
 * credential or hosting a second test-only app. CI owns the real browser. */
import { it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { chromium } from 'playwright-core';
import { eq } from 'drizzle-orm';
import * as startup from '../shared-start.js';
import { run } from '../cli/serve.js';
import { FakeClock } from '../core/clock.js';
import { tasks, sessions, members } from '../core/data/schema.js';
const root=resolve(import.meta.dirname,'../../dist/web');
const chrome=[process.env.LOOM_TEST_CHROME,'/usr/bin/google-chrome','/usr/bin/chromium',chromium.executablePath()].find(path=>path&&existsSync(path));
it.runIf(process.env.CI==='true'&&chrome&&existsSync(join(root,'next.html')))('first-run CLI sign-in opens one GraphQL socket, receives task deltas and loses access when the browser ends',async()=>{
 const home=mkdtempSync(join(tmpdir(),'loom-first-browser-')),clock=new FakeClock();
 const actual=startup.startSharedLoom;let app!:Awaited<ReturnType<typeof actual>>;
 const start=vi.spyOn(startup,'startSharedLoom').mockImplementation(async options=>app=await actual({...options,port:0,clock}));
 let printed='',ready!:(url:string)=>void;const listening=new Promise<string>(ok=>{ready=ok;});
 const running=run(['--next','--staging','--home',home],{stdin:Readable.from([]),stdinIsTTY:false,env:{},stdout:text=>{printed+=text;},stderr:text=>{const url=/next app on (http:\/\/\S+)/.exec(text)?.[1];if(url)ready(url);}});
 let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
 try {
  const url=await listening;
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
  await expect.poll(()=>frames.filter(frame=>frame.includes('"next"')).length).toBeGreaterThan(1);
  // Commit after the real tile has subscribed; it must draw the change without
  // navigation, a second read or a legacy feed waking it.
  const owner=app.db.select().from(members).get()!.id,at=new Date(clock.now()).toISOString();
  app.writes.run(()=>app.db.insert(tasks).values({id:'t-browser',title:'First-run live pump',ownerKind:'household',createdByKind:'member',createdBy:owner,createdAt:at,changedAt:at}).run());
  await expect.poll(()=>page.getByText('First-run live pump',{exact:true}).count()).toBeGreaterThan(0);
  const before=frames.length;
  app.writes.run(()=>app.db.update(tasks).set({title:'Pump changed live'}).where(eq(tasks.id,'t-browser')).run());
  await expect.poll(()=>page.getByText('Pump changed live',{exact:true}).count()).toBeGreaterThan(0);
  expect(frames.slice(before).some(frame=>frame.includes('Pump changed live'))).toBe(true);
  expect(paths.every(path=>path==='/graphql')).toBe(true);
  expect(paths.length).toBe(2); // one connection in each loaded document
  expect(errors).toEqual([]);
  console.info('First-run browser evidence: cookie-only GraphQL upgrade; ack, initial rows and changed task frames received; no /live', {connections:paths.length,frames:frames.length});
  app.writes.run(()=>app.db.delete(sessions).run());
  await expect.poll(()=>page.getByText('Pump changed live',{exact:true}).count()).toBe(0);
  expect((await context.request.post(url+'/graphql',{data:{query:'{ tasks { id } }'}})).status()).toBe(401);
 } finally {
  await browser?.close();process.emit('SIGTERM');await running;start.mockRestore();rmSync(home,{recursive:true,force:true});
 }
});
